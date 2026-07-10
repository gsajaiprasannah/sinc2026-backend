const express = require('express');
const db = require('../db');
const { logActivity } = require('../lib/activityLogger');

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const rows = await db.all(`
      SELECT h.*,
        (SELECT COUNT(*) FROM stalls s WHERE s.hall_id = h.id) AS stall_count,
        (SELECT COUNT(*) FROM stalls s WHERE s.hall_id = h.id AND s.status = 'available') AS available_count,
        (SELECT COUNT(*) FROM stalls s WHERE s.hall_id = h.id AND s.status = 'allocated') AS allocated_count
      FROM stall_halls h ORDER BY h.name
    `);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/', async (req, res) => {
  const { name, capacity, notes } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });
  try {
    const result = await db.run(`
      INSERT INTO stall_halls (name, capacity, notes) VALUES ($1,$2,$3) RETURNING id
    `, [name.trim(), capacity !== undefined && capacity !== '' ? Number(capacity) : null, notes || '']);
    logActivity(req.user, { action: 'create', entityType: 'stall_hall', entityId: result.id, label: name.trim() });
    res.json({ id: result.id });
  } catch (e) {
    if (e.code === '23505') {
      return res.status(409).json({ error: 'A hall with this name already exists.' });
    }
    res.status(400).json({ error: e.message });
  }
});

router.put('/:id', async (req, res) => {
  const { name, capacity, notes } = req.body;
  try {
    await db.run(`
      UPDATE stall_halls SET
        name=COALESCE($1,name), capacity=$2, notes=COALESCE($3,notes)
      WHERE id=$4
    `, [name || null, capacity !== undefined && capacity !== '' ? Number(capacity) : null,
        notes !== undefined ? notes : null, req.params.id]);
    logActivity(req.user, { action: 'update', entityType: 'stall_hall', entityId: Number(req.params.id), label: name });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.delete('/:id', async (req, res) => {
  const existing = await db.get('SELECT name FROM stall_halls WHERE id=$1', [req.params.id]);
  await db.run('DELETE FROM stall_halls WHERE id=$1', [req.params.id]);
  logActivity(req.user, { action: 'delete', entityType: 'stall_hall', entityId: Number(req.params.id), label: existing?.name });
  res.json({ ok: true });
});

module.exports = router;
