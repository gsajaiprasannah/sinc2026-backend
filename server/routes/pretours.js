const express = require('express');
const db = require('../db');
const { logActivity } = require('../lib/activityLogger');

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const rows = await db.all(`
      SELECT pt.*,
        (SELECT COUNT(*) FROM pre_tour_participants pp WHERE pp.pre_tour_id = pt.id) AS participant_count,
        (SELECT COUNT(*) FROM transport_trips t WHERE t.pre_tour_id = pt.id) AS trip_count
      FROM pre_tours pt
      ORDER BY pt.start_date NULLS LAST, pt.id
    `);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const tour = await db.get('SELECT * FROM pre_tours WHERE id=$1', [req.params.id]);
    if (!tour) return res.status(404).json({ error: 'not found' });
    res.json(tour);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/', async (req, res) => {
  const { name, start_date, end_date, hotel, attractions, description, capacity, price, status, notes } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  try {
    const result = await db.run(`
      INSERT INTO pre_tours (name, start_date, end_date, hotel, attractions, description, capacity, price, status, notes)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id
    `, [name, start_date || null, end_date || null, hotel || '', attractions || '', description || '',
        capacity ? Number(capacity) : null, price ? Number(price) : null, status || 'planned', notes || '']);
    logActivity(req.user, { action: 'create', entityType: 'pre_tour', entityId: result.id, label: name });
    res.json({ id: result.id });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.put('/:id', async (req, res) => {
  const { name, start_date, end_date, hotel, attractions, description, capacity, price, status, notes } = req.body;
  try {
    await db.run(`
      UPDATE pre_tours SET
        name=COALESCE($1,name), start_date=COALESCE($2,start_date), end_date=COALESCE($3,end_date),
        hotel=COALESCE($4,hotel), attractions=COALESCE($5,attractions), description=COALESCE($6,description),
        capacity=COALESCE($7,capacity), price=COALESCE($8,price), status=COALESCE($9,status), notes=COALESCE($10,notes)
      WHERE id=$11
    `, [name || null, start_date || null, end_date || null, hotel !== undefined ? hotel : null,
        attractions !== undefined ? attractions : null, description !== undefined ? description : null,
        capacity !== undefined ? Number(capacity) : null, price !== undefined ? Number(price) : null,
        status || null, notes !== undefined ? notes : null, req.params.id]);
    logActivity(req.user, { action: 'update', entityType: 'pre_tour', entityId: Number(req.params.id), label: name });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.delete('/:id', async (req, res) => {
  const existing = await db.get('SELECT name FROM pre_tours WHERE id=$1', [req.params.id]);
  await db.run('DELETE FROM pre_tours WHERE id=$1', [req.params.id]);
  logActivity(req.user, { action: 'delete', entityType: 'pre_tour', entityId: Number(req.params.id), label: existing?.name });
  res.json({ ok: true });
});

// --- Day-wise itinerary for a Pre Tour ---
router.get('/:id/itinerary', async (req, res) => {
  try {
    const rows = await db.all('SELECT * FROM pre_tour_itinerary WHERE pre_tour_id=$1 ORDER BY sort_order, id', [req.params.id]);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/:id/itinerary', async (req, res) => {
  const { day_label, time_label, title, description, location, sort_order } = req.body;
  if (!day_label || !title) return res.status(400).json({ error: 'day_label and title are required' });
  try {
    const result = await db.run(`
      INSERT INTO pre_tour_itinerary (pre_tour_id, day_label, time_label, title, description, location, sort_order)
      VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id
    `, [req.params.id, day_label, time_label || '', title, description || '', location || '', Number(sort_order) || 0]);
    res.json({ id: result.id });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.put('/itinerary/:itemId', async (req, res) => {
  const { day_label, time_label, title, description, location, sort_order } = req.body;
  try {
    await db.run(`
      UPDATE pre_tour_itinerary SET
        day_label=COALESCE($1,day_label), time_label=COALESCE($2,time_label),
        title=COALESCE($3,title), description=COALESCE($4,description),
        location=COALESCE($5,location), sort_order=COALESCE($6,sort_order)
      WHERE id=$7
    `, [day_label || null, time_label !== undefined ? time_label : null, title || null,
        description !== undefined ? description : null, location !== undefined ? location : null,
        sort_order !== undefined ? Number(sort_order) : null, req.params.itemId]);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.delete('/itinerary/:itemId', async (req, res) => {
  await db.run('DELETE FROM pre_tour_itinerary WHERE id=$1', [req.params.itemId]);
  res.json({ ok: true });
});

// --- Opted-in participants (delegates or host members) ---
router.get('/:id/participants', async (req, res) => {
  try {
    const rows = await db.all(`
      SELECT pp.*,
        p.name AS participant_name, p.phone AS participant_phone, p.participant_code,
        hm.name AS host_member_name, hm.phone AS host_member_phone
      FROM pre_tour_participants pp
      LEFT JOIN participants p ON p.id = pp.participant_id
      LEFT JOIN host_members hm ON hm.id = pp.host_member_id
      WHERE pp.pre_tour_id = $1
      ORDER BY pp.created_at
    `, [req.params.id]);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/:id/participants', async (req, res) => {
  const { participant_id, host_member_id, payment_status, notes } = req.body;
  if (!participant_id && !host_member_id) {
    return res.status(400).json({ error: 'Select a delegate or a host member to add to this tour.' });
  }
  if (participant_id && host_member_id) {
    return res.status(400).json({ error: 'A signup row is either a delegate or a host member, not both.' });
  }
  try {
    const result = await db.run(`
      INSERT INTO pre_tour_participants (pre_tour_id, participant_id, host_member_id, payment_status, notes)
      VALUES ($1,$2,$3,$4,$5) RETURNING id
    `, [req.params.id, participant_id || null, host_member_id || null, payment_status || 'pending', notes || '']);
    res.json({ id: result.id });
  } catch (e) {
    if (e.code === '23505') {
      return res.status(409).json({ error: 'This person is already signed up for this tour.' });
    }
    res.status(400).json({ error: e.message });
  }
});

router.put('/participants/:rowId', async (req, res) => {
  const { payment_status, notes } = req.body;
  try {
    await db.run(`
      UPDATE pre_tour_participants SET payment_status=COALESCE($1,payment_status), notes=COALESCE($2,notes)
      WHERE id=$3
    `, [payment_status || null, notes !== undefined ? notes : null, req.params.rowId]);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.delete('/participants/:rowId', async (req, res) => {
  await db.run('DELETE FROM pre_tour_participants WHERE id=$1', [req.params.rowId]);
  res.json({ ok: true });
});

module.exports = router;
