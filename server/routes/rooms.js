const express = require('express');
const db = require('../db');
const { logActivity } = require('../lib/activityLogger');

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const rows = await db.all(`
      SELECT ra.*, h.name AS hotel_name,
        p.name AS participant_name, p.phone AS participant_phone, p.participant_code,
        hm.name AS host_member_name, hm.phone AS host_member_phone
      FROM room_assignments ra
      JOIN hotels h ON h.id = ra.hotel_id
      LEFT JOIN participants p ON p.id = ra.participant_id
      LEFT JOIN host_members hm ON hm.id = ra.host_member_id
      ORDER BY h.name, ra.room_number
    `);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/', async (req, res) => {
  const { hotel_id, room_number, room_type, participant_id, host_member_id, check_in, check_out, notes } = req.body;
  if (!hotel_id || !room_number || !room_number.trim()) {
    return res.status(400).json({ error: 'hotel_id and room_number are required' });
  }
  if (!participant_id && !host_member_id) {
    return res.status(400).json({ error: 'Select a delegate or a host member to assign to this room.' });
  }
  if (participant_id && host_member_id) {
    return res.status(400).json({ error: 'A room assignment is either a delegate or a host member, not both.' });
  }
  try {
    const result = await db.run(`
      INSERT INTO room_assignments (hotel_id, room_number, room_type, participant_id, host_member_id, check_in, check_out, notes)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id
    `, [hotel_id, room_number.trim(), room_type || '', participant_id || null, host_member_id || null,
        check_in || null, check_out || null, notes || '']);
    logActivity(req.user, { action: 'create', entityType: 'room_assignment', entityId: result.id, label: room_number.trim() });
    res.json({ id: result.id });
  } catch (e) {
    if (e.code === '23505') {
      return res.status(409).json({ error: 'This person already has a room assigned. Remove the existing assignment first if you need to move them.' });
    }
    res.status(400).json({ error: e.message });
  }
});

router.put('/:id', async (req, res) => {
  const { hotel_id, room_number, room_type, check_in, check_out, notes } = req.body;
  try {
    await db.run(`
      UPDATE room_assignments SET
        hotel_id=COALESCE($1,hotel_id), room_number=COALESCE($2,room_number), room_type=COALESCE($3,room_type),
        check_in=$4, check_out=$5, notes=COALESCE($6,notes)
      WHERE id=$7
    `, [hotel_id || null, room_number || null, room_type !== undefined ? room_type : null,
        check_in || null, check_out || null, notes !== undefined ? notes : null, req.params.id]);
    logActivity(req.user, { action: 'update', entityType: 'room_assignment', entityId: Number(req.params.id) });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.delete('/:id', async (req, res) => {
  const existing = await db.get('SELECT room_number FROM room_assignments WHERE id=$1', [req.params.id]);
  await db.run('DELETE FROM room_assignments WHERE id=$1', [req.params.id]);
  logActivity(req.user, { action: 'delete', entityType: 'room_assignment', entityId: Number(req.params.id), label: existing?.room_number });
  res.json({ ok: true });
});

module.exports = router;
