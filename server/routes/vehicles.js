const express = require('express');
const db = require('../db');
const { logActivity } = require('../lib/activityLogger');

const router = express.Router();

// Vehicle identification codes: a one-letter type prefix + a zero-padded
// sequence number, unique per type — e.g. van #1 is S001, car #1 is C001,
// bus #1 is A001. S = shuttle van, C = car, A = coAch/bus.
const TYPE_PREFIX = { van: 'S', car: 'C', bus: 'A' };
function formatVehicleCode(type, n) {
  const prefix = TYPE_PREFIX[type];
  if (!prefix) throw new Error(`Unknown vehicle type "${type}"`);
  return prefix + String(n).padStart(3, '0');
}
async function computeNextVehicleCode(runner, type) {
  const prefix = TYPE_PREFIX[type];
  if (!prefix) throw new Error(`Unknown vehicle type "${type}"`);
  const row = await runner.get(`
    SELECT COALESCE(MAX((regexp_match(vehicle_code, '(\\d+)$'))[1]::int), 0) AS max_num
    FROM vehicles WHERE vehicle_code LIKE $1
  `, [prefix + '%']);
  return formatVehicleCode(type, (row && row.max_num ? row.max_num : 0) + 1);
}

router.get('/', async (req, res) => {
  try {
    const rows = await db.all(`
      SELECT v.*, p.name AS partner_name,
        (SELECT COUNT(*) FROM drivers d WHERE d.vehicle_id = v.id) AS driver_count
      FROM vehicles v LEFT JOIN partners p ON p.id = v.partner_id
      ORDER BY v.vehicle_type, v.vehicle_code
    `);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Preview the next auto-generated code for a given type without reserving it.
router.get('/next-code', async (req, res) => {
  try {
    const type = (req.query.type || '').toLowerCase();
    if (!TYPE_PREFIX[type]) return res.status(400).json({ error: 'type must be van, car, or bus' });
    const vehicle_code = await computeNextVehicleCode(db, type);
    res.json({ vehicle_code });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/', async (req, res) => {
  let { vehicle_code, vehicle_type, model, seating_capacity, registration_number, partner_id, notes } = req.body;
  vehicle_type = (vehicle_type || '').toLowerCase();
  if (!TYPE_PREFIX[vehicle_type]) return res.status(400).json({ error: 'vehicle_type must be van, car, or bus' });
  try {
    const result = await db.transaction(async (tx) => {
      // Advisory lock (distinct from the one registrations.js uses) so two
      // concurrent submits for the same vehicle type can't grab the same code.
      await tx.run('SELECT pg_advisory_xact_lock(778900)');
      if (!vehicle_code || !vehicle_code.trim()) {
        vehicle_code = await computeNextVehicleCode(tx, vehicle_type);
      }
      return tx.run(`
        INSERT INTO vehicles (vehicle_code, vehicle_type, model, seating_capacity, registration_number, partner_id, notes)
        VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id
      `, [vehicle_code, vehicle_type, model || '', Number(seating_capacity) || 0,
          registration_number || '', partner_id || null, notes || '']);
    });
    logActivity(req.user, { action: 'create', entityType: 'vehicle', entityId: result.id, label: vehicle_code });
    res.json({ id: result.id, vehicle_code });
  } catch (e) {
    if (e.code === '23505') {
      return res.status(409).json({ error: 'duplicate', message: `Vehicle code "${vehicle_code}" already exists. Please try again.` });
    }
    res.status(400).json({ error: e.message });
  }
});

router.put('/:id', async (req, res) => {
  const { vehicle_type, model, seating_capacity, registration_number, partner_id, notes } = req.body;
  try {
    await db.run(`
      UPDATE vehicles SET
        vehicle_type=COALESCE($1,vehicle_type), model=COALESCE($2,model),
        seating_capacity=COALESCE($3,seating_capacity), registration_number=COALESCE($4,registration_number),
        partner_id=COALESCE($5,partner_id), notes=COALESCE($6,notes)
      WHERE id=$7
    `, [vehicle_type ? vehicle_type.toLowerCase() : null, model || null,
        seating_capacity !== undefined ? Number(seating_capacity) : null,
        registration_number || null, partner_id || null,
        notes !== undefined ? notes : null, req.params.id]);
    logActivity(req.user, { action: 'update', entityType: 'vehicle', entityId: Number(req.params.id) });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.delete('/:id', async (req, res) => {
  const existing = await db.get('SELECT vehicle_code FROM vehicles WHERE id=$1', [req.params.id]);
  await db.run('DELETE FROM vehicles WHERE id=$1', [req.params.id]);
  logActivity(req.user, { action: 'delete', entityType: 'vehicle', entityId: Number(req.params.id), label: existing?.vehicle_code });
  res.json({ ok: true });
});

module.exports = router;
