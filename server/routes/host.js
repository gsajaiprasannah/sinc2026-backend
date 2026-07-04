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
    // Each committee's roles/responsibilities + checklist/milestones, with
    // this host member's own completion status plus the whole committee's
    // progress (a task only counts as accomplished once every member's done).
    const committeeTaskRows = await db.all(`
      SELECT c.id AS committee_id, c.name AS committee_name, c.description AS committee_description,
        ct.id AS task_id, ct.title, ct.description AS task_description, ct.is_milestone, ct.due_date,
        tc.id AS completion_id, tc.status AS my_status,
        (SELECT COUNT(*) FROM committee_task_completions x WHERE x.committee_task_id = ct.id) AS total_members,
        (SELECT COUNT(*) FROM committee_task_completions x WHERE x.committee_task_id = ct.id AND x.status = 'done') AS done_count
      FROM committee_members cm
      JOIN committees c ON c.id = cm.committee_id
      LEFT JOIN committee_tasks ct ON ct.committee_id = c.id
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
          total_members: Number(row.total_members), done_count: Number(row.done_count)
        });
      }
    }
    const committeeTasks = Array.from(committeeTaskMap.values());
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
        SELECT ci.*, COALESCE(s.name, sp.name, gv.name, p.name, hm.name) AS owner_name, c.name AS committee_name,
          (ci.status != 'done' AND ci.due_date IS NOT NULL AND ci.due_date < CURRENT_DATE) AS is_overdue
        FROM checklist_items ci
        LEFT JOIN sponsors s ON ci.owner_type='sponsor' AND ci.owner_id = s.id
        LEFT JOIN speakers sp ON ci.owner_type='speaker' AND ci.owner_id = sp.id
        LEFT JOIN guest_visitors gv ON ci.owner_type='guest_visitor' AND ci.owner_id = gv.id
        LEFT JOIN participants p ON ci.owner_type='participant' AND ci.owner_id = p.id
        LEFT JOIN host_members hm ON ci.owner_type='host_member' AND ci.owner_id = hm.id
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
    res.json({ profile, committees, committeeTasks, assignments, tasks, guestRelations, goodiesChecklist, committeeChecklists });
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
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

module.exports = router;
