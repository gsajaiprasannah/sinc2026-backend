// QR Badge lookup — one badge_token per Delegate/Host Member drives THREE
// different views from the exact same scanned URL (public/badge.html?token=X):
//
//   1. Anyone who scans it with no login sees a digital visiting-card
//      (name/phone/email/club-or-company) with a "Save to Contacts" button.
//      -> GET /api/badge/public/:token (this file's `publicRouter`, mounted
//         unwrapped in server/index.js — same pattern as publicProfile.js —
//         so it works before any login exists).
//
//   2. Staff already logged into ANY of the admin/self-service portals gets
//      the SAME link, but the page additionally shows a "staff" section —
//      how much of it depends on WHO is scanning (see computeCaps below):
//        - admin/super_admin sees everything (room/payment/trips + every
//          scan action, for full gate coverage).
//        - a driver/transporter with a vehicle_id assigned (Settings ->
//          Change role -> Assigned vehicle) gets the transport boarding
//          scan.
//        - a host_member/volunteer/driver/transporter deputised with a
//          scan_point (Settings -> Change role -> Scan point) gets that one
//          duty's scan action (hotel_desk / food_counter / inventory /
//          registration — a dedicated 'scanner' role login usually carries
//          this instead, see the admin panel's "Scanner Logins" section).
//        - a stall_owner login gets the "log stall visit" action, scoped to
//          their own stall_id.
//      Every OTHER role (media, vendor, or a login with none of the above)
//      gets no staff section at all, even though they have a valid login —
//      this route is intentionally requireAuth (not requireAdminRole) so
//      every one of the roles above can reach it, but each response is
//      built from that specific login's own caps, never anyone else's data.
//      -> GET /api/badge/staff/:token
//
//   3. Each scan action is its own POST, gated by requireCap(...) below, and
//      every single one — including the original gate "Mark Attendance" —
//      writes a row to attendance_log with scan_point + checked_in_by_user_id,
//      which is what makes "who scanned whom, and when" queryable via
//      GET /api/badge/scan-history (admin-only, all scanners) and
//      GET /api/badge/my-scans (any scanner, their own history only).
//
// The token itself (not the raw sequential id) is what's encoded in the QR —
// see server/db.js's badge_token migration for why: a plain id would let
// someone enumerate every attendee's contact details just by walking id up
// or down. Only per-person routes here (never a "list all tokens" endpoint).
const express = require('express');
const db = require('../db');
const { logActivity } = require('../lib/activityLogger');
const { requireAdminRole } = require('../auth');

const publicRouter = express.Router();
const staffRouter = express.Router();

// Looks up a token across both tables (a token is unique across each table
// individually, and in practice across both since they're random 20-char
// hex strings — collision odds are negligible, but we still check
// participants first then host_members rather than assuming).
async function findByToken(token) {
  if (!token) return null;
  const p = await db.get(`
    SELECT p.*, r.reg_number, r.reg_type, r.payment_status AS reg_payment_status, c.name AS club_name
    FROM participants p
    LEFT JOIN registrations r ON r.id = p.registration_id
    LEFT JOIN clubs c ON c.id = p.club_id
    WHERE p.badge_token = $1
  `, [token]);
  if (p) return { type: 'participant', row: p };
  const h = await db.get(`SELECT * FROM host_members WHERE badge_token = $1`, [token]);
  if (h) return { type: 'host_member', row: h };
  return null;
}

const ENTITY_COLUMN = { participant: 'participant_id', host_member: 'host_member_id' };

// A scanning login's own "who am I as a goodies courier" identity — a
// host_member or volunteer login is linked back to its own row via
// users.host_member_id/volunteer_id (see auth.js's LINKED_ROLE_FIELDS);
// admin/super_admin have neither, so they can still see/deliver anything
// unassigned but never "their own" custody list.
function myCustodianIdentity(user) {
  if (user.host_member_id) return { type: 'host_member', id: user.host_member_id };
  if (user.volunteer_id) return { type: 'volunteer', id: user.volunteer_id };
  return null;
}

// --- 1. Public vCard-style view — safe-to-share fields only. No payment ---
// info, no room/vehicle details, nothing that isn't already effectively on
// the physical badge itself.
publicRouter.get('/public/:token', async (req, res) => {
  try {
    const found = await findByToken(req.params.token);
    if (!found) return res.status(404).json({ error: 'Badge not found' });
    const { type, row } = found;
    res.json({
      type,
      name: row.name,
      phone: row.phone || '',
      email: row.email || '',
      photo_url: row.photo_url || null,
      org: type === 'participant' ? (row.club_name || '') : (row.company || ''),
      role_label: type === 'participant' ? 'Delegate' : (row.designation || 'Host Member')
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Every scan-point a login might be able to use, and how it's granted. ---
// admin/super_admin get every point (so any admin can cover a gap at any
// desk); everyone else only gets what's explicitly assigned to their login.
function computeCaps(user) {
  const isSuperStaff = user.role === 'admin' || user.role === 'super_admin';
  return {
    hotel_desk: isSuperStaff || user.scan_point === 'hotel_desk',
    transport: isSuperStaff || user.scan_point === 'transport' || !!user.vehicle_id,
    food_counter: isSuperStaff || user.scan_point === 'food_counter',
    stall_owner: user.role === 'stall_owner' && !!user.stall_id,
    inventory: isSuperStaff || user.scan_point === 'inventory',
    // Registration Desk duty: no dedicated scan endpoint of its own — it
    // rides the same universal "Mark Attendance" (gate) action every staff
    // view already shows once ANY cap is granted (see hasAnyCap below). This
    // cap's only job is to let a registration-only login past that gate.
    registration: isSuperStaff || user.scan_point === 'registration'
  };
}

function hasAnyCap(caps) {
  return Object.values(caps).some(Boolean);
}

// requireAuth already ran (staffRouter is mounted with it in index.js) by
// the time these run — req.user is the JWT payload ({id, username, role}),
// which doesn't carry scan_point/vehicle_id/stall_id, so every route here
// re-reads the full row fresh from the DB rather than trusting a possibly
// stale token (an admin can change someone's scan point and have it take
// effect on their very next scan, without needing to log out/in).
async function loadScanUser(req, res, next) {
  try {
    const user = await db.get('SELECT * FROM users WHERE id=$1', [req.user.id]);
    if (!user) return res.status(401).json({ error: 'Session invalid — please log in again.' });
    req.scanUser = user;
    req.caps = computeCaps(user);
    next();
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
staffRouter.use(loadScanUser);

function requireCap(capName) {
  return (req, res, next) => {
    if (!req.caps[capName]) return res.status(403).json({ error: 'Your login does not have access to this scan action.' });
    next();
  };
}

// Records one scan into the shared history table — every scan action in
// this file (including the original gate check-in) goes through this so
// "who scanned whom, at which point, and when" is always queryable from one
// place (see /scan-history and /my-scans below).
async function recordScan({ entityType, entityId, scanPoint, userId, meta }) {
  const result = await db.run(
    `INSERT INTO attendance_log (entity_type, entity_id, scan_point, checked_in_by_user_id, meta)
     VALUES ($1,$2,$3,$4,$5) RETURNING checked_in_at`,
    [entityType, entityId, scanPoint, userId || null, meta ? JSON.stringify(meta) : null]
  );
  return result.rows[0].checked_in_at;
}

// --- 2. Staff view — shape and depth of the response depend entirely on ---
// this scanner's own caps (computed above), never on the role of whoever
// last touched this record.
staffRouter.get('/staff/:token', async (req, res) => {
  try {
    const found = await findByToken(req.params.token);
    if (!found) return res.status(404).json({ error: 'Badge not found' });
    const { type, row } = found;
    const caps = req.caps;
    if (!hasAnyCap(caps)) {
      // A valid login (e.g. media/vendor, or a host_member with no scan
      // duty assigned) with nothing to do here — the frontend shows its
      // "log in as staff" prompt in this case rather than an empty card.
      return res.status(403).json({ error: 'This login has no badge-scanning duties assigned.' });
    }
    const isSuperStaff = req.scanUser.role === 'admin' || req.scanUser.role === 'super_admin';
    const col = ENTITY_COLUMN[type];

    const payload = {
      type,
      name: row.name,
      phone: row.phone || '',
      email: row.email || '',
      photo_url: row.photo_url || null,
      org: type === 'participant' ? (row.club_name || '') : (row.company || ''),
      role_label: type === 'participant' ? 'Delegate' : (row.designation || 'Host Member'),
      caps
    };

    // Registration/room/trip/payment detail is internal staff data — kept to
    // admin/super_admin only, same protection level as the rest of the admin
    // panel, even though narrower scan-point logins can now reach this route.
    if (isSuperStaff) {
      const room = await db.get(`
        SELECT ra.room_number, ra.room_type, ra.check_in, ra.check_out, h.name AS hotel_name
        FROM room_assignments ra
        JOIN hotels h ON h.id = ra.hotel_id
        WHERE ra.${col} = $1
        ORDER BY ra.id DESC LIMIT 1
      `, [row.id]);
      const trips = await db.all(`
        SELECT t.trip_type, t.trip_date, t.depart_time, t.from_location, t.to_location,
          v.vehicle_code, v.vehicle_type, v.model AS vehicle_model,
          d.name AS driver_name, d.phone AS driver_phone,
          tp.pickup_point
        FROM transport_trip_passengers tp
        JOIN transport_trips t ON t.id = tp.trip_id
        LEFT JOIN vehicles v ON v.id = t.vehicle_id
        LEFT JOIN drivers d ON d.id = t.driver_id
        WHERE tp.${col} = $1
        ORDER BY t.trip_date, t.depart_time
      `, [row.id]);
      const lastCheckin = await db.get(`
        SELECT checked_in_at FROM attendance_log
        WHERE entity_type = $1 AND entity_id = $2 AND scan_point = 'gate'
        ORDER BY checked_in_at DESC LIMIT 1
      `, [type, row.id]);
      payload.registration = type === 'participant'
        ? { reg_number: row.reg_number, reg_type: row.reg_type, payment_status: row.reg_payment_status }
        : { payment_status: row.payment_status, payment_amount: row.payment_amount };
      payload.room = room || null;
      payload.trips = trips;
      payload.last_checked_in_at = lastCheckin ? lastCheckin.checked_in_at : null;
    }

    if (caps.hotel_desk) {
      const last = await db.get(`
        SELECT scan_point, checked_in_at FROM attendance_log
        WHERE entity_type=$1 AND entity_id=$2 AND scan_point IN ('hotel_checkin','hotel_checkout')
        ORDER BY checked_in_at DESC LIMIT 1
      `, [type, row.id]);
      if (last) payload.last_hotel_scan = { scan_point: last.scan_point, checked_in_at: last.checked_in_at };
    }

    if (caps.food_counter) {
      const scans = await db.all(`
        SELECT DISTINCT meta->>'meal_slot' AS meal_slot FROM attendance_log
        WHERE entity_type=$1 AND entity_id=$2 AND scan_point='food_counter' AND created_at::date = CURRENT_DATE
      `, [type, row.id]);
      payload.todays_food_scans = scans.filter((s) => s.meal_slot);
    }

    if (caps.inventory) {
      // Only items assigned to THIS courier (or not yet assigned to anyone
      // in particular) show up as deliverable here — someone else's
      // assigned goodies don't appear, so a courier can't accidentally hand
      // out (and get credited for) stock that isn't actually in their hand.
      // See db.js's assigned_custodian_type/id migration.
      const mine = myCustodianIdentity(req.scanUser);
      const rows = await db.all(`
        SELECT ind.id AS distribution_id, ii.name, ind.quantity,
          ind.assigned_custodian_type, ind.assigned_custodian_id
        FROM inventory_distributions ind
        JOIN inventory_items ii ON ii.id = ind.inventory_item_id
        WHERE ind.recipient_type = $1 AND ind.recipient_id = $2 AND ind.status != 'delivered'
        ORDER BY ind.id
      `, [type, row.id]);
      payload.pending_goodies = rows.filter((r) =>
        isSuperStaff
        || !r.assigned_custodian_id
        || (mine && r.assigned_custodian_type === mine.type && String(r.assigned_custodian_id) === String(mine.id))
      );
    }

    res.json(payload);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- 3. Mark attendance (gate) — every scan just adds another log row ---
staffRouter.post('/staff/:token/checkin', async (req, res) => {
  try {
    const found = await findByToken(req.params.token);
    if (!found) return res.status(404).json({ error: 'Badge not found' });
    const { type, row } = found;
    const checked_in_at = await recordScan({ entityType: type, entityId: row.id, scanPoint: 'gate', userId: req.user.id });
    logActivity(req.user, { action: 'checkin', entityType: type, entityId: row.id, label: row.name });
    res.json({ checked_in_at });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Hotel desk: check-in / check-out ---
staffRouter.post('/staff/:token/hotel-checkin', requireCap('hotel_desk'), async (req, res) => {
  try {
    const found = await findByToken(req.params.token);
    if (!found) return res.status(404).json({ error: 'Badge not found' });
    const { type, row } = found;
    const checked_in_at = await recordScan({ entityType: type, entityId: row.id, scanPoint: 'hotel_checkin', userId: req.user.id });
    res.json({ checked_in_at });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
staffRouter.post('/staff/:token/hotel-checkout', requireCap('hotel_desk'), async (req, res) => {
  try {
    const found = await findByToken(req.params.token);
    if (!found) return res.status(404).json({ error: 'Badge not found' });
    const { type, row } = found;
    const checked_in_at = await recordScan({ entityType: type, entityId: row.id, scanPoint: 'hotel_checkout', userId: req.user.id });
    res.json({ checked_in_at });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Transport: today's trips, for the scanner to pick from before ---------
// scanning anyone. Deliberately not scoped to the scanning login's own
// vehicle_id (a scanner may cover more than one vehicle across the day, or
// be a generic scan_point='transport' desk with no vehicle of its own) — it
// lists every trip scheduled for today so the scanner can pick the exact
// route/vehicle/driver they're standing at right now.
staffRouter.get('/transport-trips-today', requireCap('transport'), async (req, res) => {
  try {
    const trips = await db.all(`
      SELECT t.id, t.trip_type, t.from_location, t.to_location, t.depart_time,
        v.vehicle_code, v.vehicle_type, v.seating_capacity,
        d.name AS driver_name, d.phone AS driver_phone,
        (SELECT COUNT(*) FROM transport_trip_passengers tp WHERE tp.trip_id = t.id) AS passenger_count,
        (SELECT COUNT(*) FROM transport_trip_passengers tp WHERE tp.trip_id = t.id AND tp.boarded_at IS NOT NULL) AS boarded_count
      FROM transport_trips t
      LEFT JOIN vehicles v ON v.id = t.vehicle_id
      LEFT JOIN drivers d ON d.id = t.driver_id
      WHERE t.trip_date = CURRENT_DATE
      ORDER BY t.depart_time NULLS LAST, t.id
    `);
    res.json(trips);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Transport boarding: checks this person against the SPECIFIC trip the ---
// scanner picked from the dropdown above (trip_id, in the request body) —
// not the scanning login's own vehicle_id, since the scanner may be
// covering any of several vehicles today. A match marks that passenger row
// boarded (so the Transport Planning manifest reflects it immediately); a
// mismatch looks up whichever of today's OTHER trips this person actually
// is on, so the scanner can be told the correct vehicle/driver on the spot.
staffRouter.post('/staff/:token/transport-scan', requireCap('transport'), async (req, res) => {
  try {
    const tripId = req.body.trip_id;
    if (!tripId) return res.status(400).json({ error: 'Select a trip before scanning.' });
    const found = await findByToken(req.params.token);
    if (!found) return res.status(404).json({ error: 'Badge not found' });
    const { type, row } = found;
    const col = ENTITY_COLUMN[type];

    const trip = await db.get(`
      SELECT t.id, t.from_location, t.to_location, t.depart_time,
        v.vehicle_code, d.name AS driver_name, d.phone AS driver_phone
      FROM transport_trips t
      LEFT JOIN vehicles v ON v.id = t.vehicle_id
      LEFT JOIN drivers d ON d.id = t.driver_id
      WHERE t.id = $1
    `, [tripId]);
    if (!trip) return res.status(404).json({ error: 'That trip no longer exists — refresh the trip list.' });

    const onThisTrip = await db.get(
      `SELECT id, boarded_at FROM transport_trip_passengers WHERE trip_id = $1 AND ${col} = $2`,
      [tripId, row.id]
    );

    if (onThisTrip) {
      const tripInfo = { from_location: trip.from_location, to_location: trip.to_location, depart_time: trip.depart_time, vehicle_code: trip.vehicle_code };
      if (onThisTrip.boarded_at) {
        await recordScan({ entityType: type, entityId: row.id, scanPoint: 'transport', userId: req.user.id, meta: { result: 'already_boarded', trip_id: trip.id } });
        return res.json({ match: true, alreadyBoarded: true, boarded_at: onThisTrip.boarded_at, trip: tripInfo });
      }
      const boarded_at = new Date();
      await db.run(
        `UPDATE transport_trip_passengers SET boarded_at = NOW(), boarded_by_user_id = $1 WHERE id = $2`,
        [req.user.id, onThisTrip.id]
      );
      await recordScan({ entityType: type, entityId: row.id, scanPoint: 'transport', userId: req.user.id, meta: { result: 'match', trip_id: trip.id } });
      return res.json({ match: true, alreadyBoarded: false, boarded_at, trip: tripInfo });
    }

    // Not on the selected trip — find whichever of today's OTHER trips this
    // person IS actually booked on, so the scanner can be told the correct
    // vehicle instead of just "wrong vehicle".
    const otherTrips = await db.all(`
      SELECT t.id, t.from_location, t.to_location, t.depart_time,
        v.vehicle_code, d.name AS driver_name, d.phone AS driver_phone
      FROM transport_trip_passengers tp
      JOIN transport_trips t ON t.id = tp.trip_id
      LEFT JOIN vehicles v ON v.id = t.vehicle_id
      LEFT JOIN drivers d ON d.id = t.driver_id
      WHERE tp.${col} = $1 AND t.trip_date = CURRENT_DATE
      ORDER BY t.depart_time
    `, [row.id]);

    if (!otherTrips.length) {
      await recordScan({ entityType: type, entityId: row.id, scanPoint: 'transport', userId: req.user.id, meta: { result: 'unassigned', attempted_trip_id: trip.id } });
      return res.json({ match: false, assigned: false, message: 'No transport assignment found for this person today.' });
    }
    const t = otherTrips[0];
    await recordScan({ entityType: type, entityId: row.id, scanPoint: 'transport', userId: req.user.id, meta: { result: 'mismatch', attempted_trip_id: trip.id, correct_trip_id: t.id } });
    res.json({
      match: false, assigned: true,
      correctTrip: { vehicle_code: t.vehicle_code, driver_name: t.driver_name, driver_phone: t.driver_phone, from_location: t.from_location, to_location: t.to_location, depart_time: t.depart_time }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Food counter: count-once-per-meal-slot-per-day ---
staffRouter.post('/staff/:token/food-scan', requireCap('food_counter'), async (req, res) => {
  try {
    const mealSlot = (req.body.meal_slot || '').trim();
    if (!mealSlot) return res.status(400).json({ error: 'meal_slot is required' });
    const found = await findByToken(req.params.token);
    if (!found) return res.status(404).json({ error: 'Badge not found' });
    const { type, row } = found;
    const already = await db.get(`
      SELECT id FROM attendance_log
      WHERE scan_point='food_counter' AND entity_type=$1 AND entity_id=$2
        AND meta->>'meal_slot' = $3 AND created_at::date = CURRENT_DATE
    `, [type, row.id, mealSlot]);
    if (already) return res.json({ already: true });
    await recordScan({ entityType: type, entityId: row.id, scanPoint: 'food_counter', userId: req.user.id, meta: { meal_slot: mealSlot } });
    const countRow = await db.get(`
      SELECT COUNT(*)::int AS n FROM attendance_log
      WHERE scan_point='food_counter' AND meta->>'meal_slot' = $1 AND created_at::date = CURRENT_DATE
    `, [mealSlot]);
    res.json({ already: false, todayCount: countRow.n });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Stall visit: logs this contact into the scanning stall_owner's own ---
// leads list (see /my-scans below, which login.js's "My Visitors" panel calls).
staffRouter.post('/staff/:token/stall-visit', requireCap('stall_owner'), async (req, res) => {
  try {
    const found = await findByToken(req.params.token);
    if (!found) return res.status(404).json({ error: 'Badge not found' });
    const { type, row } = found;
    await recordScan({ entityType: type, entityId: row.id, scanPoint: 'stall', userId: req.user.id, meta: { stall_id: req.scanUser.stall_id } });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Goods delivery: closes out one pending inventory_distributions row ---
// for the scanned person. Verifies distId actually belongs to them so a
// scanner can't mark someone else's delivery as done by guessing an id.
staffRouter.post('/staff/:token/goodies/:distId/deliver', requireCap('inventory'), async (req, res) => {
  try {
    const found = await findByToken(req.params.token);
    if (!found) return res.status(404).json({ error: 'Badge not found' });
    const { type, row } = found;
    const dist = await db.get(
      `SELECT * FROM inventory_distributions WHERE id=$1 AND recipient_type=$2 AND recipient_id=$3`,
      [req.params.distId, type, row.id]
    );
    if (!dist) return res.status(404).json({ error: 'That item is not pending for this person.' });

    // Someone else's assigned goodies can't be marked delivered from here —
    // admin/super_admin (covering a gap) and unassigned stock are the only
    // exceptions. Keeps "who has how many in charge" honest: a delivery
    // only ever gets attributed to whoever was actually carrying it.
    const isSuperStaff = req.scanUser.role === 'admin' || req.scanUser.role === 'super_admin';
    const mine = myCustodianIdentity(req.scanUser);
    const isMine = !dist.assigned_custodian_id
      || (mine && dist.assigned_custodian_type === mine.type && String(dist.assigned_custodian_id) === String(mine.id));
    if (!isSuperStaff && !isMine) {
      return res.status(403).json({ error: 'This item is assigned to a different courier — not yours to deliver.' });
    }

    const deliveredByType = mine ? mine.type : (dist.assigned_custodian_type || null);
    const deliveredById = mine ? mine.id : (dist.assigned_custodian_id || null);
    await db.run(
      `UPDATE inventory_distributions SET status='delivered',
        delivered_by_type=COALESCE($1, delivered_by_type),
        delivered_by_id=COALESCE($2, delivered_by_id),
        delivered_by_host_member_id=COALESCE($3, delivered_by_host_member_id),
        delivered_at=NOW()
       WHERE id=$4`,
      [deliveredByType, deliveredById, deliveredByType === 'host_member' ? deliveredById : null, dist.id]
    );
    await recordScan({ entityType: type, entityId: row.id, scanPoint: 'goodies', userId: req.user.id, meta: { distribution_id: dist.id } });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Goodies: "who I need to deliver to" — a proactive checklist, seen ---
// BEFORE scanning anyone, of every pending item currently assigned to this
// courier (or their whole delivery run, if nothing's individually assigned
// to them yet — same "unassigned = fair game" rule as pending_goodies
// above). Answers "he will be informed of who it should be delivered to":
// the courier sees the full list of recipients up front, not just whoever
// happens to get scanned next.
staffRouter.get('/my-goodies-checklist', requireCap('inventory'), async (req, res) => {
  try {
    const mine = myCustodianIdentity(req.scanUser);
    if (!mine) return res.json([]);
    const rows = await db.all(`
      SELECT ind.id AS distribution_id, ind.quantity, ind.status, ind.delivered_at,
        ii.id AS inventory_item_id, ii.name AS item_name, ii.unit,
        ind.recipient_type, ind.recipient_id,
        COALESCE(rs.name, rsp.name, rgv.name, rp.name, rhm.name) AS recipient_name,
        COALESCE(rp.phone, rhm.phone) AS recipient_phone
      FROM inventory_distributions ind
      JOIN inventory_items ii ON ii.id = ind.inventory_item_id
      LEFT JOIN sponsors rs ON ind.recipient_type='sponsor' AND ind.recipient_id = rs.id
      LEFT JOIN speakers rsp ON ind.recipient_type='speaker' AND ind.recipient_id = rsp.id
      LEFT JOIN guest_visitors rgv ON ind.recipient_type='guest_visitor' AND ind.recipient_id = rgv.id
      LEFT JOIN participants rp ON ind.recipient_type='participant' AND ind.recipient_id = rp.id
      LEFT JOIN host_members rhm ON ind.recipient_type='host_member' AND ind.recipient_id = rhm.id
      WHERE ind.assigned_custodian_type = $1 AND ind.assigned_custodian_id = $2 AND ind.status != 'cancelled'
      ORDER BY (ind.status = 'pending') DESC, ii.name, recipient_name
    `, [mine.type, mine.id]);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Event Attendance: registration-desk QR scanning -----------------------
// Every congress itinerary slot (server/routes/itinerary.js's itinerary_
// items — the SAME table the Itinerary module edits) is a possible "which
// event is this attendance for" choice. Listing it live here, rather than a
// separate hardcoded scan-config list, is what makes "even after the
// itinerary is modified, the scanner should work" true: rename a slot, add
// a new one, reorder the day — the dropdown reflects it on the very next
// fetch, no code change needed.
staffRouter.get('/itinerary-events', requireCap('registration'), async (req, res) => {
  try {
    const rows = await db.all(`
      SELECT ii.id, ii.day_label, ii.time_label, ii.title,
        COUNT(ea.id)::int AS present_count
      FROM itinerary_items ii
      LEFT JOIN event_attendance ea ON ea.itinerary_item_id = ii.id
      GROUP BY ii.id
      ORDER BY ii.sort_order, ii.id
    `);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Marks the scanned badge present for whichever itinerary slot the scanner
// picked from the dropdown above — idempotent (re-scanning the same person
// for the same event just reports back their original check-in time rather
// than erroring or duplicating), same "already done" handling as the
// transport/goodies scans above.
staffRouter.post('/staff/:token/attendance-scan', requireCap('registration'), async (req, res) => {
  try {
    const itineraryItemId = req.body.itinerary_item_id;
    if (!itineraryItemId) return res.status(400).json({ error: 'Select an event before scanning.' });
    const found = await findByToken(req.params.token);
    if (!found) return res.status(404).json({ error: 'Badge not found' });
    const { type, row } = found;

    const item = await db.get('SELECT id, day_label, time_label, title FROM itinerary_items WHERE id=$1', [itineraryItemId]);
    if (!item) return res.status(404).json({ error: 'That event no longer exists — refresh the event list.' });

    const existing = await db.get(
      `SELECT checked_in_at FROM event_attendance WHERE itinerary_item_id=$1 AND entity_type=$2 AND entity_id=$3`,
      [itineraryItemId, type, row.id]
    );
    if (existing) {
      return res.json({ marked: true, alreadyMarked: true, checked_in_at: existing.checked_in_at, event: item });
    }
    const result = await db.run(
      `INSERT INTO event_attendance (itinerary_item_id, entity_type, entity_id, checked_in_by_user_id)
       VALUES ($1,$2,$3,$4) RETURNING checked_in_at`,
      [itineraryItemId, type, row.id, req.user.id]
    );
    await recordScan({ entityType: type, entityId: row.id, scanPoint: 'registration', userId: req.user.id, meta: { itinerary_item_id: Number(itineraryItemId) } });
    res.json({ marked: true, alreadyMarked: false, checked_in_at: result.rows[0].checked_in_at, event: item });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Reporting: who scanned whom ---
// Full cross-scanner history, admin/super_admin only (an extra check layered
// on top of staffRouter's requireAuth mount, same pattern as the GET-vs-other
// split on /api/itinerary in index.js) — filterable by scan point, by
// scanner, or by a date range, for a post-event or mid-event audit view.
staffRouter.get('/scan-history', requireAdminRole, async (req, res) => {
  try {
    const { scan_point, scanner_user_id, from_date, to_date, limit } = req.query;
    const clauses = [];
    const params = [];
    if (scan_point) { params.push(scan_point); clauses.push(`al.scan_point = $${params.length}`); }
    if (scanner_user_id) { params.push(scanner_user_id); clauses.push(`al.checked_in_by_user_id = $${params.length}`); }
    if (from_date) { params.push(from_date); clauses.push(`al.checked_in_at >= $${params.length}::date`); }
    if (to_date) { params.push(to_date); clauses.push(`al.checked_in_at < ($${params.length}::date + INTERVAL '1 day')`); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const cap = Math.min(Number(limit) || 500, 2000);
    const rows = await db.all(`
      SELECT al.id, al.scan_point, al.checked_in_at, al.meta,
        al.entity_type, al.entity_id,
        COALESCE(p.name, hm.name) AS entity_name,
        u.username AS scanner_username, u.role AS scanner_role
      FROM attendance_log al
      LEFT JOIN participants p ON al.entity_type='participant' AND p.id = al.entity_id
      LEFT JOIN host_members hm ON al.entity_type='host_member' AND hm.id = al.entity_id
      LEFT JOIN users u ON u.id = al.checked_in_by_user_id
      ${where}
      ORDER BY al.checked_in_at DESC
      LIMIT ${cap}
    `, params);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Self-service: "who have I scanned" — any scanner (stall owner's ---
// "My Visitors", or hotel-desk/food-counter/transport staff wanting their
// own tally), scoped to their own checked_in_by_user_id only.
staffRouter.get('/my-scans', async (req, res) => {
  try {
    const { scan_point, limit } = req.query;
    const params = [req.user.id];
    let where = 'al.checked_in_by_user_id = $1';
    if (scan_point) { params.push(scan_point); where += ` AND al.scan_point = $${params.length}`; }
    const cap = Math.min(Number(limit) || 200, 1000);
    const rows = await db.all(`
      SELECT al.id, al.scan_point, al.checked_in_at, al.meta,
        al.entity_type, al.entity_id,
        COALESCE(p.name, hm.name) AS entity_name,
        COALESCE(p.phone, hm.phone) AS entity_phone,
        COALESCE(p.email, hm.email) AS entity_email
      FROM attendance_log al
      LEFT JOIN participants p ON al.entity_type='participant' AND p.id = al.entity_id
      LEFT JOIN host_members hm ON al.entity_type='host_member' AND hm.id = al.entity_id
      WHERE ${where}
      ORDER BY al.checked_in_at DESC
      LIMIT ${cap}
    `, params);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = { publicRouter, staffRouter };