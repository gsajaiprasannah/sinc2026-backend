// Self-service endpoints for a logged-in host member — their own profile,
// committees, assigned delegates, and checklist/milestones. Everything here
// is scoped to req.user's linked host_member_id so one host member can never
// see or edit another's data (the admin panel is where the full cross-member
// view lives).
const express = require('express');
const multer = require('multer');
const db = require('../db');
const { requireAuth } = require('../auth');
const push = require('../pushHelper');
const { grantedModulesForHostMember } = require('./committeeModuleAccess');
const { logActivity } = require('../lib/activityLogger');
const { finalizeApprovalIfReady } = require('../lib/financeHelper');
const { saveFile, deleteStoredFile } = require('../uploadHelper');

const router = express.Router();
const uploadImage = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

async function myHostMemberId(req) {
  const row = await db.get('SELECT host_member_id FROM users WHERE id=$1', [req.user.id]);
  return row ? row.host_member_id : null;
}

async function isCommitteeLead(hostMemberId, committeeId) {
  const row = await db.get(
    'SELECT 1 AS ok FROM committee_members WHERE committee_id=$1 AND host_member_id=$2 AND is_lead=true',
    [committeeId, hostMemberId]
  );
  return !!row;
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

// Same as requireHostMember, but additionally gates on the host_members row
// having a non-null leadership_role — i.e. this person was tagged in the
// admin panel as President/Secretary/VP/etc. Regular host members (the vast
// majority) get a 403 rather than seeing the cross-organization Leadership
// Briefing data.
function requireLeadershipHostMember(req, res, next) {
  requireHostMember(req, res, async () => {
    const row = await db.get('SELECT leadership_role FROM host_members WHERE id=$1', [req.hostMemberId]);
    if (!row || !row.leadership_role) {
      return res.status(403).json({ error: 'This section is only available to designated leadership roles.' });
    }
    req.leadershipRole = row.leadership_role;
    next();
  });
}

router.get('/me', requireHostMember, async (req, res) => {
  try {
    const id = req.hostMemberId;
    const profile = await db.get('SELECT * FROM host_members WHERE id=$1', [id]);
    const committees = await db.all(`
      SELECT c.id, c.name, cm.is_lead FROM committee_members cm
      JOIN committees c ON c.id = cm.committee_id
      WHERE cm.host_member_id = $1
      ORDER BY c.sort_order, c.name
    `, [id]);
    // Each committee's roles/responsibilities + checklist/milestones, with
    // this host member's own completion status plus the whole committee's
    // progress (a task only counts as accomplished once every member's done).
    const committeeTaskRows = await db.all(`
      SELECT c.id AS committee_id, c.name AS committee_name, c.description AS committee_description,
        ct.id AS task_id, ct.title, ct.description AS task_description, ct.is_milestone, ct.due_date,
        ct.assigned_to_host_member_id,
        tc.id AS completion_id, tc.status AS my_status, tc.verified_at,
        (SELECT COUNT(*) FROM committee_task_completions x WHERE x.committee_task_id = ct.id) AS total_members,
        (SELECT COUNT(*) FROM committee_task_completions x WHERE x.committee_task_id = ct.id AND x.status IN ('done','verified')) AS done_count
      FROM committee_members cm
      JOIN committees c ON c.id = cm.committee_id
      LEFT JOIN committee_tasks ct ON ct.committee_id = c.id
        AND (ct.assigned_to_host_member_id IS NULL OR ct.assigned_to_host_member_id = $1)
      LEFT JOIN committee_task_completions tc ON tc.committee_task_id = ct.id AND tc.host_member_id = $1
      WHERE cm.host_member_id = $1
      ORDER BY c.sort_order, c.name, ct.is_milestone DESC, ct.due_date NULLS LAST, ct.created_at
    `, [id]);
    const committeeTaskMap = new Map();
    for (const row of committeeTaskRows) {
      if (!committeeTaskMap.has(row.committee_id)) {
        committeeTaskMap.set(row.committee_id, { id: row.committee_id, name: row.committee_name, description: row.committee_description, tasks: [] });
      }
      if (row.task_id) {
        committeeTaskMap.get(row.committee_id).tasks.push({
          id: row.task_id, title: row.title, description: row.task_description, is_milestone: row.is_milestone,
          due_date: row.due_date, completion_id: row.completion_id, my_status: row.my_status,
          verified_at: row.verified_at, is_individually_assigned: !!row.assigned_to_host_member_id,
          total_members: Number(row.total_members), done_count: Number(row.done_count)
        });
      }
    }
    const committeeTasks = Array.from(committeeTaskMap.values());

    // For any committee this member LEADS: the full member roster + every
    // task with EVERY member's completion (not just their own), so the lead
    // can assign individual checklist items and verify what members have
    // marked done. Mirrors server/routes/committees.js's admin-side shape.
    const leadCommitteeIds = committees.filter((c) => c.is_lead).map((c) => c.id);
    let leadCommittees = [];
    if (leadCommitteeIds.length) {
      const rosterRows = await db.all(`
        SELECT cm.committee_id, hm.id, hm.name FROM committee_members cm
        JOIN host_members hm ON hm.id = cm.host_member_id
        WHERE cm.committee_id = ANY($1::int[])
        ORDER BY hm.name
      `, [leadCommitteeIds]);
      const taskRows = await db.all(`
        SELECT ct.*,
          COALESCE(
            (SELECT json_agg(json_build_object('completion_id', tc.id, 'host_member_id', hm.id, 'name', hm.name, 'status', tc.status, 'verified_at', tc.verified_at) ORDER BY hm.name)
             FROM committee_task_completions tc JOIN host_members hm ON hm.id = tc.host_member_id
             WHERE tc.committee_task_id = ct.id),
            '[]'
          ) AS members
        FROM committee_tasks ct
        WHERE ct.committee_id = ANY($1::int[])
        ORDER BY ct.is_milestone DESC, ct.due_date NULLS LAST, ct.created_at
      `, [leadCommitteeIds]);
      leadCommittees = leadCommitteeIds.map((cid) => {
        const info = committees.find((c) => c.id === cid);
        return {
          id: cid,
          name: info.name,
          roster: rosterRows.filter((r) => r.committee_id === cid).map((r) => ({ id: r.id, name: r.name })),
          tasks: taskRows.filter((t) => t.committee_id === cid)
        };
      });
    }

    const moduleAccess = await grantedModulesForHostMember(id);
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
    // Sponsors, Guest Speakers, and Guest Visitors this host member is the
    // "Guest Relation" liaison for — a responsibility that lives on each of
    // those records (guest_relation_host_member_id) but needs to surface
    // here too, same idea as the delegate/SPOC assignments above.
    const sponsorRelations = await db.all(`
      SELECT id, name, tier AS subtitle, contact_person, phone, email, sponsor_pass_code, status
      FROM sponsors WHERE guest_relation_host_member_id = $1 ORDER BY name
    `, [id]);
    const speakerRelations = await db.all(`
      SELECT id, name, session_type AS subtitle, phone, email, topic, status
      FROM speakers WHERE guest_relation_host_member_id = $1 ORDER BY name
    `, [id]);
    const guestVisitorRelations = await db.all(`
      SELECT id, name, category AS subtitle, phone, email, visit_date, status
      FROM guest_visitors WHERE guest_relation_host_member_id = $1 ORDER BY name
    `, [id]);
    const guestRelations = [
      ...sponsorRelations.map((r) => ({ ...r, kind: 'sponsor', kindLabel: 'Sponsor' })),
      ...speakerRelations.map((r) => ({ ...r, kind: 'speaker', kindLabel: 'Guest Speaker' })),
      ...guestVisitorRelations.map((r) => ({ ...r, kind: 'guest_visitor', kindLabel: 'Guest Visitor' })),
    ];
    for (const rel of guestRelations) {
      rel.checklist = await db.all(
        `SELECT ci.*, c.name AS responsible_committee_name FROM checklist_items ci
         LEFT JOIN committees c ON c.id = ci.responsible_committee_id
         WHERE ci.owner_type=$1 AND ci.owner_id=$2 ORDER BY ci.sort_order, ci.id`,
        [rel.kind, rel.id]
      );
    }
    // This host member's own goodies/kit handover checklist.
    const goodiesChecklist = await db.all(
      `SELECT ci.*, c.name AS responsible_committee_name FROM checklist_items ci
       LEFT JOIN committees c ON c.id = ci.responsible_committee_id
       WHERE ci.owner_type='host_member' AND ci.owner_id=$1 ORDER BY ci.sort_order, ci.id`,
      [id]
    );
    // Checklist items — across every category, for any delegate/host
    // member/sponsor/speaker/guest visitor — where one of this member's
    // committees is the delivery-accountable committee. This is what makes
    // "the Welcome & Registration Committee hands over the Welcome Kit" show
    // up to that committee's members, not just to whoever the admin assigned
    // the item's own Guest Relation liaison role to.
    const committeeIds = committees.map((c) => c.id);
    let committeeChecklists = [];
    if (committeeIds.length) {
      const rows = await db.all(`
        SELECT ci.*, COALESCE(s.name, sp.name, gv.name, p.name, hm.name, oc.name) AS owner_name, c.name AS committee_name,
          (ci.owner_type = 'committee') AS is_committee_own_item,
          (ci.status != 'done' AND ci.due_date IS NOT NULL AND ci.due_date < CURRENT_DATE) AS is_overdue
        FROM checklist_items ci
        LEFT JOIN sponsors s ON ci.owner_type='sponsor' AND ci.owner_id = s.id
        LEFT JOIN speakers sp ON ci.owner_type='speaker' AND ci.owner_id = sp.id
        LEFT JOIN guest_visitors gv ON ci.owner_type='guest_visitor' AND ci.owner_id = gv.id
        LEFT JOIN participants p ON ci.owner_type='participant' AND ci.owner_id = p.id
        LEFT JOIN host_members hm ON ci.owner_type='host_member' AND ci.owner_id = hm.id
        LEFT JOIN committees oc ON ci.owner_type='committee' AND ci.owner_id = oc.id
        LEFT JOIN committees c ON c.id = ci.responsible_committee_id
        WHERE ci.responsible_committee_id = ANY($1::int[])
        ORDER BY is_overdue DESC, ci.due_date ASC NULLS LAST, ci.id
      `, [committeeIds]);
      const map = new Map();
      for (const row of rows) {
        const cid = row.responsible_committee_id;
        if (!map.has(cid)) map.set(cid, { committee_id: cid, committee_name: row.committee_name, items: [] });
        map.get(cid).items.push(row);
      }
      committeeChecklists = Array.from(map.values());
    }
    // Goodies/inventory deliveries this member's committee(s) are
    // responsible for — same idea as committeeChecklists above but for
    // physical items, with is_assigned_to_me flagging rows they personally
    // (rather than just their committee) were assigned to hand over.
    let committeeDeliveries = [];
    if (committeeIds.length) {
      const rows = await db.all(`
        SELECT d.*, i.name AS item_name, i.category AS item_category,
          i.responsible_committee_id AS committee_id, c.name AS committee_name,
          COALESCE(s.name, sp.name, gv.name, p.name, hm.name) AS recipient_name,
          (d.assigned_host_member_id = $2) AS is_assigned_to_me
        FROM inventory_distributions d
        JOIN inventory_items i ON i.id = d.inventory_item_id
        LEFT JOIN committees c ON c.id = i.responsible_committee_id
        LEFT JOIN sponsors s ON d.recipient_type='sponsor' AND d.recipient_id = s.id
        LEFT JOIN speakers sp ON d.recipient_type='speaker' AND d.recipient_id = sp.id
        LEFT JOIN guest_visitors gv ON d.recipient_type='guest_visitor' AND d.recipient_id = gv.id
        LEFT JOIN participants p ON d.recipient_type='participant' AND d.recipient_id = p.id
        LEFT JOIN host_members hm ON d.recipient_type='host_member' AND d.recipient_id = hm.id
        WHERE i.responsible_committee_id = ANY($1::int[]) AND d.status != 'cancelled'
        ORDER BY (d.status='pending') DESC, d.id
      `, [committeeIds, id]);
      const map = new Map();
      for (const row of rows) {
        const cid = row.committee_id;
        if (!map.has(cid)) map.set(cid, { committee_id: cid, committee_name: row.committee_name, items: [] });
        map.get(cid).items.push(row);
      }
      committeeDeliveries = Array.from(map.values());
    }
    res.json({ profile, committees, committeeTasks, leadCommittees, moduleAccess, assignments, tasks, guestRelations, goodiesChecklist, committeeChecklists, committeeDeliveries });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Self-fill: Shirt Size / T-Shirt Size / Photo / Business Card. Scoped to
// req.hostMemberId (their own row only) via requireHostMember — mirrors the
// admin-side fields in server/routes/hostmembers.js one-for-one, but lets
// the host member themselves fill these in from their own portal instead of
// needing an admin to do it (or the public/my-profile.html link, for those
// who'd rather not log in at all).
router.put('/me/sizes', requireHostMember, async (req, res) => {
  const { shirt_size, tshirt_size, waist_size } = req.body;
  try {
    await db.run('UPDATE host_members SET shirt_size=$1, tshirt_size=$2, waist_size=$3 WHERE id=$4', [
      shirt_size || null, tshirt_size || null, waist_size || null, req.hostMemberId
    ]);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/me/photo', requireHostMember, (req, res, next) => {
  uploadImage.single('file')(req, res, (err) => {
    if (err) {
      const friendly = err.code === 'LIMIT_FILE_SIZE' ? 'Photo is too large (max 10MB).' : 'Upload was interrupted — please try again.';
      return res.status(400).json({ error: friendly });
    }
    next();
  });
}, async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'file is required' });
  try {
    const existing = await db.get('SELECT photo_url FROM host_members WHERE id=$1', [req.hostMemberId]);
    const storedPath = await saveFile(req.file, 'hostmember-photos');
    await db.run('UPDATE host_members SET photo_url=$1 WHERE id=$2', [storedPath, req.hostMemberId]);
    if (existing && existing.photo_url) await deleteStoredFile(existing.photo_url);
    res.json({ photo_url: storedPath });
  } catch (e) {
    console.error('Host member self-service photo upload failed —', e.message);
    res.status(500).json({ error: 'Upload failed: ' + e.message });
  }
});

router.post('/me/business-card', requireHostMember, (req, res, next) => {
  uploadImage.single('file')(req, res, (err) => {
    if (err) {
      const friendly = err.code === 'LIMIT_FILE_SIZE' ? 'Image is too large (max 10MB).' : 'Upload was interrupted — please try again.';
      return res.status(400).json({ error: friendly });
    }
    next();
  });
}, async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'file is required' });
  try {
    const existing = await db.get('SELECT business_card_url FROM host_members WHERE id=$1', [req.hostMemberId]);
    const storedPath = await saveFile(req.file, 'hostmember-business-cards');
    await db.run('UPDATE host_members SET business_card_url=$1 WHERE id=$2', [storedPath, req.hostMemberId]);
    if (existing && existing.business_card_url) await deleteStoredFile(existing.business_card_url);
    res.json({ business_card_url: storedPath });
  } catch (e) {
    console.error('Host member self-service business card upload failed —', e.message);
    res.status(500).json({ error: 'Upload failed: ' + e.message });
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
    logActivity(req.user, { action: 'update', entityType: 'delegate_assignment', entityId: Number(req.params.id), details: status });
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
    logActivity(req.user, { action: 'update', entityType: 'host_task', entityId: Number(req.params.id), details: status });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Guest-Relation-liaison-eligible owner tables, keyed by checklist_items.owner_type.
const GUEST_RELATION_TABLES = { sponsor: 'sponsors', speaker: 'speakers', guest_visitor: 'guest_visitors' };

// Update the status of a checklist item this host member is allowed to
// touch: their own goodies/kit checklist, the checklist of a sponsor/
// speaker/guest visitor they're the Guest Relation contact for, OR — new —
// any checklist item whose delivery-accountable committee they belong to
// (e.g. any Welcome Kit item routed to the Welcome & Registration Committee,
// regardless of which delegate it belongs to).
router.put('/checklist/:id', requireHostMember, async (req, res) => {
  try {
    const item = await db.get('SELECT * FROM checklist_items WHERE id=$1', [req.params.id]);
    if (!item) return res.status(404).json({ error: 'Checklist item not found.' });
    let allowed = false;
    if (item.owner_type === 'host_member' && String(item.owner_id) === String(req.hostMemberId)) allowed = true;
    const table = GUEST_RELATION_TABLES[item.owner_type];
    if (table) {
      const owner = await db.get(`SELECT id FROM ${table} WHERE id=$1 AND guest_relation_host_member_id=$2`, [item.owner_id, req.hostMemberId]);
      if (owner) allowed = true;
    }
    if (!allowed && item.responsible_committee_id) {
      const onCommittee = await db.get(
        'SELECT 1 AS ok FROM committee_members WHERE committee_id=$1 AND host_member_id=$2',
        [item.responsible_committee_id, req.hostMemberId]
      );
      if (onCommittee) allowed = true;
    }
    if (!allowed) return res.status(403).json({ error: 'You are not able to update this checklist item.' });
    const { status, notes } = req.body;
    const newStatus = status || item.status;
    // Same completion audit trail as the admin-side edit endpoint — who
    // closed it out, and when, cleared again if it's reopened.
    let completedByUserId = item.completed_by_user_id;
    let completedAt = item.completed_at;
    if (newStatus === 'done' && item.status !== 'done') {
      completedByUserId = req.user.id;
      completedAt = new Date();
    } else if (newStatus !== 'done' && item.status === 'done') {
      completedByUserId = null;
      completedAt = null;
    }
    await db.run(
      'UPDATE checklist_items SET status=$1, notes=COALESCE($2,notes), completed_by_user_id=$3, completed_at=$4, updated_at=NOW() WHERE id=$5',
      [newStatus, notes !== undefined ? notes : null, completedByUserId, completedAt, req.params.id]
    );
    logActivity(req.user, {
      action: newStatus === 'done' && item.status !== 'done' ? 'complete' : 'update',
      entityType: 'checklist_item', entityId: Number(req.params.id), label: item.label,
      details: `${item.owner_type} #${item.owner_id}`
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Mark a goodies/inventory delivery done (or reopen it) — allowed for any
// member of the item's responsible committee, same permission model as
// /checklist/:id above. delivered_by_host_member_id is ALWAYS this
// authenticated member's own id (never client-supplied), so it can't be
// spoofed as someone else having delivered it; assigned_host_member_id and
// quantity stay admin-only (via /api/inventory), not editable here.
router.put('/deliveries/:id', requireHostMember, async (req, res) => {
  try {
    const dist = await db.get(`
      SELECT d.*, i.responsible_committee_id
      FROM inventory_distributions d
      JOIN inventory_items i ON i.id = d.inventory_item_id
      WHERE d.id=$1
    `, [req.params.id]);
    if (!dist) return res.status(404).json({ error: 'Delivery record not found.' });
    if (!dist.responsible_committee_id) return res.status(403).json({ error: 'This item has no responsible committee assigned.' });
    const onCommittee = await db.get(
      'SELECT 1 AS ok FROM committee_members WHERE committee_id=$1 AND host_member_id=$2',
      [dist.responsible_committee_id, req.hostMemberId]
    );
    if (!onCommittee) return res.status(403).json({ error: 'You are not able to update this delivery.' });
    const { status, notes } = req.body;
    const newStatus = status || dist.status;
    if (!['pending', 'delivered', 'cancelled'].includes(newStatus)) {
      return res.status(400).json({ error: 'status must be pending, delivered, or cancelled' });
    }
    let deliveredBy = dist.delivered_by_host_member_id;
    let deliveredAt = dist.delivered_at;
    if (newStatus === 'delivered' && dist.status !== 'delivered') {
      deliveredBy = req.hostMemberId;
      deliveredAt = new Date();
    } else if (newStatus !== 'delivered' && dist.status === 'delivered') {
      deliveredBy = null;
      deliveredAt = null;
    }
    await db.run(
      'UPDATE inventory_distributions SET status=$1, notes=COALESCE($2,notes), delivered_by_host_member_id=$3, delivered_at=$4, updated_at=NOW() WHERE id=$5',
      [newStatus, notes !== undefined ? notes : null, deliveredBy, deliveredAt, req.params.id]
    );
    logActivity(req.user, {
      action: newStatus === 'delivered' && dist.status !== 'delivered' ? 'deliver' : 'update',
      entityType: 'inventory_distribution', entityId: Number(req.params.id)
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// A committee member marking their own completion of a checklist item /
// milestone — ownership is enforced (host_member_id must match) so nobody
// can mark another member's row done on their behalf.
router.put('/committee-tasks/:completionId', requireHostMember, async (req, res) => {
  try {
    const owned = await db.get(
      'SELECT id FROM committee_task_completions WHERE id=$1 AND host_member_id=$2',
      [req.params.completionId, req.hostMemberId]
    );
    if (!owned) return res.status(404).json({ error: 'Checklist item not found.' });
    const { status } = req.body;
    if (!['pending', 'done'].includes(status)) return res.status(400).json({ error: 'status must be pending or done' });
    await db.run(
      `UPDATE committee_task_completions SET status=$1, completed_at=CASE WHEN $1='done' THEN NOW() ELSE NULL END WHERE id=$2`,
      [status, req.params.completionId]
    );
    logActivity(req.user, { action: status === 'done' ? 'complete' : 'update', entityType: 'committee_task_completion', entityId: Number(req.params.completionId) });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// --- Committee lead actions ---
// A committee lead can delegate a checklist item/milestone to one specific
// member of their own committee (rather than broadcasting it to everyone),
// and can verify a member's self-marked "done" so it counts as truly
// accomplished. Both are 403'd for anyone who isn't the lead of that
// specific committee — leading one committee doesn't grant any authority
// over another.
router.post('/committees/:committeeId/tasks', requireHostMember, async (req, res) => {
  try {
    if (!(await isCommitteeLead(req.hostMemberId, req.params.committeeId))) {
      return res.status(403).json({ error: 'Only this committee\'s lead can assign checklist items.' });
    }
    const { title, description, is_milestone, due_date, assigned_to_host_member_id } = req.body;
    if (!title || !title.trim()) return res.status(400).json({ error: 'title is required' });
    if (assigned_to_host_member_id) {
      const onCommittee = await db.get(
        'SELECT 1 FROM committee_members WHERE committee_id=$1 AND host_member_id=$2',
        [req.params.committeeId, assigned_to_host_member_id]
      );
      if (!onCommittee) return res.status(400).json({ error: 'That person is not a member of this committee.' });
    }
    const result = await db.transaction(async (tx) => {
      const task = await tx.run(`
        INSERT INTO committee_tasks (committee_id, title, description, is_milestone, due_date, assigned_to_host_member_id)
        VALUES ($1,$2,$3,$4,$5,$6) RETURNING id
      `, [req.params.committeeId, title.trim(), description || '', is_milestone ? 1 : 0, due_date || null, assigned_to_host_member_id || null]);
      if (assigned_to_host_member_id) {
        await tx.run(
          `INSERT INTO committee_task_completions (committee_task_id, host_member_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
          [task.id, assigned_to_host_member_id]
        );
      } else {
        await tx.run(`
          INSERT INTO committee_task_completions (committee_task_id, host_member_id)
          SELECT $1, cm.host_member_id FROM committee_members cm WHERE cm.committee_id = $2
          ON CONFLICT DO NOTHING
        `, [task.id, req.params.committeeId]);
      }
      return task;
    });
    logActivity(req.user, { action: 'create', entityType: 'committee_task', entityId: result.id, label: title.trim(), details: `committee #${req.params.committeeId}` });
    const pushQuery = assigned_to_host_member_id
      ? { sql: `SELECT u.id FROM users u WHERE u.host_member_id = $1`, params: [assigned_to_host_member_id] }
      : { sql: `SELECT u.id FROM committee_members cm JOIN users u ON u.host_member_id = cm.host_member_id WHERE cm.committee_id = $1`, params: [req.params.committeeId] };
    db.all(pushQuery.sql, pushQuery.params).then((rows) => {
      const userIds = rows.map((r) => r.id);
      if (userIds.length) {
        push.sendToUsers(userIds, {
          title: 'New checklist item assigned',
          body: `${title.trim()}${due_date ? ' — due ' + due_date : ''}`,
          url: 'login.html'
        }).catch((e) => console.error('lead task push failed', e.message));
      }
    }).catch((e) => console.error('lead task push lookup failed', e.message));
    res.json({ id: result.id });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// A committee lead adding to their own committee's shared checklist — a
// simpler, single-status to-do list (e.g. "Confirm venue AV setup") that's
// separate from the per-member task delegation above. Uses the same
// generic checklist_items table every other entity (Sponsors, Speakers,
// Host Members, ...) already uses, with owner_type='committee' and
// responsible_committee_id set to the same committee, so any member can
// then toggle its status via the existing PUT /host/checklist/:id route
// (that route already allows this — see its responsible_committee_id
// membership check above) without any further changes there.
router.post('/committees/:committeeId/checklist-items', requireHostMember, async (req, res) => {
  try {
    if (!(await isCommitteeLead(req.hostMemberId, req.params.committeeId))) {
      return res.status(403).json({ error: 'Only this committee\'s lead can add checklist items.' });
    }
    const { label, due_date, category, notes } = req.body;
    if (!label || !label.trim()) return res.status(400).json({ error: 'label is required' });
    const cid = req.params.committeeId;
    const result = await db.run(`
      INSERT INTO checklist_items (owner_type, owner_id, category, label, status, notes, responsible_committee_id, due_date)
      VALUES ('committee', $1, $2, $3, 'pending', $4, $1, $5) RETURNING id
    `, [cid, category || '', label.trim(), notes || '', due_date || null]);
    logActivity(req.user, { action: 'create', entityType: 'checklist_item', entityId: result.id, label: label.trim(), details: `committee #${cid}` });
    res.json({ id: result.id });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Verify (or un-verify, to correct a mistake) a member's completion —
// lead-only, and only once the member has actually marked it 'done' first
// (a lead can't verify something nobody has submitted yet).
router.put('/committee-task-completions/:id/verify', requireHostMember, async (req, res) => {
  try {
    const completion = await db.get(`
      SELECT tc.*, ct.committee_id FROM committee_task_completions tc
      JOIN committee_tasks ct ON ct.id = tc.committee_task_id
      WHERE tc.id = $1
    `, [req.params.id]);
    if (!completion) return res.status(404).json({ error: 'Checklist item not found.' });
    if (!(await isCommitteeLead(req.hostMemberId, completion.committee_id))) {
      return res.status(403).json({ error: 'Only this committee\'s lead can verify checklist items.' });
    }
    const { status } = req.body;
    if (!['done', 'verified'].includes(status)) {
      return res.status(400).json({ error: 'status must be done (un-verify) or verified' });
    }
    if (status === 'verified' && completion.status === 'pending') {
      return res.status(400).json({ error: 'This member hasn\'t marked it done yet — ask them to complete it first.' });
    }
    await db.run(
      `UPDATE committee_task_completions SET
         status=$1,
         verified_at=CASE WHEN $1='verified' THEN NOW() ELSE NULL END,
         verified_by_host_member_id=CASE WHEN $1='verified' THEN $2::integer ELSE NULL END
       WHERE id=$3`,
      [status, req.hostMemberId, req.params.id]
    );
    logActivity(req.user, { action: status === 'verified' ? 'verify' : 'update', entityType: 'committee_task_completion', entityId: Number(req.params.id) });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// --- Leadership Briefing ---
// A one-screen "state of the congress" view for the small set of host
// members tagged with a leadership_role (President, Secretary, VPs, the
// Congress Chairman/Secretary/Joint Secretary/Treasurer/Sponsor Chairman).
// Everything here is read-only aggregation, reusing the same SQL shapes as
// the admin-only stats.js / deliveryMonitor.js / inventory.js monitor
// endpoints — those routes sit behind requireAdminRole so they can't be
// called directly from a host_member token, hence the duplication here
// rather than a shared import.
function humanizeActivity(row) {
  const who = row.username || 'Someone';
  const label = row.label ? `"${row.label}"` : '';
  const entity = (row.entity_type || '').replace(/_/g, ' ');
  const actionText = {
    create: 'added', update: 'updated', delete: 'deleted', complete: 'completed',
    deliver: 'delivered', verify: 'verified', send: 'sent', login: 'logged in',
    bulk_create: 'bulk-imported'
  }[row.action] || row.action;
  if (row.action === 'login') return `${who} logged in`;
  let sentence = `${who} ${actionText}`;
  if (entity) sentence += ` a ${entity}`;
  if (label) sentence += ` ${label}`;
  if (row.details) sentence += ` (${row.details})`;
  return sentence;
}

router.get('/leadership-briefing', requireLeadershipHostMember, async (req, res) => {
  try {
    // --- KPIs ---
    const totalDelegates = Number((await db.get('SELECT COUNT(*) AS n FROM participants')).n);
    const totalClubs = Number((await db.get('SELECT COUNT(*) AS n FROM clubs')).n);
    const paymentsCollected = Number((await db.get('SELECT COALESCE(SUM(amount_paid),0) AS n FROM registrations')).n);
    const paymentsDue = Number((await db.get('SELECT COALESCE(SUM(amount_due),0) AS n FROM registrations')).n);
    const sponsorsTotal = Number((await db.get("SELECT COUNT(*) AS n FROM sponsors WHERE status != 'cancelled'")).n);
    const sponsorsConfirmed = Number((await db.get("SELECT COUNT(*) AS n FROM sponsors WHERE status='confirmed'")).n);
    const hostTeamTotal = Number((await db.get('SELECT COUNT(*) AS n FROM host_members')).n);
    const hostTeamPaid = Number((await db.get("SELECT COUNT(*) AS n FROM host_members WHERE payment_status='paid'")).n);

    // --- Checklist completion by committee (same shape as deliveryMonitor.js /monitor/summary) ---
    const checklistByCommittee = await db.all(`
      SELECT
        c.id AS committee_id, COALESCE(c.name, 'Unassigned') AS committee_name,
        COUNT(ci.id)::int AS total,
        COUNT(*) FILTER (WHERE ci.status='done')::int AS done,
        COUNT(*) FILTER (WHERE ci.status='in_progress')::int AS in_progress,
        COUNT(*) FILTER (WHERE ci.status='pending')::int AS pending,
        COUNT(*) FILTER (WHERE ci.status != 'done' AND ci.due_date IS NOT NULL AND ci.due_date < CURRENT_DATE)::int AS overdue
      FROM checklist_items ci
      LEFT JOIN committees c ON c.id = ci.responsible_committee_id
      GROUP BY c.id, c.name
      ORDER BY c.name IS NULL, c.name
    `);
    const checklistOverall = checklistByCommittee.reduce((acc, r) => {
      acc.total += r.total; acc.done += r.done; acc.overdue += r.overdue;
      return acc;
    }, { total: 0, done: 0, overdue: 0 });

    // --- Inventory/goodies procurement -> delivery funnel ---
    // Items and their procured quantities are aggregated separately from
    // distributions — joining the two and summing quantity_procured would
    // multiply it by however many distribution rows each item has.
    const itemTotals = await db.get(`SELECT COUNT(*)::int AS items, COALESCE(SUM(quantity_procured),0)::int AS procured FROM inventory_items`);
    const distTotals = await db.get(`
      SELECT
        COUNT(*) FILTER (WHERE status='delivered')::int AS delivered,
        COUNT(*) FILTER (WHERE status='pending')::int AS pending
      FROM inventory_distributions
    `);
    const inventoryTotals = { items: itemTotals.items, procured: itemTotals.procured, delivered: distTotals.delivered, pending: distTotals.pending };
    const inventoryByCommittee = await db.all(`
      SELECT c.id AS committee_id, COALESCE(c.name, 'Unassigned') AS committee_name,
        COUNT(d.id)::int AS total,
        COUNT(*) FILTER (WHERE d.status='delivered')::int AS delivered,
        COUNT(*) FILTER (WHERE d.status='pending')::int AS pending
      FROM inventory_distributions d
      JOIN inventory_items i ON i.id = d.inventory_item_id
      LEFT JOIN committees c ON c.id = i.responsible_committee_id
      WHERE d.status != 'cancelled'
      GROUP BY c.id, c.name
      ORDER BY c.name IS NULL, c.name
    `);

    // --- Needs attention ---
    const overdueChecklist = await db.all(`
      SELECT ci.id, ci.label, ci.due_date, ci.owner_type, ci.owner_id, c.name AS committee_name,
        COALESCE(s.name, sp.name, gv.name, p.name, hm.name) AS owner_name
      FROM checklist_items ci
      LEFT JOIN committees c ON c.id = ci.responsible_committee_id
      LEFT JOIN sponsors s ON ci.owner_type='sponsor' AND ci.owner_id = s.id
      LEFT JOIN speakers sp ON ci.owner_type='speaker' AND ci.owner_id = sp.id
      LEFT JOIN guest_visitors gv ON ci.owner_type='guest_visitor' AND ci.owner_id = gv.id
      LEFT JOIN participants p ON ci.owner_type='participant' AND ci.owner_id = p.id
      LEFT JOIN host_members hm ON ci.owner_type='host_member' AND ci.owner_id = hm.id
      WHERE ci.status != 'done' AND ci.due_date IS NOT NULL AND ci.due_date < CURRENT_DATE
      ORDER BY ci.due_date ASC
      LIMIT 15
    `);
    const unconfirmedSponsors = await db.all(`
      SELECT id, name, tier, status FROM sponsors WHERE status != 'confirmed' ORDER BY name LIMIT 15
    `);
    const undeliveredInventory = await db.all(`
      SELECT d.id, i.name AS item_name, d.recipient_type,
        COALESCE(rs.name, rsp.name, rgv.name, rp.name, rhm.name) AS recipient_name,
        c.name AS committee_name, d.created_at
      FROM inventory_distributions d
      JOIN inventory_items i ON i.id = d.inventory_item_id
      LEFT JOIN committees c ON c.id = i.responsible_committee_id
      LEFT JOIN sponsors rs ON d.recipient_type='sponsor' AND d.recipient_id = rs.id
      LEFT JOIN speakers rsp ON d.recipient_type='speaker' AND d.recipient_id = rsp.id
      LEFT JOIN guest_visitors rgv ON d.recipient_type='guest_visitor' AND d.recipient_id = rgv.id
      LEFT JOIN participants rp ON d.recipient_type='participant' AND d.recipient_id = rp.id
      LEFT JOIN host_members rhm ON d.recipient_type='host_member' AND d.recipient_id = rhm.id
      WHERE d.status='pending'
      ORDER BY d.created_at ASC
      LIMIT 15
    `);

    // --- Recent activity feed, in plain language ---
    const activityRows = await db.all(`SELECT * FROM activity_log ORDER BY created_at DESC LIMIT 20`);
    const activity = activityRows.map((r) => ({
      created_at: r.created_at,
      username: r.username,
      role: r.role,
      sentence: humanizeActivity(r)
    }));

    res.json({
      role: req.leadershipRole,
      kpis: {
        totalDelegates, totalClubs,
        paymentsCollected, paymentsDue,
        paymentCollectionPct: (paymentsCollected + paymentsDue) > 0 ? Math.round((paymentsCollected / (paymentsCollected + paymentsDue)) * 100) : null,
        sponsorsTotal, sponsorsConfirmed,
        hostTeamTotal, hostTeamPaid
      },
      checklist: {
        overallPct: checklistOverall.total > 0 ? Math.round((checklistOverall.done / checklistOverall.total) * 100) : null,
        overallOverdue: checklistOverall.overdue,
        byCommittee: checklistByCommittee.map((r) => ({ ...r, completion_pct: r.total > 0 ? Math.round((r.done / r.total) * 100) : null }))
      },
      inventory: {
        ...inventoryTotals,
        byCommittee: inventoryByCommittee.map((r) => ({ ...r, completion_pct: r.total > 0 ? Math.round((r.delivered / r.total) * 100) : null }))
      },
      needsAttention: { overdueChecklist, unconfirmedSponsors, undeliveredInventory },
      activity
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Finance approvals ---
// The Finance module's outward payments/purchases require sign-off from
// specific office-bearer roles (President/Secretary/Treasurer/Congress
// Chairman/Congress Treasurer for a plain payment; just President+Treasurer
// for a goodies purchase). Whoever is CURRENTLY tagged with a given
// leadership_role can act on that role's approval slot — this endpoint
// looks up pending slots matching the logged-in host member's own role,
// not by name, so re-tagging the role to someone else just works.
router.get('/finance/approvals', requireLeadershipHostMember, async (req, res) => {
  try {
    const rows = await db.all(`
      SELECT fta.id AS approval_id, fta.required_role, fta.status AS my_status, ft.*
      FROM finance_transaction_approvals fta
      JOIN finance_transactions ft ON ft.id = fta.transaction_id
      WHERE fta.required_role = $1 AND fta.status = 'pending' AND ft.status = 'pending_approval'
      ORDER BY ft.created_at ASC
    `, [req.leadershipRole]);
    res.json({ role: req.leadershipRole, pending: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Recent decisions made by this office-bearer — a simple personal history
// so they can see what they've already acted on.
router.get('/finance/approvals/history', requireLeadershipHostMember, async (req, res) => {
  try {
    const rows = await db.all(`
      SELECT fta.id AS approval_id, fta.required_role, fta.status AS my_status, fta.decided_at, fta.remarks, ft.*
      FROM finance_transaction_approvals fta
      JOIN finance_transactions ft ON ft.id = fta.transaction_id
      WHERE fta.approved_by_host_member_id = $1 AND fta.status != 'pending'
      ORDER BY fta.decided_at DESC
      LIMIT 30
    `, [req.hostMemberId]);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/finance/approvals/:approvalId/decide', requireLeadershipHostMember, async (req, res) => {
  const { decision, remarks } = req.body;
  if (!['approved', 'rejected'].includes(decision)) {
    return res.status(400).json({ error: "decision must be 'approved' or 'rejected'" });
  }
  try {
    const approval = await db.get(`SELECT * FROM finance_transaction_approvals WHERE id=$1`, [req.params.approvalId]);
    if (!approval) return res.status(404).json({ error: 'Approval not found' });
    if (approval.required_role !== req.leadershipRole) {
      return res.status(403).json({ error: `This approval belongs to the ${approval.required_role} role, not ${req.leadershipRole}.` });
    }
    if (approval.status !== 'pending') {
      return res.status(409).json({ error: `You already ${approval.status} this one.` });
    }
    await db.run(`
      UPDATE finance_transaction_approvals SET status=$1, approved_by_host_member_id=$2, decided_at=NOW(), remarks=$3
      WHERE id=$4
    `, [decision, req.hostMemberId, remarks || null, req.params.approvalId]);
    const finalStatus = await finalizeApprovalIfReady(approval.transaction_id);
    logActivity(req.user, {
      action: decision === 'approved' ? 'approve' : 'reject',
      entityType: 'finance_transaction',
      entityId: approval.transaction_id,
      label: `${req.leadershipRole} ${decision} it`
    });
    res.json({ ok: true, transaction_status: finalStatus });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

module.exports = router;
