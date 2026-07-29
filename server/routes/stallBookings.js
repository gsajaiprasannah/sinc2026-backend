const express = require('express');
const db = require('../db');
const { logActivity } = require('../lib/activityLogger');

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const rows = await db.all(`
      SELECT b.*, s.stall_number, s.hall_id, h.name AS hall_name
      FROM stall_bookings b
      LEFT JOIN stalls s ON s.id = b.stall_id
      LEFT JOIN stall_halls h ON h.id = s.hall_id
      ORDER BY b.created_at DESC
    `);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/', async (req, res) => {
  const { company_name, contact_person, phone, email, gstin, requirement_notes, notes } = req.body;
  if (!company_name || !company_name.trim()) return res.status(400).json({ error: 'company_name is required' });
  try {
    const result = await db.run(`
      INSERT INTO stall_bookings (company_name, contact_person, phone, email, gstin, requirement_notes, notes)
      VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id
    `, [company_name.trim(), contact_person || '', phone || '', email || '', gstin || '', requirement_notes || '', notes || '']);
    logActivity(req.user, { action: 'create', entityType: 'stall_booking', entityId: result.id, label: company_name.trim() });
    res.json({ id: result.id });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// One combined update endpoint (same convention as registrations/host
// members elsewhere in this app) — covers editing enquiry details, moving
// the workflow status forward (enquiry -> billed -> allocated / cancelled),
// assigning or changing which stall this booking holds, and payment fields.
// All the stall-availability bookkeeping (freeing the old stall, claiming
// the new one) happens inside one transaction so a stall's status column
// never drifts out of sync with what's actually booked.
router.put('/:id', async (req, res) => {
  const id = Number(req.params.id);
  const {
    company_name, contact_person, phone, email, gstin, requirement_notes,
    stall_id, status, amount, payment_status, payment_mode, payment_date, notes
  } = req.body;
  try {
    const result = await db.transaction(async (tx) => {
      const existing = await tx.get('SELECT * FROM stall_bookings WHERE id=$1', [id]);
      if (!existing) throw Object.assign(new Error('Booking not found'), { statusCode: 404 });

      const nextStallId = stall_id !== undefined ? (stall_id || null) : existing.stall_id;
      const nextStatus = status || existing.status;

      // Changing which stall this booking points to: release the old one
      // (if any) and claim the new one (if any), verifying it's actually free.
      if (nextStallId !== existing.stall_id) {
        if (existing.stall_id) {
          await tx.run(`UPDATE stalls SET status='available', updated_at=NOW() WHERE id=$1`, [existing.stall_id]);
        }
        if (nextStallId) {
          const stall = await tx.get('SELECT id, status FROM stalls WHERE id=$1', [nextStallId]);
          if (!stall) throw Object.assign(new Error('Selected stall not found'), { statusCode: 400 });
          if (stall.status === 'allocated') {
            throw Object.assign(new Error('That stall is already allocated to another booking. Pick a different one.'), { statusCode: 409 });
          }
          await tx.run(`UPDATE stalls SET status='allocated', updated_at=NOW() WHERE id=$1`, [nextStallId]);
        }
      }

      // Cancelling a booking that still holds a stall frees that stall back
      // up for someone else, while keeping stall_id on the row so "who had
      // this stall" stays visible in history.
      if (nextStatus === 'cancelled' && existing.status !== 'cancelled') {
        const stillHeld = nextStallId !== null && nextStallId === existing.stall_id;
        if (stillHeld) {
          await tx.run(`UPDATE stalls SET status='available', updated_at=NOW() WHERE id=$1`, [nextStallId]);
        }
      }

      await tx.run(`
        UPDATE stall_bookings SET
          company_name=COALESCE($1,company_name), contact_person=COALESCE($2,contact_person),
          phone=COALESCE($3,phone), email=COALESCE($4,email), gstin=COALESCE($5,gstin),
          requirement_notes=COALESCE($6,requirement_notes), stall_id=$7, status=COALESCE($8,status),
          amount=COALESCE($9,amount), payment_status=COALESCE($10,payment_status),
          payment_mode=COALESCE($11,payment_mode), payment_date=$12, notes=COALESCE($13,notes),
          updated_at=NOW()
        WHERE id=$14
      `, [
        company_name || null, contact_person !== undefined ? contact_person : null,
        phone !== undefined ? phone : null, email !== undefined ? email : null,
        gstin !== undefined ? gstin : null, requirement_notes !== undefined ? requirement_notes : null,
        nextStallId, status || null,
        amount !== undefined && amount !== '' ? Number(amount) : null,
        payment_status || null, payment_mode !== undefined ? payment_mode : null,
        payment_date || null, notes !== undefined ? notes : null, id
      ]);
      return { ok: true };
    });
    logActivity(req.user, { action: 'update', entityType: 'stall_booking', entityId: id });
    res.json(result);
  } catch (e) {
    if (e.code === '23505') {
      return res.status(409).json({ error: 'That stall is already allocated to another booking.' });
    }
    res.status(e.statusCode || 400).json({ error: e.message });
  }
});

router.delete('/:id', async (req, res) => {
  const existing = await db.get('SELECT company_name, stall_id FROM stall_bookings WHERE id=$1', [req.params.id]);
  if (existing && existing.stall_id) {
    await db.run(`UPDATE stalls SET status='available', updated_at=NOW() WHERE id=$1`, [existing.stall_id]);
  }
  await db.run('DELETE FROM stall_bookings WHERE id=$1', [req.params.id]);
  logActivity(req.user, { action: 'delete', entityType: 'stall_booking', entityId: Number(req.params.id), label: existing?.company_name });
  res.json({ ok: true });
});

// --- Stall Report: visit counts + per-booking drill-down --------------
// Feeds the admin panel's "Stall Report" tab (nested under the Stalls
// sidebar group, below Halls & Stalls / Enquiries & Bookings). A stall_owner
// login is tied to exactly one stall_bookings row (users.stall_id ->
// stall_bookings.id — one login per exhibitor company, not per physical
// stall), and every badge they scan writes a row to the shared
// attendance_log table via badge.js's POST /staff/:token/stall-visit, with
// scan_point='stall' and meta.stall_id set to that same booking id. So
// "how many people visited this stall, and who" is just a filter on
// attendance_log — no separate stall-visits table to keep in sync.
router.get('/visits-summary', async (req, res) => {
  try {
    const rows = await db.all(`
      SELECT b.id, b.company_name, b.contact_person, b.status,
        s.stall_number, h.name AS hall_name,
        COUNT(al.id)::int AS visit_count
      FROM stall_bookings b
      LEFT JOIN stalls s ON s.id = b.stall_id
      LEFT JOIN stall_halls h ON h.id = s.hall_id
      LEFT JOIN attendance_log al ON al.scan_point = 'stall' AND (al.meta->>'stall_id')::int = b.id
      GROUP BY b.id, s.stall_number, h.name
      ORDER BY visit_count DESC, b.company_name
    `);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/:id/visits', async (req, res) => {
  try {
    const booking = await db.get(`
      SELECT b.*, s.stall_number, h.name AS hall_name
      FROM stall_bookings b
      LEFT JOIN stalls s ON s.id = b.stall_id
      LEFT JOIN stall_halls h ON h.id = s.hall_id
      WHERE b.id=$1
    `, [req.params.id]);
    if (!booking) return res.status(404).json({ error: 'Booking not found' });
    const visits = await db.all(`
      SELECT al.id, al.checked_in_at, al.entity_type,
        COALESCE(p.name, hm.name) AS name,
        COALESCE(p.phone, hm.phone) AS phone,
        COALESCE(p.email, hm.email) AS email,
        COALESCE(c.name, hm.company) AS club_or_company
      FROM attendance_log al
      LEFT JOIN participants p ON al.entity_type='participant' AND p.id = al.entity_id
      LEFT JOIN clubs c ON c.id = p.club_id
      LEFT JOIN host_members hm ON al.entity_type='host_member' AND hm.id = al.entity_id
      WHERE al.scan_point = 'stall' AND (al.meta->>'stall_id')::int = $1
      ORDER BY al.checked_in_at DESC
    `, [req.params.id]);
    res.json({ booking, visits });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
