const express = require('express');
const db = require('../db');
const push = require('../pushHelper');
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

// Minimal Vehicle/Driver lookups for this tour's "Transport for this tour"
// form — same reasoning as transport.js's own vehicles-lite/drivers-lite:
// a committee only granted the Pre Tours module (not the separate Vehicles
// or Transport Planning modules) still needs to pick from the real fleet
// instead of typing a raw numeric id. Registered before /:id so these
// literal paths are never swallowed as an id.
router.get('/vehicles-lite', async (req, res) => {
  try {
    const rows = await db.all(`
      SELECT id, vehicle_code, vehicle_type, model, seating_capacity
      FROM vehicles ORDER BY vehicle_code
    `);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
router.get('/drivers-lite', async (req, res) => {
  try {
    const rows = await db.all(`
      SELECT d.id, d.name, d.vehicle_id, v.vehicle_code
      FROM drivers d
      LEFT JOIN vehicles v ON v.id = d.vehicle_id
      ORDER BY d.name
    `);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Same idea for the "Delegates / host members signed up" sub-panel's
// occupant-type toggle — mirrors rooms.js's participants-lite/
// host-members-lite exactly.
router.get('/participants-lite', async (req, res) => {
  try {
    const rows = await db.all(`
      SELECT p.id, p.name, p.participant_code, c.name AS club_name
      FROM participants p LEFT JOIN clubs c ON c.id = p.club_id
      ORDER BY p.name
    `);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
router.get('/host-members-lite', async (req, res) => {
  try {
    const rows = await db.all(`SELECT id, name, company FROM host_members ORDER BY name`);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Same reasoning again, for the day-by-day Hotel Plan sub-panel's stay/meal
// hotel selects — a committee with only the Pre Tours grant still needs to
// pick from the real Hotels & Rooms register.
router.get('/hotels-lite', async (req, res) => {
  try {
    const rows = await db.all(`SELECT id, name, address FROM hotels ORDER BY name`);
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

// --- Day-by-day Hotel Plan (Full Board tours): the stay hotel and the meal
// hotel for a given day, since a group's dinner venue doesn't always match
// where they're sleeping that night. Deliberately its own table rather than
// columns on pre_tour_itinerary — a tour can have an activity agenda without
// a hotel plan yet, or vice versa, and this keeps both editable independently.
router.get('/:id/hotel-days', async (req, res) => {
  try {
    const rows = await db.all(`
      SELECT hd.*, sh.name AS stay_hotel_name, mh.name AS meal_hotel_name
      FROM pre_tour_days hd
      LEFT JOIN hotels sh ON sh.id = hd.stay_hotel_id
      LEFT JOIN hotels mh ON mh.id = hd.meal_hotel_id
      WHERE hd.pre_tour_id=$1
      ORDER BY hd.sort_order, hd.day_date NULLS LAST, hd.id
    `, [req.params.id]);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/:id/hotel-days', async (req, res) => {
  const { day_date, day_label, stay_hotel_id, meal_hotel_id, notes, sort_order } = req.body;
  if (!day_label) return res.status(400).json({ error: 'day_label is required' });
  try {
    const result = await db.run(`
      INSERT INTO pre_tour_days (pre_tour_id, day_date, day_label, stay_hotel_id, meal_hotel_id, notes, sort_order)
      VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id
    `, [req.params.id, day_date || null, day_label, stay_hotel_id || null, meal_hotel_id || null,
        notes || '', Number(sort_order) || 0]);
    res.json({ id: result.id });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.put('/hotel-days/:dayId', async (req, res) => {
  const { day_date, day_label, stay_hotel_id, meal_hotel_id, notes, sort_order } = req.body;
  try {
    await db.run(`
      UPDATE pre_tour_days SET
        day_date=COALESCE($1,day_date), day_label=COALESCE($2,day_label),
        stay_hotel_id=$3, meal_hotel_id=$4,
        notes=COALESCE($5,notes), sort_order=COALESCE($6,sort_order)
      WHERE id=$7
    `, [day_date || null, day_label || null, stay_hotel_id || null, meal_hotel_id || null,
        notes !== undefined ? notes : null, sort_order !== undefined ? Number(sort_order) : null, req.params.dayId]);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.delete('/hotel-days/:dayId', async (req, res) => {
  await db.run('DELETE FROM pre_tour_days WHERE id=$1', [req.params.dayId]);
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

// --- Tour-scoped transport (shares the transport_trips table with the ---
// --- Transport Planning module — filtered/created by pre_tour_id here so ---
// --- a committee only granted Pre Tours can plan this tour's transport ---
// --- without also needing the Transport Planning module grant). Mirrors ---
// --- admin.js's refreshTourTrips/tourTripForm, which POST to the shared ---
// --- /transport route with pre_tour_id set — this is the same insert, ---
// --- just reachable through the pretours mount instead. ---
router.get('/:id/trips', async (req, res) => {
  try {
    const rows = await db.all(`
      SELECT t.*, v.vehicle_code, v.vehicle_type, v.model AS vehicle_model, v.seating_capacity,
        d.name AS driver_name, d.phone AS driver_phone,
        (SELECT COUNT(*) FROM transport_trip_passengers tp WHERE tp.trip_id = t.id) AS passenger_count
      FROM transport_trips t
      LEFT JOIN vehicles v ON v.id = t.vehicle_id
      LEFT JOIN drivers d ON d.id = t.driver_id
      WHERE t.pre_tour_id = $1
      ORDER BY t.trip_date NULLS LAST, t.depart_time, t.id DESC
    `, [req.params.id]);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/:id/trips', async (req, res) => {
  const { trip_date, depart_time, from_location, to_location, purpose, vehicle_id, driver_id, notes } = req.body;
  if (!from_location || !to_location) return res.status(400).json({ error: 'from_location and to_location are required' });
  try {
    const result = await db.run(`
      INSERT INTO transport_trips (pre_tour_id, trip_date, depart_time, from_location, to_location, purpose, vehicle_id, driver_id, status, notes)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'planned',$9) RETURNING id
    `, [req.params.id, trip_date || null, depart_time || '', from_location, to_location,
        purpose || '', vehicle_id || null, driver_id || null, notes || '']);
    if (driver_id) {
      const u = await db.get('SELECT id FROM users WHERE driver_id=$1', [driver_id]);
      if (u) {
        push.sendToUser(u.id, {
          title: 'New trip assigned',
          body: `${from_location} → ${to_location}${trip_date ? ' on ' + trip_date : ''}${depart_time ? ' at ' + depart_time : ''}`,
          url: 'login.html'
        }).catch((e) => console.error('notifyDriverAssigned failed', e.message));
      }
    }
    logActivity(req.user, { action: 'create', entityType: 'transport_trip', entityId: result.id, label: `${from_location} → ${to_location}`, details: 'Pre Tour trip' });
    res.json({ id: result.id });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

module.exports = router;
