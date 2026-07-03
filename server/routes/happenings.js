const express = require('express');
const db = require('../db');

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const limit = Number(req.query.limit) || 100;
    const rows = await db.all('SELECT * FROM happenings ORDER BY happened_at DESC LIMIT $1', [limit]);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/', async (req, res) => {
  const { title, description, category, posted_by } = req.body;
  if (!title) return res.status(400).json({ error: 'title is required' });
  try {
    const result = await db.run(
      'INSERT INTO happenings (title, description, category, posted_by) VALUES ($1,$2,$3,$4) RETURNING id',
      [title, description || '', category || 'general', posted_by || 'Admin']
    );
    res.json({ id: result.id });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.delete('/:id', async (req, res) => {
  await db.run('DELETE FROM happenings WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

module.exports = router;
