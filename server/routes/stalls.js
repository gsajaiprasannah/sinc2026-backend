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
        b.id AS booking_id, b.company_name AS booked_company_name, b.status AS booking_status,
        hm.name AS host_member_name, hm.company AS host_member_company, hm.phone AS host_member_phone
      FROM stalls s
      JOIN stall_halls h ON h.id = s.hall_id
      LEFT JOIN stall_bookings b ON b.stall_id = s.id AND b.status <> 'cancelled'
      LEFT JOIN host_members hm ON hm.id = s.host_member_id
      ${where}
      ORDER BY h.name, s.stall_number
    `, params);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- host member stalls ----------------------------------------------------
// Hall B stalls belong to host members, one each, complimentary. Kept entirely
// separate from the exhibitor booking workflow (see the note in db.js), but
// sharing stalls.status so the two can never be given the same stall.

// Who still needs a stall, and which stalls are free. Drives both the picker
// and the bulk assign preview.
router.get('/host-member-availability', async (req, res) => {
  try {
    const members = await db.all(`
      SELECT hm.id, hm.name, hm.company, hm.phone,
             s.id AS stall_id, s.stall_number, h.name AS hall_name
        FROM host_members hm
        LEFT JOIN stalls s ON s.host_member_id = hm.id
        LEFT JOIN stall_halls h ON h.id = s.hall_id
       ORDER BY hm.name
    `);
    const freeStalls = await db.all(`
      SELECT s.id, s.stall_number, s.hall_id, h.name AS hall_name
        FROM stalls s
        JOIN stall_halls h ON h.id = s.hall_id
       WHERE s.host_member_id IS NULL
         AND NOT EXISTS (SELECT 1 FROM stall_bookings b WHERE b.stall_id = s.id AND b.status <> 'cancelled')
       ORDER BY h.name, s.stall_number
    `);
    res.json({
      ok: true,
      members,
      free_stalls: freeStalls,
      summary: {
        host_members: members.length,
        assigned: members.filter((m) => m.stall_id).length,
        unassigned: members.filter((m) => !m.stall_id).length,
        free_stalls: freeStalls.length
      }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Assign (host_member_id set) or release (null) a single stall.
router.put('/:id/host-member', async (req, res) => {
  const hostMemberId = req.body.host_member_id === null || req.body.host_member_id === '' || req.body.host_member_id === undefined
    ? null : Number(req.body.host_member_id);
  try {
    const out = await db.transaction(async (tx) => {
      const stall = await tx.get(`
        SELECT s.*, h.name AS hall_name FROM stalls s JOIN stall_halls h ON h.id = s.hall_id WHERE s.id = $1
      `, [req.params.id]);
      if (!stall) throw Object.assign(new Error('Stall not found.'), { statusCode: 404 });

      // A stall sold to an exhibitor cannot also be a host member's.
      const booking = await tx.get(
        `SELECT id, company_name FROM stall_bookings WHERE stall_id = $1 AND status <> 'cancelled'`, [stall.id]);
      if (booking && hostMemberId) {
        throw Object.assign(
          new Error(`Stall ${stall.stall_number} is booked by ${booking.company_name}. Release that booking first.`),
          { statusCode: 409 });
      }

      if (hostMemberId) {
        const hm = await tx.get('SELECT id, name FROM host_members WHERE id = $1', [hostMemberId]);
        if (!hm) throw Object.assign(new Error('Host member not found.'), { statusCode: 400 });
        const held = await tx.get(`
          SELECT s.stall_number, h.name AS hall_name FROM stalls s JOIN stall_halls h ON h.id = s.hall_id
           WHERE s.host_member_id = $1 AND s.id <> $2`, [hostMemberId, stall.id]);
        if (held) {
          throw Object.assign(
            new Error(`${hm.name} already has ${held.hall_name} ${held.stall_number}. Release that one first.`),
            { statusCode: 409 });
        }
        await tx.run(`UPDATE stalls SET host_member_id = $1, status = 'allocated', updated_at = NOW() WHERE id = $2`,
          [hostMemberId, stall.id]);
        return { assigned: hm.name, stall_number: stall.stall_number, hall_name: stall.hall_name };
      }

      // Releasing: only drop back to 'available' if no live booking holds it.
      await tx.run(`
        UPDATE stalls SET host_member_id = NULL,
               status = CASE WHEN $2::boolean THEN status ELSE 'available' END,
               updated_at = NOW()
         WHERE id = $1`, [stall.id, !!booking]);
      return { released: true, stall_number: stall.stall_number, hall_name: stall.hall_name };
    });

    logActivity(req.user, {
      action: 'update', entityType: 'stall', entityId: Number(req.params.id),
      label: out.released ? `Released ${out.hall_name} ${out.stall_number}` : `${out.hall_name} ${out.stall_number} -> ${out.assigned}`
    });
    res.json({ ok: true, ...out });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'That host member already holds a stall.' });
    res.status(e.statusCode || 500).json({ error: e.message });
  }
});

// Bulk assign every unassigned host member to a free stall in one hall, in name
// order. Preview by default — nothing is written without apply:true, because
// this touches up to 75 rows and getting it wrong means unpicking all of them.
router.post('/host-member-bulk-assign', async (req, res) => {
  const hallId = Number(req.body.hall_id);
  const apply = req.body.apply === true;
  if (!hallId) return res.status(400).json({ error: 'hall_id is required.' });
  try {
    const result = await db.transaction(async (tx) => {
      const hall = await tx.get('SELECT id, name FROM stall_halls WHERE id = $1', [hallId]);
      if (!hall) throw Object.assign(new Error('Hall not found.'), { statusCode: 404 });

      const pending = await tx.all(`
        SELECT hm.id, hm.name, hm.company FROM host_members hm
         WHERE NOT EXISTS (SELECT 1 FROM stalls s WHERE s.host_member_id = hm.id)
         ORDER BY hm.name
      `);
      const free = await tx.all(`
        SELECT s.id, s.stall_number FROM stalls s
         WHERE s.hall_id = $1 AND s.host_member_id IS NULL
           AND NOT EXISTS (SELECT 1 FROM stall_bookings b WHERE b.stall_id = s.id AND b.status <> 'cancelled')
         ORDER BY LENGTH(s.stall_number), s.stall_number
      `, [hallId]);

      const pairs = pending.slice(0, free.length).map((m, i) => ({
        host_member_id: m.id, host_member_name: m.name, company: m.company,
        stall_id: free[i].id, stall_number: free[i].stall_number
      }));

      if (apply) {
        for (const p of pairs) {
          await tx.run(`UPDATE stalls SET host_member_id = $1, status = 'allocated', updated_at = NOW() WHERE id = $2`,
            [p.host_member_id, p.stall_id]);
        }
      }
      return {
        hall: hall.name, applied: apply, pairs,
        unassigned_members: pending.length,
        free_stalls: free.length,
        left_without_stall: Math.max(0, pending.length - free.length),
        spare_stalls: Math.max(0, free.length - pending.length)
      };
    });

    if (apply && result.pairs.length) {
      logActivity(req.user, { action: 'update', entityType: 'stall', label: `Bulk-assigned ${result.pairs.length} ${result.hall} stall(s) to host members` });
    }
    res.json({ ok: true, ...result });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'A host member in this batch already holds a stall — refresh and try again.' });
    res.status(e.statusCode || 500).json({ error: e.message });
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
