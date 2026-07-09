const express = require('express');
const db = require('../db');
const { logActivity } = require('../lib/activityLogger');

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const rows = await db.all(`
      SELECT h.*,
        (SELECT COUNT(*) FROM room_assignments ra WHERE ra.hotel_id = h.id) AS occupant_count,
        (SELECT COUNT(DISTINCT ra.room_number) FROM room_assignments ra WHERE ra.hotel_id = h.id) AS room_count
      FROM hotels h ORDER BY h.name
    `);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/', async (req, res) => {
  const { name, address, contact_person, phone, notes } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });
  try {
    const result = await db.run(`
      INSERT INTO hotels (name, address, contact_person, phone, notes)
      VALUES ($1,$2,$3,$4,$5) RETURNING id
    `, [name.trim(), address || '', contact_person || '', phone || '', notes || '']);
    logActivity(req.user, { action: 'create', entityType: 'hotel', entityId: result.id, label: name.trim() });
    res.json({ id: result.id });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.put('/:id', async (req, res) => {
  const { name, address, contact_person, phone, notes } = req.body;
  try {
    await db.run(`
      UPDATE hotels SET
        name=COALESCE($1,name), address=COALESCE($2,address), contact_person=COALESCE($3,contact_person),
        phone=COALESCE($4,phone), notes=COALESCE($5,notes)
      WHERE id=$6
    `, [name || null, address !== undefined ? address : null, contact_person !== undefined ? contact_person : null,
        phone !== undefined ? phone : null, notes !== undefined ? notes : null, req.params.id]);
    logActivity(req.user, { action: 'update', entityType: 'hotel', entityId: Number(req.params.id), label: name });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.delete('/:id', async (req, res) => {
  const existing = await db.get('SELECT name FROM hotels WHERE id=$1', [req.params.id]);
  await db.run('DELETE FROM hotels WHERE id=$1', [req.params.id]);
  logActivity(req.user, { action: 'delete', entityType: 'hotel', entityId: Number(req.params.id), label: existing?.name });
  res.json({ ok: true });
});

module.exports = router;
