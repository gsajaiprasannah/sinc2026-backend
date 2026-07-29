const express = require('express');
const db = require('../db');
const push = require('../pushHelper');
const { logActivity } = require('../lib/activityLogger');

const router = express.Router();

// Notify a driver's linked login (if any) that they've got a new/updated
// trip assignment — a no-op if that driver has no user account or hasn't
// enabled push. Same helper used by the transporter self-service route.
async function notifyDriverAssigned(driverId, trip) {
  if (!driverId) return;
  const u = await db.get('SELECT id FROM users WHERE driver_id=$1', [driverId]);
  if (!u) return;
  push.sendToUser(u.id, {
    title: 'New trip assigned',
    body: `${trip.from_location} → ${trip.to_location}${trip.trip_date ? ' on ' + trip.trip_date : ''}${trip.depart_time ? ' at ' + trip.depart_time : ''}`,
    url: 'login.html'
  }).catch((e) => console.error('notifyDriverAssigned failed', e.message));
}

// Every trip is joined with vehicle/driver context and a passenger count
// (vs. the vehicle's seating capacity) so the planning table is useful
// without a second lookup. ?pre_tour_id= scopes to a single Pre Tour's
// transport plan; omitted (or =none) returns only general congress trips.
router.get('/', async (req, res) => {
  try {
    const params = [];
    let where = '';
    if (req.query.pre_tour_id === 'none') {
      where = 'WHERE t.pre_tour_id IS NULL';
    } else if (req.query.pre_tour_id) {
      params.push(req.query.pre_tour_id);
      where = 'WHERE t.pre_tour_id = $1';
    }
    const rows = await db.all(`
      SELECT t.*, v.vehicle_code, v.vehicle_type, v.model AS vehicle_model, v.seating_capacity,
        d.name AS driver_name, d.phone AS driver_phone,
        p.name AS partner_name,
        (SELECT COUNT(*) FROM transport_trip_passengers tp WHERE tp.trip_id = t.id) AS passenger_count,
        (SELECT COUNT(*) FROM transport_trip_passengers tp WHERE tp.trip_id = t.id AND tp.boarded_at IS NOT NULL) AS boarded_count
      FROM transport_trips t
      LEFT JOIN vehicles v ON v.id = t.vehicle_id
      LEFT JOIN drivers d ON d.id = t.driver_id
      LEFT JOIN partners p ON p.id = t.partner_id
      ${where}
      ORDER BY t.trip_date DESC NULLS LAST, t.depart_time, t.id DESC
    `, params);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Arrival/departure grouping ---
// Delegates who gave flight/train details but aren't on an arrival trip yet,
// clustered by matching travel_number + travel_datetime (i.e. "same flight,
// same landing time" = same pickup group) so the transport committee can
// assign one bigger vehicle to the whole cluster instead of planning each
// delegate one at a time. Each delegate's already-assigned hotel (if any) is
// included so the destination can be pre-filled. Registered before /:id so
// this literal path isn't swallowed as an id.
// Returns ONE ROW PER DELEGATE rather than pre-grouped clusters. Grouping
// used to happen here, in SQL, keyed on an exact travel_number match — which
// meant two different flights landing at the same airport ten minutes apart
// became two groups and two vehicles. The transport committee actually wants
// to pool by "same place, near enough the same time", and what counts as
// "near enough" changes with how busy the day is. That's a judgement call
// best made on screen, so the clustering moved to the client (see
// clusterTransportQueue() in js/admin.js), which can re-group instantly as
// the planner widens or narrows the time window. This endpoint's job is now
// just "who still needs an arrival trip, and what do we know about them".
router.get('/arrivals-queue', async (req, res) => {
  try {
    const rows = await db.all(`
      SELECT p.id, p.name, p.phone, p.participant_code,
        p.travel_mode, p.travel_number, p.travel_datetime,
        p.arrival_point,
        c.name AS club_name, r.reg_number,
        ra.hotel_id, h.name AS hotel_name
      FROM participants p
      LEFT JOIN clubs c ON c.id = p.club_id
      LEFT JOIN registrations r ON r.id = p.registration_id
      LEFT JOIN room_assignments ra ON ra.participant_id = p.id
      LEFT JOIN hotels h ON h.id = ra.hotel_id
      WHERE p.travel_mode IN ('flight','train')
        AND p.travel_number IS NOT NULL AND p.travel_number <> ''
        AND p.travel_datetime IS NOT NULL AND p.travel_datetime <> ''
        AND NOT EXISTS (
          SELECT 1 FROM transport_trip_passengers tp
          JOIN transport_trips t ON t.id = tp.trip_id
          WHERE tp.participant_id = p.id AND t.trip_type = 'arrival'
        )
      ORDER BY p.travel_datetime, p.travel_number, p.name
    `);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Same idea in reverse — delegates with departure details not yet on a
// departure trip. Groups on the delegate's own departure_point where set;
// falls back to arrival_point for older rows saved before that field
// existed (most people depart from the same airport/station they arrived
// through, so it's a reasonable default, but no longer the only source).
// Same idea in reverse, and likewise one row per delegate — see the arrivals
// endpoint above for why the clustering isn't done here any more. Uses the
// delegate's own departure_point where set, falling back to arrival_point for
// older rows saved before that field existed (most people leave from the same
// airport/station they arrived through, so it's a reasonable default).
router.get('/departures-queue', async (req, res) => {
  try {
    const rows = await db.all(`
      SELECT p.id, p.name, p.phone, p.participant_code,
        p.departure_mode AS travel_mode, p.departure_number AS travel_number,
        p.departure_datetime AS travel_datetime,
        COALESCE(p.departure_point, p.arrival_point) AS departure_point,
        c.name AS club_name, r.reg_number,
        ra.hotel_id, h.name AS hotel_name
      FROM participants p
      LEFT JOIN clubs c ON c.id = p.club_id
      LEFT JOIN registrations r ON r.id = p.registration_id
      LEFT JOIN room_assignments ra ON ra.participant_id = p.id
      LEFT JOIN hotels h ON h.id = ra.hotel_id
      WHERE p.departure_mode IN ('flight','train')
        AND p.departure_number IS NOT NULL AND p.departure_number <> ''
        AND p.departure_datetime IS NOT NULL AND p.departure_datetime <> ''
        AND NOT EXISTS (
          SELECT 1 FROM transport_trip_passengers tp
          JOIN transport_trips t ON t.id = tp.trip_id
          WHERE tp.participant_id = p.id AND t.trip_type = 'departure'
        )
      ORDER BY p.departure_datetime, p.departure_number, p.name
    `);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Minimal Vehicle/Driver lookups for the arrivals/departures-queue "Create
// trip for this group" form. A committee only granted the Transport Planning
// module (not the separate Vehicles or Partners & Drivers modules) still
// needs to pick from the real fleet instead of typing a raw numeric id, so
// these live under this already-transport_planning-gated mount rather than
// requiring the committee to also be granted those other two modules.
router.get('/vehicles-lite', async (req, res) => {
  try {
    // partner_id is included (not just for display) so the trip form can
    // filter this list down to only the vehicles belonging to whichever
    // Transport partner was picked first.
    const rows = await db.all(`
      SELECT id, vehicle_code, vehicle_type, model, seating_capacity, partner_id
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
      SELECT d.id, d.name, d.vehicle_id, d.partner_id, v.vehicle_code
      FROM drivers d
      LEFT JOIN vehicles v ON v.id = d.vehicle_id
      ORDER BY d.name
    `);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
// Minimal Transport Partner (vendor company) lookup for the trip form's new
// "Transport partner" field — same reasoning as vehicles-lite/drivers-lite:
// a committee only granted Transport Planning still needs real vendor names,
// not a raw numeric id.
router.get('/partners-lite', async (req, res) => {
  try {
    const rows = await db.all(`SELECT id, name, category FROM partners ORDER BY name`);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Minimal Delegate/Host Member lookups for the passenger-manifest form's
// "Passenger type" toggle — same reasoning as vehicles-lite/drivers-lite
// above: a committee only granted Transport Planning still needs real names
// to add a passenger, instead of a raw numeric id. Mirrors rooms.js's
// participants-lite/host-members-lite exactly. Registered before /:id so
// these literal paths are never swallowed as an id.
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

// Confirms a suggested group (or any hand-picked set of delegates) into a
// real trip in one shot: creates the transport_trips row AND every
// transport_trip_passengers row together, instead of the committee creating
// the trip and then adding passengers one at a time via POST /:id/passengers.
router.post('/group-trip', async (req, res) => {
  const { direction, participant_ids, trip_date, depart_time, from_location, to_location, purpose, vehicle_id, driver_id, notes } = req.body;
  if (!['arrival', 'departure'].includes(direction)) return res.status(400).json({ error: "direction must be 'arrival' or 'departure'" });
  if (!Array.isArray(participant_ids) || !participant_ids.length) return res.status(400).json({ error: 'participant_ids array is required' });
  if (!from_location || !to_location) return res.status(400).json({ error: 'from_location and to_location are required' });
  try {
    const tripId = await db.transaction(async (tx) => {
      const trip = await tx.run(`
        INSERT INTO transport_trips (trip_date, depart_time, from_location, to_location, purpose, vehicle_id, driver_id, status, notes, trip_type)
        VALUES ($1,$2,$3,$4,$5,$6,$7,'planned',$8,$9) RETURNING id
      `, [trip_date || null, depart_time || '', from_location, to_location,
          purpose || (direction === 'arrival' ? 'Airport/station pickup' : 'Airport/station drop-off'),
          vehicle_id || null, driver_id || null, notes || '', direction]);
      for (const pid of participant_ids) {
        await tx.run(`
          INSERT INTO transport_trip_passengers (trip_id, participant_id)
          VALUES ($1,$2) ON CONFLICT DO NOTHING
        `, [trip.id, pid]);
      }
      return trip.id;
    });
    if (driver_id) {
      notifyDriverAssigned(driver_id, { from_location, to_location, trip_date, depart_time });
    }
    logActivity(req.user, { action: 'create', entityType: 'transport_trip', entityId: tripId, label: `${from_location} → ${to_location}`, details: `${direction}, ${participant_ids.length} passenger(s)` });
    res.json({ id: tripId });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const trip = await db.get(`
      SELECT t.*, v.vehicle_code, v.vehicle_type, v.model AS vehicle_model, v.seating_capacity,
        d.name AS driver_name, d.phone AS driver_phone,
        p.name AS partner_name
      FROM transport_trips t
      LEFT JOIN vehicles v ON v.id = t.vehicle_id
      LEFT JOIN drivers d ON d.id = t.driver_id
      LEFT JOIN partners p ON p.id = t.partner_id
      WHERE t.id = $1
    `, [req.params.id]);
    if (!trip) return res.status(404).json({ error: 'not found' });
    const passengers = await db.all(`
      SELECT tp.*,
        p.name AS participant_name, p.phone AS participant_phone, p.participant_code,
        hm.name AS host_member_name, hm.phone AS host_member_phone,
        u.username AS boarded_by_username
      FROM transport_trip_passengers tp
      LEFT JOIN participants p ON p.id = tp.participant_id
      LEFT JOIN host_members hm ON hm.id = tp.host_member_id
      LEFT JOIN users u ON u.id = tp.boarded_by_user_id
      WHERE tp.trip_id = $1
      ORDER BY tp.created_at
    `, [req.params.id]);
    res.json({ ...trip, passengers });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/', async (req, res) => {
  const { pre_tour_id, trip_date, depart_time, from_location, to_location, purpose, vehicle_id, driver_id, partner_id, status, notes } = req.body;
  if (!from_location || !to_location) return res.status(400).json({ error: 'from_location and to_location are required' });
  try {
    const result = await db.run(`
      INSERT INTO transport_trips (pre_tour_id, trip_date, depart_time, from_location, to_location, purpose, vehicle_id, driver_id, partner_id, status, notes)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id
    `, [pre_tour_id || null, trip_date || null, depart_time || '', from_location, to_location,
        purpose || '', vehicle_id || null, driver_id || null, partner_id || null, status || 'planned', notes || '']);
    if (driver_id) {
      notifyDriverAssigned(driver_id, { from_location, to_location, trip_date, depart_time });
    }
    logActivity(req.user, { action: 'create', entityType: 'transport_trip', entityId: result.id, label: `${from_location} → ${to_location}` });
    res.json({ id: result.id });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.put('/:id', async (req, res) => {
  const { trip_date, depart_time, from_location, to_location, purpose, vehicle_id, driver_id, partner_id, status, notes } = req.body;
  try {
    const before = await db.get('SELECT driver_id FROM transport_trips WHERE id=$1', [req.params.id]);
    await db.run(`
      UPDATE transport_trips SET
        trip_date=COALESCE($1,trip_date), depart_time=COALESCE($2,depart_time),
        from_location=COALESCE($3,from_location), to_location=COALESCE($4,to_location),
        purpose=COALESCE($5,purpose), vehicle_id=COALESCE($6,vehicle_id), driver_id=COALESCE($7,driver_id),
        partner_id=COALESCE($8,partner_id),
        status=COALESCE($9,status), notes=COALESCE($10,notes), updated_at=NOW()
      WHERE id=$11
    `, [trip_date || null, depart_time !== undefined ? depart_time : null,
        from_location || null, to_location || null, purpose !== undefined ? purpose : null,
        vehicle_id || null, driver_id || null, partner_id || null, status || null,
        notes !== undefined ? notes : null, req.params.id]);
    if (driver_id && before && String(driver_id) !== String(before.driver_id)) {
      const updated = await db.get('SELECT * FROM transport_trips WHERE id=$1', [req.params.id]);
      notifyDriverAssigned(driver_id, updated);
    }
    logActivity(req.user, { action: 'update', entityType: 'transport_trip', entityId: Number(req.params.id) });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.delete('/:id', async (req, res) => {
  await db.run('DELETE FROM transport_trips WHERE id=$1', [req.params.id]);
  logActivity(req.user, { action: 'delete', entityType: 'transport_trip', entityId: Number(req.params.id) });
  res.json({ ok: true });
});

// --- Passenger manifest ---
router.post('/:id/passengers', async (req, res) => {
  const { participant_id, host_member_id, pickup_point, notes } = req.body;
  if (!participant_id && !host_member_id) {
    return res.status(400).json({ error: 'Select a delegate or a host member to add as a passenger.' });
  }
  if (participant_id && host_member_id) {
    return res.status(400).json({ error: 'A passenger row is either a delegate or a host member, not both.' });
  }
  try {
    const result = await db.run(`
      INSERT INTO transport_trip_passengers (trip_id, participant_id, host_member_id, pickup_point, notes)
      VALUES ($1,$2,$3,$4,$5) RETURNING id
    `, [req.params.id, participant_id || null, host_member_id || null, pickup_point || '', notes || '']);
    res.json({ id: result.id });
  } catch (e) {
    if (e.code === '23505') {
      return res.status(409).json({ error: 'This person is already on this trip\'s passenger list.' });
    }
    res.status(400).json({ error: e.message });
  }
});

router.delete('/:id/passengers/:passengerId', async (req, res) => {
  await db.run('DELETE FROM transport_trip_passengers WHERE id=$1 AND trip_id=$2', [req.params.passengerId, req.params.id]);
  res.json({ ok: true });
});

module.exports = router;
