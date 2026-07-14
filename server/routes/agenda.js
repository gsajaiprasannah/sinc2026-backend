const express = require('express');
const db = require('../db');
const { logActivity } = require('../lib/activityLogger');

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const conditions = [];
    const params = [];
    if (req.query.itinerary_item_id) {
      params.push(req.query.itinerary_item_id);
      conditions.push(`ae.itinerary_item_id = $${params.length}`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = await db.all(`
      SELECT ae.*, c.name AS organizing_committee_name, pg.name AS performer_group_name
      FROM agenda_events ae
      LEFT JOIN committees c ON c.id = ae.organizing_committee_id
      LEFT JOIN performer_groups pg ON pg.id = ae.performer_group_id
      ${where}
      ORDER BY ae.sort_order, ae.id
    `, params);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Minimal Committee lookup for the "Organizing committee" dropdown — a
// committee only granted the Itinerary module (not the separate internal
// Committees admin data) still needs real committee names to record who's
// organizing an agenda event, instead of a raw numeric id. This router has
// no public mount anywhere (only /api/agenda, admin-only, and
// /api/portal-modules/agenda, itinerary-module-gated — see server/index.js),
// so this is never reachable without a valid login. Registered before /:id
// so this literal path is never swallowed as an id.
router.get('/committees-lite', async (req, res) => {
  try {
    const rows = await db.all(`SELECT id, name FROM committees ORDER BY name`);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const row = await db.get('SELECT * FROM agenda_events WHERE id=$1', [req.params.id]);
    if (!row) return res.status(404).json({ error: 'Agenda event not found' });
    res.json(row);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/', async (req, res) => {
  const {
    itinerary_item_id, time_label, title, description,
    organizing_committee_id, organized_by, performer_group_id, performed_by,
    duration_minutes, sort_order, notes
  } = req.body;
  if (!itinerary_item_id) return res.status(400).json({ error: 'itinerary_item_id is required' });
  if (!title || !title.trim()) return res.status(400).json({ error: 'title is required' });
  try {
    const result = await db.run(`
      INSERT INTO agenda_events (
        itinerary_item_id, time_label, title, description,
        organizing_committee_id, organized_by, performer_group_id, performed_by,
        duration_minutes, sort_order, notes
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id
    `, [itinerary_item_id, time_label || '', title.trim(), description || '',
        organizing_committee_id || null, organized_by || '', performer_group_id || null, performed_by || '',
        duration_minutes !== undefined && duration_minutes !== '' ? Number(duration_minutes) : null,
        Number(sort_order) || 0, notes || '']);
    logActivity(req.user, { action: 'create', entityType: 'agenda_event', entityId: result.id, label: title.trim() });
    res.json({ id: result.id });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.put('/:id', async (req, res) => {
  const {
    itinerary_item_id, time_label, title, description,
    organizing_committee_id, organized_by, performer_group_id, performed_by,
    duration_minutes, sort_order, notes
  } = req.body;
  try {
    await db.run(`
      UPDATE agenda_events SET
        itinerary_item_id=COALESCE($1,itinerary_item_id), time_label=COALESCE($2,time_label),
        title=COALESCE($3,title), description=COALESCE($4,description),
        organizing_committee_id=$5, organized_by=COALESCE($6,organized_by),
        performer_group_id=$7, performed_by=COALESCE($8,performed_by),
        duration_minutes=$9, sort_order=COALESCE($10,sort_order), notes=COALESCE($11,notes),
        updated_at=NOW()
      WHERE id=$12
    `, [itinerary_item_id || null, time_label !== undefined ? time_label : null,
        title || null, description !== undefined ? description : null,
        organizing_committee_id || null, organized_by !== undefined ? organized_by : null,
        performer_group_id || null, performed_by !== undefined ? performed_by : null,
        duration_minutes !== undefined && duration_minutes !== '' ? Number(duration_minutes) : null,
        sort_order !== undefined ? Number(sort_order) : null, notes !== undefined ? notes : null,
        req.params.id]);
    logActivity(req.user, { action: 'update', entityType: 'agenda_event', entityId: Number(req.params.id), label: title });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.delete('/:id', async (req, res) => {
  const existing = await db.get('SELECT title FROM agenda_events WHERE id=$1', [req.params.id]);
  await db.run('DELETE FROM agenda_events WHERE id=$1', [req.params.id]);
  logActivity(req.user, { action: 'delete', entityType: 'agenda_event', entityId: Number(req.params.id), label: existing?.title });
  res.json({ ok: true });
});

module.exports = router;
