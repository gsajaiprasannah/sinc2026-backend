// Shared master list of pickup/drop locations (Airport, Railway Station, Bus
// Stand, plus anything typed into a delegate's arrival point or a trip's
// From/To field) — offered as autocomplete suggestions across the Delegates
// and Transport Planning tabs (and the equivalent host-portal transport
// module), instead of everyone retyping the same handful of places from
// scratch. Adding one here is deliberately frictionless: the frontend calls
// POST quietly after any From/To/arrival-point field is saved with a value
// not already in the list, so typing a new custom point "just works" and is
// remembered for next time — no separate approval step. Delete is restricted
// to super admins the same way as every other resource in this app
// (server/index.js's global DELETE-block covers this route too).
const express = require('express');
const db = require('../db');
const { logActivity } = require('../lib/activityLogger');

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const rows = await db.all('SELECT * FROM transport_points ORDER BY name');
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/', async (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name is required' });
  try {
    const inserted = await db.run(
      `INSERT INTO transport_points (name) VALUES ($1) ON CONFLICT (LOWER(name)) DO NOTHING RETURNING id`,
      [name]
    );
    const row = inserted.id
      ? await db.get('SELECT * FROM transport_points WHERE id=$1', [inserted.id])
      : await db.get('SELECT * FROM transport_points WHERE LOWER(name)=LOWER($1)', [name]);
    res.json(row);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const existing = await db.get('SELECT id FROM transport_points WHERE id=$1', [req.params.id]);
    if (!existing) return res.status(404).json({ error: 'Point not found.' });
    await db.run('DELETE FROM transport_points WHERE id=$1', [req.params.id]);
    logActivity(req.user, { action: 'delete', entityType: 'transport_point', entityId: Number(req.params.id) });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

module.exports = router;
