// Self-service endpoints for a logged-in host member — their own profile,
// committees, assigned delegates, and checklist/milestones. Everything here
// is scoped to req.user's linked host_member_id so one host member can never
// see or edit another's data (the admin panel is where the full cross-member
// view lives).
const express = require('express');
const db = require('../db');
const { requireAuth } = require('../auth');

const router = express.Router();

async function myHostMemberId(req) {
  const row = await db.get('SELECT host_member_id FROM users WHERE id=$1', [req.user.id]);
  return row ? row.host_member_id : null;
}

function requireHostMember(req, res, next) {
  requireAuth(req, res, async () => {
    if (req.user.role !== 'host_member') {
      return res.status(403).json({ error: 'This login is not a host member account.' });
    }
    const hostMemberId = await myHostMemberId(req);
    if (!hostMemberId) {
      return res.status(404).json({ error: 'This login is not yet linked to a host member profile. Ask an admin to link it from Host Members.' });
    }
    req.hostMemberId = hostMemberId;
    next();
  });
}

router.get('/me', requireHostMember, async (req, res) => {
  try {
    const id = req.hostMemberId;
    const profile = await db.get('SELECT * FROM host_members WHERE id=$1', [id]);
    const committees = await db.all(`
      SELECT c.id, c.name FROM committee_members cm
      JOIN committees c ON c.id = cm.committee_id
      WHERE cm.host_member_id = $1
      ORDER BY c.sort_order, c.name
    `, [id]);
    const assignments = await db.all(`
      SELECT da.id, da.role, da.status, da.notes, da.updated_at,
        p.id AS participant_id, p.name AS participant_name, p.participant_code,
        p.phone AS participant_phone, p.whatsapp AS participant_whatsapp,
        p.travel_mode, p.travel_number, p.travel_datetime, p.arrival_point,
        c.name AS club_name, r.reg_number
      FROM delegate_assignments da
      JOIN participants p ON p.id = da.participant_id
      LEFT JOIN clubs c ON c.id = p.club_id
      LEFT JOIN registrations r ON r.id = p.registration_id
      WHERE da.host_member_id = $1
      ORDER BY da.status, p.name
    `, [id]);
    const tasks = await db.all(`
      SELECT * FROM host_tasks WHERE host_member_id = $1
      ORDER BY status, due_date NULLS LAST, created_at
    `, [id]);
    // Sponsors this host member is the "Guest Relation" liaison for — a
    // responsibility that lives on the sponsor record (guest_relation_host_member_id)
    // but needs to surface here too, same idea as the delegate/SPOC assignments above.
    const sponsorRelations = await db.all(`
      SELECT id, name, tier, contact_person, phone, email, sponsor_pass_code, status
      FROM sponsors WHERE guest_relation_host_member_id = $1
      ORDER BY name
    `, [id]);
    for (const sponsor of sponsorRelations) {
      sponsor.checklist = await db.all(
        `SELECT * FROM checklist_items WHERE owner_type='sponsor' AND owner_id=$1 ORDER BY sort_order, id`,
        [sponsor.id]
      );
    }
    // This host member's own goodies/kit handover checklist.
    const goodiesChecklist = await db.all(
      `SELECT * FROM checklist_items WHERE owner_type='host_member' AND owner_id=$1 ORDER BY sort_order, id`,
      [id]
    );
    res.json({ profile, committees, assignments, tasks, sponsorRelations, goodiesChecklist });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/assignments/:id', requireHostMember, async (req, res) => {
  try {
    const owned = await db.get('SELECT id FROM delegate_assignments WHERE id=$1 AND host_member_id=$2', [req.params.id, req.hostMemberId]);
    if (!owned) return res.status(404).json({ error: 'Assignment not found.' });
    const { status, notes } = req.body;
    await db.run(
      'UPDATE delegate_assignments SET status=COALESCE($1,status), notes=COALESCE($2,notes), updated_at=NOW() WHERE id=$3',
      [status || null, notes !== undefined ? notes : null, req.params.id]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.put('/tasks/:id', requireHostMember, async (req, res) => {
  try {
    const owned = await db.get('SELECT id FROM host_tasks WHERE id=$1 AND host_member_id=$2', [req.params.id, req.hostMemberId]);
    if (!owned) return res.status(404).json({ error: 'Task not found.' });
    const { status } = req.body;
    await db.run('UPDATE host_tasks SET status=COALESCE($1,status), updated_at=NOW() WHERE id=$2', [status || null, req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Update the status of a checklist item this host member is allowed to
// touch: either their own goodies/kit checklist, or the benefit checklist of
// a sponsor they're the Guest Relation contact for.
router.put('/checklist/:id', requireHostMember, async (req, res) => {
  try {
    const item = await db.get('SELECT * FROM checklist_items WHERE id=$1', [req.params.id]);
    if (!item) return res.status(404).json({ error: 'Checklist item not found.' });
    let allowed = false;
    if (item.owner_type === 'host_member' && String(item.owner_id) === String(req.hostMemberId)) allowed = true;
    if (item.owner_type === 'sponsor') {
      const sponsor = await db.get('SELECT id FROM sponsors WHERE id=$1 AND guest_relation_host_member_id=$2', [item.owner_id, req.hostMemberId]);
      if (sponsor) allowed = true;
    }
    if (!allowed) return res.status(403).json({ error: 'You are not able to update this checklist item.' });
    const { status, notes } = req.body;
    await db.run(
      'UPDATE checklist_items SET status=COALESCE($1,status), notes=COALESCE($2,notes), updated_at=NOW() WHERE id=$3',
      [status || null, notes !== undefined ? notes : null, req.params.id]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

module.exports = router;
