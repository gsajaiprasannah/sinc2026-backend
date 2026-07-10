const express = require('express');
const db = require('../db');

const router = express.Router();

// Public read — the congress dashboard renders the agenda from here.
router.get('/', async (req, res) => {
  try {
    const rows = await db.all('SELECT * FROM itinerary_items ORDER BY sort_order, id');
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Single-item lookup — needed by the admin panel's "Edit" flow (and now the
// Agenda Builder's slot picker), which fetch one record by id rather than
// filtering the full list client-side.
router.get('/:id', async (req, res) => {
  try {
    const row = await db.get('SELECT * FROM itinerary_items WHERE id=$1', [req.params.id]);
    if (!row) return res.status(404).json({ error: 'Itinerary item not found' });
    res.json(row);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/', async (req, res) => {
  const { day_label, time_label, title, description, sort_order } = req.body;
  if (!day_label || !title) return res.status(400).json({ error: 'day_label and title are required' });
  try {
    const result = await db.run(`
      INSERT INTO itinerary_items (day_label, time_label, title, description, sort_order)
      VALUES ($1,$2,$3,$4,$5) RETURNING id
    `, [day_label, time_label || '', title, description || '', Number(sort_order) || 0]);
    res.json({ id: result.id });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.put('/:id', async (req, res) => {
  const { day_label, time_label, title, description, sort_order } = req.body;
  try {
    await db.run(`
      UPDATE itinerary_items SET
        day_label=COALESCE($1,day_label), time_label=COALESCE($2,time_label),
        title=COALESCE($3,title), description=COALESCE($4,description),
        sort_order=COALESCE($5,sort_order)
      WHERE id=$6
    `, [day_label || null, time_label !== undefined ? time_label : null, title || null,
        description !== undefined ? description : null,
        sort_order !== undefined ? Number(sort_order) : null, req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.delete('/:id', async (req, res) => {
  await db.run('DELETE FROM itinerary_items WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

module.exports = router;
