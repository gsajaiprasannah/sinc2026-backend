const express = require('express');
const db = require('../db');

const router = express.Router();

// Public read — the congress homepage renders the agenda from here.
//
// Each item now carries its `events`: the session-by-session programme held in
// agenda_events (times, session titles, speakers). Previously only the block
// summaries were returned, so the published itinerary said "Congress Sessions
// — Day 1" and nothing about what was actually happening in it.
//
// One query for the events rather than one per item — this is the busiest
// public endpoint on the site and it is read by every visitor to the homepage.
router.get('/', async (req, res) => {
  try {
    const rows = await db.all('SELECT * FROM itinerary_items ORDER BY sort_order, id');
    const events = await db.all(`
      SELECT id, itinerary_item_id, time_label, title, description, organized_by, performed_by, duration_minutes
        FROM agenda_events
       ORDER BY itinerary_item_id, sort_order, id
    `);
    const byItem = {};
    events.forEach((e) => {
      (byItem[e.itinerary_item_id] = byItem[e.itinerary_item_id] || []).push(e);
    });
    res.json(rows.map((r) => ({ ...r, events: byItem[r.id] || [] })));
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
