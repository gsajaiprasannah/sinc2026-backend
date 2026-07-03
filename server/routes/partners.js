const express = require('express');
const db = require('../db');

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const rows = await db.all('SELECT * FROM partners ORDER BY category, name');
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/', async (req, res) => {
  const { category, name, contact_person, phone, email, notes } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  try {
    const result = await db.run(`
      INSERT INTO partners (category, name, contact_person, phone, email, notes)
      VALUES ($1,$2,$3,$4,$5,$6) RETURNING id
    `, [category || 'other', name, contact_person || '', phone || '', email || '', notes || '']);
    res.json({ id: result.id });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.put('/:id', async (req, res) => {
  const { category, name, contact_person, phone, email, notes } = req.body;
  try {
    await db.run(`
      UPDATE partners SET
        category=COALESCE($1,category), name=COALESCE($2,name), contact_person=COALESCE($3,contact_person),
        phone=COALESCE($4,phone), email=COALESCE($5,email), notes=COALESCE($6,notes)
      WHERE id=$7
    `, [category || null, name || null, contact_person || null, phone || null, email || null,
        notes !== undefined ? notes : null, req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.delete('/:id', async (req, res) => {
  await db.run('DELETE FROM partners WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

module.exports = router;
