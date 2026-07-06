// Self-service endpoints for a logged-in driver — their own profile and the
// trips assigned to them (vehicle, passengers, from/to, time), plus the
// ability to mark a trip's status as they carry it out. Everything here is
// scoped to req.user's linked driver_id (same pattern as host.js's
// requireHostMember) so one driver can never see another driver's trips or
// passenger details.
const express = require('express');
const db = require('../db');
const { requireAuth } = require('../auth');

const router = express.Router();

async function myDriverId(req) {
  const row = await db.get('SELECT driver_id FROM users WHERE id=$1', [req.user.id]);
  return row ? row.driver_id : null;
}

function requireDriverRole(req, res, next) {
  requireAuth(req, res, async () => {
    if (req.user.role !== 'driver') {
      return res.status(403).json({ error: 'This login is not a driver account.' });
    }
    const driverId = await myDriverId(req);
    if (!driverId) {
      return res.status(404).json({ error: 'This login is not yet linked to a driver profile. Ask an admin to link it from Settings.' });
    }
    req.driverId = driverId;
    next();
  });
}

router.get('/me', requireDriverRole, async (req, res) => {
  try {
    const id = req.driverId;
    const profile = await db.get(`
      SELECT d.*, p.name AS partner_name, v.vehicle_code, v.vehicle_type AS vehicle_master_type,
        v.model AS vehicle_model, v.seating_capacity
      FROM drivers d
      LEFT JOIN partners p ON p.id = d.partner_id
      LEFT JOIN vehicles v ON v.id = d.vehicle_id
      WHERE d.id = $1
    `, [id]);
    const trips = await db.all(`
      SELECT t.*, v.vehicle_code, v.vehicle_type, v.model AS vehicle_model, v.seating_capacity,
        (SELECT COUNT(*) FROM transport_trip_passengers tp WHERE tp.trip_id = t.id) AS passenger_count
      FROM transport_trips t
      LEFT JOIN vehicles v ON v.id = t.vehicle_id
      WHERE t.driver_id = $1
      ORDER BY t.trip_date ASC NULLS LAST, t.depart_time, t.id
    `, [id]);
    for (const trip of trips) {
      trip.passengers = await db.all(`
        SELECT tp.id, tp.pickup_point, tp.notes,
          p.name AS participant_name, p.phone AS participant_phone, p.participant_code,
          hm.name AS host_member_name, hm.phone AS host_member_phone
        FROM transport_trip_passengers tp
        LEFT JOIN participants p ON p.id = tp.participant_id
        LEFT JOIN host_members hm ON hm.id = tp.host_member_id
        WHERE tp.trip_id = $1
        ORDER BY tp.created_at
      `, [trip.id]);
    }
    res.json({ profile, trips });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// A driver may only update the status of their own assigned trips — nothing
// else about the trip (vehicle, passengers, route, time) is editable here;
// that stays admin-only via /api/transport in the Operations tab.
router.put('/trips/:id', requireDriverRole, async (req, res) => {
  try {
    const owned = await db.get('SELECT id FROM transport_trips WHERE id=$1 AND driver_id=$2', [req.params.id, req.driverId]);
    if (!owned) return res.status(404).json({ error: 'Trip not found.' });
    const { status } = req.body;
    if (!['planned', 'in_progress', 'completed', 'cancelled'].includes(status)) {
      return res.status(400).json({ error: 'status must be planned, in_progress, completed, or cancelled' });
    }
    await db.run('UPDATE transport_trips SET status=$1, updated_at=NOW() WHERE id=$2', [status, req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

module.exports = router;
