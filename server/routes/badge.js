// QR Badge lookup — one badge_token per Delegate/Host Member drives THREE
// different views from the exact same scanned URL (public/badge.html?token=X):
//
//   1. Anyone who scans it with no login sees a digital visiting-card
//      (name/phone/email/club-or-company) with a "Save to Contacts" button.
//      -> GET /api/badge/public/:token (this file's `publicRouter`, mounted
//         unwrapped in server/index.js — same pattern as publicProfile.js —
//         so it works before any login exists).
//
//   2. Staff already logged into the admin panel (Transport, Pre-Tours, gate
//      volunteers) get the SAME link, but the page additionally shows room
//      assignment, vehicle/transport trip assignment, and payment/registration
//      status, because their browser already carries an admin JWT.
//      -> GET /api/badge/staff/:token (requireAdminRole, mounted in index.js)
//
//   3. That same staff view has a "Mark Attendance" button for gate check-in.
//      -> POST /api/badge/staff/:token/checkin (requireAdminRole)
//
// The token itself (not the raw sequential id) is what's encoded in the QR —
// see server/db.js's badge_token migration for why: a plain id would let
// someone enumerate every attendee's contact details just by walking id up
// or down. Only per-person routes here (never a "list all tokens" endpoint).
const express = require('express');
const db = require('../db');
const { logActivity } = require('../lib/activityLogger');

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

// --- 2. Staff view — everything a Transport/Pre-Tours/gate volunteer needs, ---
// gated by requireAdminRole in server/index.js (any admin/super_admin login,
// same protection level as the rest of the admin panel).
staffRouter.get('/staff/:token', async (req, res) => {
  try {
    const found = await findByToken(req.params.token);
    if (!found) return res.status(404).json({ error: 'Badge not found' });
    const { type, row } = found;

    const room = await db.get(`
      SELECT ra.room_number, ra.room_type, ra.check_in, ra.check_out, h.name AS hotel_name
      FROM room_assignments ra
      JOIN hotels h ON h.id = ra.hotel_id
      WHERE ra.${type === 'participant' ? 'participant_id' : 'host_member_id'} = $1
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
      WHERE tp.${type === 'participant' ? 'participant_id' : 'host_member_id'} = $1
      ORDER BY t.trip_date, t.depart_time
    `, [row.id]);

    const lastCheckin = await db.get(`
      SELECT checked_in_at FROM attendance_log
      WHERE entity_type = $1 AND entity_id = $2
      ORDER BY checked_in_at DESC LIMIT 1
    `, [type, row.id]);

    res.json({
      type,
      name: row.name,
      phone: row.phone || '',
      email: row.email || '',
      photo_url: row.photo_url || null,
      org: type === 'participant' ? (row.club_name || '') : (row.company || ''),
      role_label: type === 'participant' ? 'Delegate' : (row.designation || 'Host Member'),
      registration: type === 'participant'
        ? { reg_number: row.reg_number, reg_type: row.reg_type, payment_status: row.reg_payment_status }
        : { payment_status: row.payment_status, payment_amount: row.payment_amount },
      room: room || null,
      trips,
      last_checked_in_at: lastCheckin ? lastCheckin.checked_in_at : null
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- 3. Mark attendance — every scan just adds another log row (see ---
// attendance_log's header comment in db.js for why there's no uniqueness
// constraint); the staff view shows the most recent one as "checked in at".
staffRouter.post('/staff/:token/checkin', async (req, res) => {
  try {
    const found = await findByToken(req.params.token);
    if (!found) return res.status(404).json({ error: 'Badge not found' });
    const { type, row } = found;
    const result = await db.run(
      `INSERT INTO attendance_log (entity_type, entity_id, checked_in_by_user_id) VALUES ($1,$2,$3) RETURNING checked_in_at`,
      [type, row.id, req.user?.id || null]
    );
    logActivity(req.user, { action: 'checkin', entityType: type, entityId: row.id, label: row.name });
    res.json({ checked_in_at: result.rows[0].checked_in_at });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = { publicRouter, staffRouter };
