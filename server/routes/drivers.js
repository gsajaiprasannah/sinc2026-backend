const express = require('express');
const db = require('../db');

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const rows = await db.all(`
      SELECT d.*, p.name AS partner_name
      FROM drivers d LEFT JOIN partners p ON p.id = d.partner_id
      ORDER BY d.name
    `);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/', async (req, res) => {
  const { name, phone, vehicle_number, vehicle_type, partner_id, notes } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  try {
    const result = await db.run(`
      INSERT INTO drivers (name, phone, vehicle_number, vehicle_type, partner_id, notes)
      VALUES ($1,$2,$3,$4,$5,$6) RETURNING id
    `, [name, phone || '', vehicle_number || '', vehicle_type || '', partner_id || null, notes || '']);
    res.json({ id: result.id });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.put('/:id', async (req, res) => {
  const { name, phone, vehicle_number, vehicle_type, partner_id, notes } = req.body;
  try {
    await db.run(`
      UPDATE drivers SET
        name=COALESCE($1,name), phone=COALESCE($2,phone), vehicle_number=COALESCE($3,vehicle_number),
        vehicle_type=COALESCE($4,vehicle_type), partner_id=COALESCE($5,partner_id), notes=COALESCE($6,notes)
      WHERE id=$7
    `, [name || null, phone || null, vehicle_number || null, vehicle_type || null,
        partner_id || null, notes !== undefined ? notes : null, req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.delete('/:id', async (req, res) => {
  await db.run('DELETE FROM drivers WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

module.exports = router;
