// Communications: one-way announcements from admin to a role, a committee,
// or hand-picked individuals — with an optional "action" (a lightweight
// to-do) attached, so a single send can both notify and assign. Deliberately
// NOT a chat: no replies, no threads. Recipients are resolved to a concrete
// user-id list at send time and stored in message_recipients, which is what
// both the sent-history view and every self-service inbox read from.
const express = require('express');
const db = require('../db');
const { requireAuth, requireAdminRole } = require('../auth');
const push = require('../pushHelper');
const { logActivity } = require('../lib/activityLogger');

const router = express.Router();

const ALL_ROLES = ['super_admin', 'admin', 'host_member', 'media', 'transporter', 'driver', 'volunteer'];

// Resolve a compose request's target into a concrete list of user ids.
async function resolveRecipientUserIds({ target_type, target_roles, target_committee_id, target_user_ids }) {
  if (target_type === 'role') {
    const roles = Array.isArray(target_roles) ? target_roles : [];
    if (!roles.length) return [];
    if (roles.includes('all')) {
      const rows = await db.all('SELECT id FROM users');
      return rows.map((r) => r.id);
    }
    const invalid = roles.filter((r) => !ALL_ROLES.includes(r));
    if (invalid.length) throw new Error(`Unknown role(s): ${invalid.join(', ')}`);
    const rows = await db.all('SELECT id FROM users WHERE role = ANY($1::text[])', [roles]);
    return rows.map((r) => r.id);
  }
  if (target_type === 'committee') {
    if (!target_committee_id) return [];
    const rows = await db.all(
      `SELECT u.id FROM users u
       JOIN committee_members cm ON cm.host_member_id = u.host_member_id
       WHERE cm.committee_id = $1`,
      [target_committee_id]
    );
    return rows.map((r) => r.id);
  }
  if (target_type === 'individual') {
    return (Array.isArray(target_user_ids) ? target_user_ids : []).map(Number).filter(Boolean);
  }
  return [];
}

// A lightweight, admin-facing directory for the "pick individuals" UI —
// every user with an approved login, plus whichever linked-profile name
// makes them recognizable (a username alone isn't enough to pick the right
// "Ravi" out of five). Deliberately separate from GET /auth/users (super_admin
// only) so any admin composing a message can use this.
router.get('/recipients-directory', requireAdminRole, async (req, res) => {
  try {
    const rows = await db.all(`
      SELECT u.id, u.username, u.role,
        COALESCE(hm.name, d.name, p.name, v.name) AS display_name
      FROM users u
      LEFT JOIN host_members hm ON hm.id = u.host_member_id
      LEFT JOIN drivers d ON d.id = u.driver_id
      LEFT JOIN partners p ON p.id = u.partner_id
      LEFT JOIN volunteers v ON v.id = u.volunteer_id
      WHERE u.status = 'approved'
      ORDER BY COALESCE(hm.name, d.name, p.name, v.name, u.username)
    `);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Compose + send. Restricted to admin/super_admin, same as the existing push
// broadcast tool (server/routes/push.js) — no committee-lead self-service
// sending in this first version.
router.post('/', requireAdminRole, async (req, res) => {
  const { title, body, target_type, target_roles, target_committee_id, target_user_ids, action_label, action_due_date } = req.body;
  if (!title || !title.trim()) return res.status(400).json({ error: 'title is required' });
  if (!['role', 'committee', 'individual'].includes(target_type)) {
    return res.status(400).json({ error: 'target_type must be role, committee, or individual' });
  }
  if (target_type === 'committee' && !target_committee_id) {
    return res.status(400).json({ error: 'target_committee_id is required for target_type=committee' });
  }
  if (target_type === 'individual' && (!Array.isArray(target_user_ids) || !target_user_ids.length)) {
    return res.status(400).json({ error: 'target_user_ids is required for target_type=individual' });
  }

  let recipientIds;
  try {
    recipientIds = await resolveRecipientUserIds({ target_type, target_roles, target_committee_id, target_user_ids });
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  // De-dupe (a committee send or an "all" role send should never double-insert
  // the same recipient) and drop the sender themselves out of their own inbox.
  recipientIds = Array.from(new Set(recipientIds)).filter((id) => id !== req.user.id);
  if (!recipientIds.length) {
    return res.status(400).json({ error: 'No recipients matched this target — nothing was sent.' });
  }

  try {
    const result = await db.transaction(async (tx) => {
      const msg = await tx.run(
        `INSERT INTO messages (sender_user_id, title, body, target_type, target_roles, target_committee_id, action_label, action_due_date)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [req.user.id, title.trim(), body || '', target_type,
          target_type === 'role' ? (Array.isArray(target_roles) ? target_roles : []) : null,
          target_type === 'committee' ? target_committee_id : null,
          action_label || null, action_due_date || null]
      );
      const messageId = msg.id;

      // Recipients who are host_members also get the action mirrored into
      // checklist_items, so it shows up in the Checklist tab they already
      // check daily — everyone else only sees it in their message inbox.
      const hostMemberIdByUser = {};
      if (action_label && action_label.trim()) {
        const linked = await tx.all(
          `SELECT id, host_member_id FROM users WHERE id = ANY($1::int[]) AND host_member_id IS NOT NULL`,
          [recipientIds]
        );
        for (const row of linked) hostMemberIdByUser[row.id] = row.host_member_id;
      }

      for (const userId of recipientIds) {
        let checklistItemId = null;
        if (action_label && action_label.trim() && hostMemberIdByUser[userId]) {
          const item = await tx.run(
            `INSERT INTO checklist_items (owner_type, owner_id, category, label, status, due_date)
             VALUES ('host_member',$1,'Message',$2,'pending',$3) RETURNING id`,
            [hostMemberIdByUser[userId], action_label.trim(), action_due_date || null]
          );
          checklistItemId = item.id;
        }
        await tx.run(
          `INSERT INTO message_recipients (message_id, user_id, mirrored_checklist_item_id)
           VALUES ($1,$2,$3) ON CONFLICT (message_id, user_id) DO NOTHING`,
          [messageId, userId, checklistItemId]
        );
      }
      return { messageId };
    });

    push.sendToUsers(recipientIds, { title: title.trim(), body: (body || '').trim(), url: 'login.html' }).catch(() => {});

    logActivity(req.user, { action: 'send', entityType: 'message', entityId: result.messageId, label: title.trim(), details: `${target_type} → ${recipientIds.length} recipient(s)` });

    res.json({ id: result.messageId, recipient_count: recipientIds.length });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Sent-history list for the admin Communications tab.
router.get('/', requireAdminRole, async (req, res) => {
  try {
    const rows = await db.all(`
      SELECT m.*, u.username AS sender_username, c.name AS target_committee_name,
        (SELECT COUNT(*) FROM message_recipients mr WHERE mr.message_id = m.id) AS recipient_count,
        (SELECT COUNT(*) FROM message_recipients mr WHERE mr.message_id = m.id AND mr.read_at IS NOT NULL) AS read_count
      FROM messages m
      LEFT JOIN users u ON u.id = m.sender_user_id
      LEFT JOIN committees c ON c.id = m.target_committee_id
      ORDER BY m.created_at DESC
    `);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Per-recipient drill-down for one sent message (who's read it / done the action).
router.get('/:id/recipients', requireAdminRole, async (req, res) => {
  try {
    const rows = await db.all(`
      SELECT mr.*, u.username, u.role,
        COALESCE(hm.name, d.name, p.name, v.name) AS display_name
      FROM message_recipients mr
      JOIN users u ON u.id = mr.user_id
      LEFT JOIN host_members hm ON hm.id = u.host_member_id
      LEFT JOIN drivers d ON d.id = u.driver_id
      LEFT JOIN partners p ON p.id = u.partner_id
      LEFT JOIN volunteers v ON v.id = u.volunteer_id
      WHERE mr.message_id = $1
      ORDER BY COALESCE(hm.name, d.name, p.name, v.name, u.username)
    `, [req.params.id]);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Self-service inbox (any logged-in role) ---
router.get('/inbox', requireAuth, async (req, res) => {
  try {
    const rows = await db.all(`
      SELECT m.id AS message_id, m.title, m.body, m.action_label, m.action_due_date, m.created_at,
        mr.read_at, mr.action_done_at, u.username AS sender_username
      FROM message_recipients mr
      JOIN messages m ON m.id = mr.message_id
      LEFT JOIN users u ON u.id = m.sender_user_id
      WHERE mr.user_id = $1
      ORDER BY m.created_at DESC
    `, [req.user.id]);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/:id/read', requireAuth, async (req, res) => {
  try {
    const result = await db.run(
      `UPDATE message_recipients SET read_at = NOW() WHERE message_id=$1 AND user_id=$2 AND read_at IS NULL`,
      [req.params.id, req.user.id]
    );
    res.json({ ok: true, updated: result.rowCount });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.put('/:id/action-done', requireAuth, async (req, res) => {
  try {
    const recipient = await db.get(`SELECT * FROM message_recipients WHERE message_id=$1 AND user_id=$2`, [req.params.id, req.user.id]);
    if (!recipient) return res.status(404).json({ error: 'Not a recipient of this message.' });
    await db.run(`UPDATE message_recipients SET action_done_at = NOW() WHERE id=$1`, [recipient.id]);
    // Keep the mirrored host_member checklist item (if any) in sync, so
    // marking it done from either the inbox or the Checklist tab agrees.
    if (recipient.mirrored_checklist_item_id) {
      await db.run(
        `UPDATE checklist_items SET status='done', completed_by_user_id=$1, completed_at=NOW() WHERE id=$2`,
        [req.user.id, recipient.mirrored_checklist_item_id]
      );
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

module.exports = router;
