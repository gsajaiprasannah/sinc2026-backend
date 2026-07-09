const express = require('express');
const db = require('../db');
const push = require('../pushHelper');
const { MODULE_KEYS, isValidModuleKey } = require('./committeeModuleAccess');
const { attachChecklistRoutes } = require('./checklistHelper');
const { logActivity } = require('../lib/activityLogger');

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const rows = await db.all(`
      SELECT c.*,
        COALESCE(
          (SELECT json_agg(json_build_object('id', hm.id, 'name', hm.name, 'company', hm.company, 'phone', hm.phone, 'is_lead', cm.is_lead) ORDER BY cm.is_lead DESC, hm.name)
           FROM committee_members cm JOIN host_members hm ON hm.id = cm.host_member_id
           WHERE cm.committee_id = c.id),
          '[]'
        ) AS members,
        COALESCE(
          (SELECT json_agg(cma.module_key ORDER BY cma.module_key)
           FROM committee_module_access cma WHERE cma.committee_id = c.id),
          '[]'
        ) AS module_access,
        (SELECT COUNT(*) FROM committee_tasks ct WHERE ct.committee_id = c.id) AS task_count,
        (SELECT COUNT(*) FROM checklist_items ci WHERE ci.owner_type = 'committee' AND ci.owner_id = c.id) AS checklist_item_count,
        -- A task counts as "completed" here once every member's completion
        -- has been verified by the committee lead (or admin) — not merely
        -- self-marked done — so this reflects true accomplishment.
        (SELECT COUNT(*) FROM committee_tasks ct
           WHERE ct.committee_id = c.id
           AND (SELECT COUNT(*) FROM committee_task_completions tc WHERE tc.committee_task_id = ct.id) > 0
           AND NOT EXISTS (SELECT 1 FROM committee_task_completions tc WHERE tc.committee_task_id = ct.id AND tc.status <> 'verified')
        ) AS tasks_completed
      FROM committees c
      ORDER BY c.sort_order, c.name
    `);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/', async (req, res) => {
  const { name, sort_order, description } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  try {
    const dup = await db.get('SELECT id FROM committees WHERE lower(trim(name)) = lower(trim($1))', [name]);
    if (dup) return res.status(409).json({ error: `A committee named "${name}" already exists.` });
    const result = await db.run(
      'INSERT INTO committees (name, sort_order, description) VALUES ($1,$2,$3) RETURNING id',
      [name, Number(sort_order) || 0, description || '']
    );
    logActivity(req.user, { action: 'create', entityType: 'committee', entityId: result.id, label: name });
    res.json({ id: result.id });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.put('/:id', async (req, res) => {
  const { name, sort_order, description } = req.body;
  try {
    if (name !== undefined) {
      const dup = await db.get('SELECT id FROM committees WHERE lower(trim(name)) = lower(trim($1)) AND id <> $2', [name, req.params.id]);
      if (dup) return res.status(409).json({ error: `A committee named "${name}" already exists.` });
    }
    await db.run(
      'UPDATE committees SET name=COALESCE($1,name), sort_order=COALESCE($2,sort_order), description=COALESCE($3,description) WHERE id=$4',
      [name || null, sort_order !== undefined ? Number(sort_order) : null, description !== undefined ? description : null, req.params.id]
    );
    logActivity(req.user, { action: 'update', entityType: 'committee', entityId: Number(req.params.id), label: name });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.delete('/:id', async (req, res) => {
  const existing = await db.get('SELECT name FROM committees WHERE id=$1', [req.params.id]);
  await db.run('DELETE FROM committees WHERE id=$1', [req.params.id]);
  logActivity(req.user, { action: 'delete', entityType: 'committee', entityId: Number(req.params.id), label: existing?.name });
  res.json({ ok: true });
});

// Add a host member to a committee
router.post('/:id/members', async (req, res) => {
  const { host_member_id } = req.body;
  if (!host_member_id) return res.status(400).json({ error: 'host_member_id is required' });
  try {
    await db.run(
      'INSERT INTO committee_members (committee_id, host_member_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
      [req.params.id, host_member_id]
    );
    // Bring the new member up to speed on every existing checklist item /
    // milestone for this committee, so nothing they haven't seen yet gets
    // silently counted as "done" (and nothing gets missed on their end).
    await db.run(`
      INSERT INTO committee_task_completions (committee_task_id, host_member_id)
      SELECT ct.id, $2 FROM committee_tasks ct WHERE ct.committee_id = $1
      ON CONFLICT DO NOTHING
    `, [req.params.id, host_member_id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// The full catalog of module keys a committee can be granted access to
// (labels for the admin UI's checkbox list).
router.get('/module-keys', (req, res) => res.json(MODULE_KEYS));

// Appoint (or remove) a committee's lead. Enforced as a single lead per
// committee — setting one member as lead clears the flag from every other
// member of the same committee in the same transaction.
router.put('/:id/members/:hostMemberId/lead', async (req, res) => {
  const { is_lead } = req.body;
  try {
    const member = await db.get(
      'SELECT id FROM committee_members WHERE committee_id=$1 AND host_member_id=$2',
      [req.params.id, req.params.hostMemberId]
    );
    if (!member) return res.status(404).json({ error: 'This person is not a member of this committee.' });
    await db.transaction(async (tx) => {
      if (is_lead) {
        await tx.run('UPDATE committee_members SET is_lead=false WHERE committee_id=$1', [req.params.id]);
      }
      await tx.run(
        'UPDATE committee_members SET is_lead=$1 WHERE committee_id=$2 AND host_member_id=$3',
        [!!is_lead, req.params.id, req.params.hostMemberId]
      );
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Replace the full set of modules granted to a committee (admin picks from
// MODULE_KEYS via checkboxes and saves the whole list at once).
router.get('/:id/modules', async (req, res) => {
  try {
    const rows = await db.all('SELECT module_key FROM committee_module_access WHERE committee_id=$1 ORDER BY module_key', [req.params.id]);
    res.json(rows.map((r) => r.module_key));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/:id/modules', async (req, res) => {
  const keys = Array.isArray(req.body.module_keys) ? req.body.module_keys : [];
  const invalid = keys.filter((k) => !isValidModuleKey(k));
  if (invalid.length) return res.status(400).json({ error: `Unknown module key(s): ${invalid.join(', ')}` });
  try {
    await db.transaction(async (tx) => {
      await tx.run('DELETE FROM committee_module_access WHERE committee_id=$1', [req.params.id]);
      for (const key of keys) {
        await tx.run('INSERT INTO committee_module_access (committee_id, module_key) VALUES ($1,$2) ON CONFLICT DO NOTHING', [req.params.id, key]);
      }
    });
    res.json({ ok: true, module_keys: keys });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.delete('/:id/members/:hostMemberId', async (req, res) => {
  await db.run(
    'DELETE FROM committee_members WHERE committee_id=$1 AND host_member_id=$2',
    [req.params.id, req.params.hostMemberId]
  );
  // They're off the committee — drop their completion rows for this
  // committee's tasks too, so a task isn't stuck waiting on someone who's
  // no longer a member.
  await db.run(`
    DELETE FROM committee_task_completions
    WHERE host_member_id = $2
    AND committee_task_id IN (SELECT id FROM committee_tasks WHERE committee_id = $1)
  `, [req.params.id, req.params.hostMemberId]);
  res.json({ ok: true });
});

// --- Committee tasks / milestones (checklist), completed per-member ---
router.get('/:id/tasks', async (req, res) => {
  try {
    const tasks = await db.all(`
      SELECT ct.*, hm.name AS assigned_to_name,
        (SELECT COUNT(*) FROM committee_task_completions tc WHERE tc.committee_task_id = ct.id) AS total_members,
        (SELECT COUNT(*) FROM committee_task_completions tc WHERE tc.committee_task_id = ct.id AND tc.status IN ('done','verified')) AS done_count,
        (SELECT COUNT(*) FROM committee_task_completions tc WHERE tc.committee_task_id = ct.id AND tc.status = 'verified') AS verified_count,
        COALESCE(
          (SELECT json_agg(json_build_object('completion_id', tc.id, 'host_member_id', hm2.id, 'name', hm2.name, 'status', tc.status, 'verified_at', tc.verified_at) ORDER BY hm2.name)
           FROM committee_task_completions tc JOIN host_members hm2 ON hm2.id = tc.host_member_id
           WHERE tc.committee_task_id = ct.id),
          '[]'
        ) AS members
      FROM committee_tasks ct
      LEFT JOIN host_members hm ON hm.id = ct.assigned_to_host_member_id
      WHERE ct.committee_id = $1
      ORDER BY ct.is_milestone DESC, ct.due_date NULLS LAST, ct.created_at
    `, [req.params.id]);
    res.json(tasks);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/:id/tasks', async (req, res) => {
  const { title, description, is_milestone, due_date, assigned_to_host_member_id } = req.body;
  if (!title || !title.trim()) return res.status(400).json({ error: 'title is required' });
  try {
    if (assigned_to_host_member_id) {
      const onCommittee = await db.get(
        'SELECT 1 FROM committee_members WHERE committee_id=$1 AND host_member_id=$2',
        [req.params.id, assigned_to_host_member_id]
      );
      if (!onCommittee) return res.status(400).json({ error: 'That person is not a member of this committee.' });
    }
    const result = await db.transaction(async (tx) => {
      const task = await tx.run(`
        INSERT INTO committee_tasks (committee_id, title, description, is_milestone, due_date, assigned_to_host_member_id)
        VALUES ($1,$2,$3,$4,$5,$6) RETURNING id
      `, [req.params.id, title.trim(), description || '', is_milestone ? 1 : 0, due_date || null, assigned_to_host_member_id || null]);
      // Individually-assigned tasks only owe a completion from that one
      // member; everything else keeps the original broadcast-to-everyone
      // behavior (one completion row per current committee member).
      if (assigned_to_host_member_id) {
        await tx.run(`
          INSERT INTO committee_task_completions (committee_task_id, host_member_id)
          VALUES ($1,$2) ON CONFLICT DO NOTHING
        `, [task.id, assigned_to_host_member_id]);
      } else {
        await tx.run(`
          INSERT INTO committee_task_completions (committee_task_id, host_member_id)
          SELECT $1, cm.host_member_id FROM committee_members cm WHERE cm.committee_id = $2
          ON CONFLICT DO NOTHING
        `, [task.id, req.params.id]);
      }
      return task;
    });
    // Nudge whoever owes this task — just the assigned member for an
    // individually-delegated task, or every committee member for a broadcast
    // one. A no-op for anyone without their own login or without push enabled.
    const pushQuery = assigned_to_host_member_id
      ? { sql: `SELECT u.id FROM users u WHERE u.host_member_id = $1`, params: [assigned_to_host_member_id] }
      : { sql: `SELECT u.id FROM committee_members cm JOIN users u ON u.host_member_id = cm.host_member_id WHERE cm.committee_id = $1`, params: [req.params.id] };
    db.all(pushQuery.sql, pushQuery.params).then((rows) => {
      const userIds = rows.map((r) => r.id);
      if (userIds.length) {
        push.sendToUsers(userIds, {
          title: 'New checklist item assigned',
          body: `${title.trim()}${due_date ? ' — due ' + due_date : ''}`,
          url: 'login.html'
        }).catch((e) => console.error('committee task push failed', e.message));
      }
    }).catch((e) => console.error('committee task push lookup failed', e.message));
    logActivity(req.user, { action: 'create', entityType: 'committee_task', entityId: result.id, label: title.trim(), details: `committee #${req.params.id}` });
    res.json({ id: result.id });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.put('/tasks/:taskId', async (req, res) => {
  const { title, description, is_milestone, due_date } = req.body;
  try {
    await db.run(`
      UPDATE committee_tasks SET
        title=COALESCE($1,title), description=COALESCE($2,description),
        is_milestone=COALESCE($3,is_milestone), due_date=$4, updated_at=NOW()
      WHERE id=$5
    `, [title || null, description !== undefined ? description : null,
        is_milestone !== undefined ? (is_milestone ? 1 : 0) : null, due_date || null, req.params.taskId]);
    logActivity(req.user, { action: 'update', entityType: 'committee_task', entityId: Number(req.params.taskId), label: title });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.delete('/tasks/:taskId', async (req, res) => {
  const existing = await db.get('SELECT title FROM committee_tasks WHERE id=$1', [req.params.taskId]);
  await db.run('DELETE FROM committee_tasks WHERE id=$1', [req.params.taskId]);
  logActivity(req.user, { action: 'delete', entityType: 'committee_task', entityId: Number(req.params.taskId), label: existing?.title });
  res.json({ ok: true });
});

// Admin override: set any member's completion status on a task directly —
// including 'verified', so an admin can stand in for a committee lead if
// needed. verified_by_host_member_id stays NULL here (it's an admin action,
// not a lead's), same as verified_at only being set going into 'verified'.
router.put('/tasks/completions/:completionId', async (req, res) => {
  const { status } = req.body;
  if (!['pending', 'done', 'verified'].includes(status)) return res.status(400).json({ error: 'status must be pending, done, or verified' });
  try {
    await db.run(
      `UPDATE committee_task_completions SET
         status=$1,
         completed_at=CASE WHEN $1 IN ('done','verified') THEN COALESCE(completed_at, NOW()) ELSE NULL END,
         verified_at=CASE WHEN $1='verified' THEN NOW() ELSE NULL END,
         verified_by_host_member_id=CASE WHEN $1='verified' THEN verified_by_host_member_id ELSE NULL END
       WHERE id=$2`,
      [status, req.params.completionId]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// A committee's own checklist — separate from the per-member task
// delegation above (committee_tasks), this is a simple shared to-do list
// for the committee itself (e.g. "Confirm venue AV setup") using the same
// generic checklist_items table every other entity (Sponsors, Speakers,
// Host Members, ...) already uses. Gives admins GET/POST /:id/checklist;
// edit/delete-by-id and status updates go through the shared
// /api/checklist-items/:itemId endpoint like everywhere else.
attachChecklistRoutes(router, 'committee');

module.exports = router;
