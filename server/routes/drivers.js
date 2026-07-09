const express = require('express');
const db = require('../db');
const { logActivity } = require('../lib/activityLogger');

const router = express.Router();

function normPhone(p) {
  return (p || '').replace(/\D/g, '').slice(-10);
}

async function findDuplicateDriver({ phone, vehicle_number, excludeId }) {
  const np = normPhone(phone);
  const nv = (vehicle_number || '').trim().toUpperCase();
  if (np) {
    let sql = `SELECT id, name, vehicle_number FROM drivers WHERE phone <> '' AND RIGHT(regexp_replace(phone, '[^0-9]', '', 'g'), 10) = $1`;
    const params = [np];
    if (excludeId) { sql += ' AND id <> $2'; params.push(excludeId); }
    const row = await db.get(sql, params);
    if (row) return row;
  }
  if (nv) {
    let sql = `SELECT id, name, vehicle_number FROM drivers WHERE upper(trim(vehicle_number)) = $1`;
    const params = [nv];
    if (excludeId) { sql += ' AND id <> $2'; params.push(excludeId); }
    return db.get(sql, params);
  }
  return null;
}

router.get('/', async (req, res) => {
  try {
    const rows = await db.all(`
      SELECT d.*, p.name AS partner_name,
        v.vehicle_code, v.vehicle_type AS vehicle_master_type, v.model AS vehicle_model, v.seating_capacity
      FROM drivers d
      LEFT JOIN partners p ON p.id = d.partner_id
      LEFT JOIN vehicles v ON v.id = d.vehicle_id
      ORDER BY d.name
    `);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/', async (req, res) => {
  const { name, phone, vehicle_number, vehicle_type, vehicle_id, partner_id, notes, force } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  try {
    if (!force) {
      const dup = await findDuplicateDriver({ phone, vehicle_number });
      if (dup) return res.status(409).json({ error: `A driver named "${dup.name}"${dup.vehicle_number ? ' (vehicle ' + dup.vehicle_number + ')' : ''} already exists with a matching phone/vehicle number.`, existing: dup });
    }
    const result = await db.run(`
      INSERT INTO drivers (name, phone, vehicle_number, vehicle_type, vehicle_id, partner_id, notes)
      VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id
    `, [name, phone || '', vehicle_number || '', vehicle_type || '', vehicle_id || null, partner_id || null, notes || '']);
    logActivity(req.user, { action: 'create', entityType: 'driver', entityId: result.id, label: name });
    res.json({ id: result.id });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.put('/:id', async (req, res) => {
  const { name, phone, vehicle_number, vehicle_type, vehicle_id, partner_id, notes } = req.body;
  try {
    await db.run(`
      UPDATE drivers SET
        name=COALESCE($1,name), phone=COALESCE($2,phone), vehicle_number=COALESCE($3,vehicle_number),
        vehicle_type=COALESCE($4,vehicle_type), vehicle_id=COALESCE($5,vehicle_id),
        partner_id=COALESCE($6,partner_id), notes=COALESCE($7,notes)
      WHERE id=$8
    `, [name || null, phone || null, vehicle_number || null, vehicle_type || null, vehicle_id || null,
        partner_id || null, notes !== undefined ? notes : null, req.params.id]);
    logActivity(req.user, { action: 'update', entityType: 'driver', entityId: Number(req.params.id), label: name });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.delete('/:id', async (req, res) => {
  const existing = await db.get('SELECT name FROM drivers WHERE id=$1', [req.params.id]);
  await db.run('DELETE FROM drivers WHERE id=$1', [req.params.id]);
  logActivity(req.user, { action: 'delete', entityType: 'driver', entityId: Number(req.params.id), label: existing?.name });
  res.json({ ok: true });
});

module.exports = router;
