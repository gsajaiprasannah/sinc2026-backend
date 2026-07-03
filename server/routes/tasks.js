const express = require('express');
const db = require('../db');

const router = express.Router();

// Admin-side view of every host member's checklist/milestone items.
router.get('/', async (req, res) => {
  try {
    const rows = await db.all(`
      SELECT t.*, hm.name AS host_member_name, hm.company AS host_member_company
      FROM host_tasks t
      JOIN host_members hm ON hm.id = t.host_member_id
      ORDER BY t.due_date NULLS LAST, t.created_at DESC
    `);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/', async (req, res) => {
  const { host_member_id, title, description, is_milestone, status, due_date } = req.body;
  if (!host_member_id || !title) return res.status(400).json({ error: 'host_member_id and title are required' });
  try {
    const result = await db.run(`
      INSERT INTO host_tasks (host_member_id, title, description, is_milestone, status, due_date)
      VALUES ($1,$2,$3,$4,$5,$6) RETURNING id
    `, [host_member_id, title, description || '', is_milestone ? 1 : 0, status || 'pending', due_date || null]);
    res.json({ id: result.id });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.put('/:id', async (req, res) => {
  const { title, description, is_milestone, status, due_date } = req.body;
  try {
    await db.run(`
      UPDATE host_tasks SET
        title=COALESCE($1,title), description=COALESCE($2,description),
        is_milestone=COALESCE($3,is_milestone), status=COALESCE($4,status),
        due_date=COALESCE($5,due_date), updated_at=NOW()
      WHERE id=$6
    `, [title || null, description !== undefined ? description : null,
        is_milestone !== undefined ? (is_milestone ? 1 : 0) : null,
        status || null, due_date || null, req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.delete('/:id', async (req, res) => {
  await db.run('DELETE FROM host_tasks WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

module.exports = router;
