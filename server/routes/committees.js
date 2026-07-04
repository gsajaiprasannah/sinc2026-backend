const express = require('express');
const db = require('../db');

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const rows = await db.all(`
      SELECT c.*,
        COALESCE(
          (SELECT json_agg(json_build_object('id', hm.id, 'name', hm.name, 'company', hm.company, 'phone', hm.phone) ORDER BY hm.name)
           FROM committee_members cm JOIN host_members hm ON hm.id = cm.host_member_id
           WHERE cm.committee_id = c.id),
          '[]'
        ) AS members,
        (SELECT COUNT(*) FROM committee_tasks ct WHERE ct.committee_id = c.id) AS task_count,
        (SELECT COUNT(*) FROM committee_tasks ct
           WHERE ct.committee_id = c.id
           AND (SELECT COUNT(*) FROM committee_task_completions tc WHERE tc.committee_task_id = ct.id) > 0
           AND NOT EXISTS (SELECT 1 FROM committee_task_completions tc WHERE tc.committee_task_id = ct.id AND tc.status <> 'done')
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
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.delete('/:id', async (req, res) => {
  await db.run('DELETE FROM committees WHERE id=$1', [req.params.id]);
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
      SELECT ct.*,
        (SELECT COUNT(*) FROM committee_task_completions tc WHERE tc.committee_task_id = ct.id) AS total_members,
        (SELECT COUNT(*) FROM committee_task_completions tc WHERE tc.committee_task_id = ct.id AND tc.status = 'done') AS done_count,
        COALESCE(
          (SELECT json_agg(json_build_object('completion_id', tc.id, 'host_member_id', hm.id, 'name', hm.name, 'status', tc.status) ORDER BY hm.name)
           FROM committee_task_completions tc JOIN host_members hm ON hm.id = tc.host_member_id
           WHERE tc.committee_task_id = ct.id),
          '[]'
        ) AS members
      FROM committee_tasks ct
      WHERE ct.committee_id = $1
      ORDER BY ct.is_milestone DESC, ct.due_date NULLS LAST, ct.created_at
    `, [req.params.id]);
    res.json(tasks);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/:id/tasks', async (req, res) => {
  const { title, description, is_milestone, due_date } = req.body;
  if (!title || !title.trim()) return res.status(400).json({ error: 'title is required' });
  try {
    const result = await db.transaction(async (tx) => {
      const task = await tx.run(`
        INSERT INTO committee_tasks (committee_id, title, description, is_milestone, due_date)
        VALUES ($1,$2,$3,$4,$5) RETURNING id
      `, [req.params.id, title.trim(), description || '', is_milestone ? 1 : 0, due_date || null]);
      // Every current committee member owes a completion on this new task.
      await tx.run(`
        INSERT INTO committee_task_completions (committee_task_id, host_member_id)
        SELECT $1, cm.host_member_id FROM committee_members cm WHERE cm.committee_id = $2
        ON CONFLICT DO NOTHING
      `, [task.id, req.params.id]);
      return task;
    });
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
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.delete('/tasks/:taskId', async (req, res) => {
  await db.run('DELETE FROM committee_tasks WHERE id=$1', [req.params.taskId]);
  res.json({ ok: true });
});

// Admin override: set any member's completion status on a task directly.
router.put('/tasks/completions/:completionId', async (req, res) => {
  const { status } = req.body;
  if (!['pending', 'done'].includes(status)) return res.status(400).json({ error: 'status must be pending or done' });
  try {
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
