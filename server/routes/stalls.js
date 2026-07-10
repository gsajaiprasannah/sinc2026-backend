const express = require('express');
const db = require('../db');
const { logActivity } = require('../lib/activityLogger');

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const conditions = [];
    const params = [];
    if (req.query.hall_id) { params.push(req.query.hall_id); conditions.push(`s.hall_id = $${params.length}`); }
    if (req.query.status) { params.push(req.query.status); conditions.push(`s.status = $${params.length}`); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = await db.all(`
      SELECT s.*, h.name AS hall_name,
        b.id AS booking_id, b.company_name AS booked_company_name, b.status AS booking_status
      FROM stalls s
      JOIN stall_halls h ON h.id = s.hall_id
      LEFT JOIN stall_bookings b ON b.stall_id = s.id AND b.status <> 'cancelled'
      ${where}
      ORDER BY h.name, s.stall_number
    `, params);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/', async (req, res) => {
  const { hall_id, stall_number, size, price, notes } = req.body;
  if (!hall_id) return res.status(400).json({ error: 'hall_id is required' });
  if (!stall_number || !stall_number.trim()) return res.status(400).json({ error: 'stall_number is required' });
  try {
    const result = await db.run(`
      INSERT INTO stalls (hall_id, stall_number, size, price, notes)
      VALUES ($1,$2,$3,$4,$5) RETURNING id
    `, [hall_id, stall_number.trim(), size || '', Number(price) || 0, notes || '']);
    logActivity(req.user, { action: 'create', entityType: 'stall', entityId: result.id, label: stall_number.trim() });
    res.json({ id: result.id });
  } catch (e) {
    if (e.code === '23505') {
      return res.status(409).json({ error: `Stall number "${stall_number}" already exists in this hall.` });
    }
    res.status(400).json({ error: e.message });
  }
});

// Bulk-generate a run of stalls in one hall, e.g. prefix "A-", start 1, end
// 50 -> A-1 .. A-50. Uses ON CONFLICT DO NOTHING so re-running (or
// overlapping an existing range) never duplicates/errors — it just reports
// how many were actually created vs. already existed.
router.post('/generate', async (req, res) => {
  const { hall_id, prefix, start, end, size, price } = req.body;
  if (!hall_id) return res.status(400).json({ error: 'hall_id is required' });
  const startNum = Number(start);
  const endNum = Number(end);
  if (!Number.isInteger(startNum) || !Number.isInteger(endNum) || startNum < 1 || endNum < startNum) {
    return res.status(400).json({ error: 'Provide a valid start and end number (end >= start).' });
  }
  if (endNum - startNum + 1 > 500) {
    return res.status(400).json({ error: 'Please generate at most 500 stalls at a time.' });
  }
  try {
    let created = 0;
    await db.transaction(async (tx) => {
      for (let n = startNum; n <= endNum; n++) {
        const stallNumber = `${prefix || ''}${n}`;
        const result = await tx.run(`
          INSERT INTO stalls (hall_id, stall_number, size, price)
          VALUES ($1,$2,$3,$4)
          ON CONFLICT (hall_id, stall_number) DO NOTHING
          RETURNING id
        `, [hall_id, stallNumber, size || '', Number(price) || 0]);
        if (result.rows.length) created++;
      }
    });
    const skipped = (endNum - startNum + 1) - created;
    logActivity(req.user, { action: 'create', entityType: 'stall', label: `Generated ${created} stall(s) (${prefix || ''}${startNum}-${prefix || ''}${endNum})` });
    res.json({ created, skipped });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.put('/:id', async (req, res) => {
  const { hall_id, stall_number, size, price, notes } = req.body;
  try {
    await db.run(`
      UPDATE stalls SET
        hall_id=COALESCE($1,hall_id), stall_number=COALESCE($2,stall_number),
        size=COALESCE($3,size), price=COALESCE($4,price), notes=COALESCE($5,notes),
        updated_at=NOW()
      WHERE id=$6
    `, [hall_id || null, stall_number || null, size !== undefined ? size : null,
        price !== undefined && price !== '' ? Number(price) : null,
        notes !== undefined ? notes : null, req.params.id]);
    logActivity(req.user, { action: 'update', entityType: 'stall', entityId: Number(req.params.id) });
    res.json({ ok: true });
  } catch (e) {
    if (e.code === '23505') {
      return res.status(409).json({ error: 'A stall with this number already exists in that hall.' });
    }
    res.status(400).json({ error: e.message });
  }
});

router.delete('/:id', async (req, res) => {
  const existing = await db.get('SELECT stall_number, status FROM stalls WHERE id=$1', [req.params.id]);
  if (existing && existing.status === 'allocated') {
    return res.status(409).json({ error: 'This stall is currently allocated to a booking. Release or cancel that booking first.' });
  }
  await db.run('DELETE FROM stalls WHERE id=$1', [req.params.id]);
  logActivity(req.user, { action: 'delete', entityType: 'stall', entityId: Number(req.params.id), label: existing?.stall_number });
  res.json({ ok: true });
});

module.exports = router;
