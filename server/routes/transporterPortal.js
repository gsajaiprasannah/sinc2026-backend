// Self-service endpoints for a logged-in transporter — the coordinator at a
// transport vendor (a 'partners' record). They can see the trips that
// involve their company's vehicles or drivers, reassign a trip to one of
// their own drivers, and follow up on status — but nothing about other
// vendors, delegates, or any other part of the system. Same self-scoping
// pattern as host.js/driverPortal.js (req.user's linked partner_id).
const express = require('express');
const db = require('../db');
const { requireAuth } = require('../auth');

const router = express.Router();

async function myPartnerId(req) {
  const row = await db.get('SELECT partner_id FROM users WHERE id=$1', [req.user.id]);
  return row ? row.partner_id : null;
}

function requireTransporterRole(req, res, next) {
  requireAuth(req, res, async () => {
    if (req.user.role !== 'transporter') {
      return res.status(403).json({ error: 'This login is not a transporter account.' });
    }
    const partnerId = await myPartnerId(req);
    if (!partnerId) {
      return res.status(404).json({ error: 'This login is not yet linked to a transport partner profile. Ask an admin to link it from Settings.' });
    }
    req.partnerId = partnerId;
    next();
  });
}

// A trip is "ours" if either its vehicle or its currently assigned driver
// belongs to this partner — covers trips not yet assigned a driver (as long
// as the vehicle is theirs) as well as trips assigned straight to one of
// their drivers regardless of which vehicle master record was used.
const TRIP_SCOPE_JOIN = `
  LEFT JOIN vehicles v ON v.id = t.vehicle_id
  LEFT JOIN drivers d ON d.id = t.driver_id
`;
const TRIP_SCOPE_WHERE = `(v.partner_id = $1 OR d.partner_id = $1)`;

router.get('/me', requireTransporterRole, async (req, res) => {
  try {
    const partnerId = req.partnerId;
    const profile = await db.get('SELECT * FROM partners WHERE id=$1', [partnerId]);
    const drivers = await db.all(`
      SELECT dr.*, v.vehicle_code, v.vehicle_type AS vehicle_master_type, v.model AS vehicle_model
      FROM drivers dr
      LEFT JOIN vehicles v ON v.id = dr.vehicle_id
      WHERE dr.partner_id = $1
      ORDER BY dr.name
    `, [partnerId]);
    const trips = await db.all(`
      SELECT t.*, v.vehicle_code, v.vehicle_type, v.model AS vehicle_model, v.seating_capacity,
        d.name AS driver_name, d.phone AS driver_phone,
        (SELECT COUNT(*) FROM transport_trip_passengers tp WHERE tp.trip_id = t.id) AS passenger_count
      FROM transport_trips t
      ${TRIP_SCOPE_JOIN}
      WHERE ${TRIP_SCOPE_WHERE}
      ORDER BY t.trip_date ASC NULLS LAST, t.depart_time, t.id
    `, [partnerId]);
    res.json({ profile, drivers, trips });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Reassign a trip to one of this transporter's own drivers (or clear it back
// to unassigned with driver_id: null) — the trip must already be in scope,
// and the target driver (if any) must belong to this same partner, so a
// transporter can never hand a trip to a competitor's driver.
router.put('/trips/:id/assign-driver', requireTransporterRole, async (req, res) => {
  try {
    const trip = await db.get(`
      SELECT t.id FROM transport_trips t
      ${TRIP_SCOPE_JOIN}
      WHERE t.id = $2 AND ${TRIP_SCOPE_WHERE}
    `, [req.partnerId, req.params.id]);
    if (!trip) return res.status(404).json({ error: 'Trip not found.' });
    const { driver_id } = req.body;
    if (driver_id) {
      const ownDriver = await db.get('SELECT id FROM drivers WHERE id=$1 AND partner_id=$2', [driver_id, req.partnerId]);
      if (!ownDriver) return res.status(403).json({ error: 'That driver is not one of your own drivers.' });
    }
    await db.run('UPDATE transport_trips SET driver_id=$1, updated_at=NOW() WHERE id=$2', [driver_id || null, req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Follow-up: update a trip's status and/or add a note — scoped the same way.
router.put('/trips/:id/status', requireTransporterRole, async (req, res) => {
  try {
    const trip = await db.get(`
      SELECT t.id FROM transport_trips t
      ${TRIP_SCOPE_JOIN}
      WHERE t.id = $2 AND ${TRIP_SCOPE_WHERE}
    `, [req.partnerId, req.params.id]);
    if (!trip) return res.status(404).json({ error: 'Trip not found.' });
    const { status, notes } = req.body;
    if (status && !['planned', 'in_progress', 'completed', 'cancelled'].includes(status)) {
      return res.status(400).json({ error: 'status must be planned, in_progress, completed, or cancelled' });
    }
    await db.run(
      'UPDATE transport_trips SET status=COALESCE($1,status), notes=COALESCE($2,notes), updated_at=NOW() WHERE id=$3',
      [status || null, notes !== undefined ? notes : null, req.params.id]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

module.exports = router;
