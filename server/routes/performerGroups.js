const express = require('express');
const db = require('../db');
const { logActivity } = require('../lib/activityLogger');

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const rows = await db.all(`
      SELECT pg.*,
        (SELECT COUNT(*) FROM agenda_events ae WHERE ae.performer_group_id = pg.id) AS agenda_event_count
      FROM performer_groups pg ORDER BY pg.name
    `);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const row = await db.get('SELECT * FROM performer_groups WHERE id=$1', [req.params.id]);
    if (!row) return res.status(404).json({ error: 'Performer group not found' });
    res.json(row);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/', async (req, res) => {
  const { name, category, contact_person, phone, email, fee_amount, payment_status, payment_mode, payment_date, notes } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });
  try {
    const result = await db.run(`
      INSERT INTO performer_groups (name, category, contact_person, phone, email, fee_amount, payment_status, payment_mode, payment_date, notes)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id
    `, [name.trim(), category || '', contact_person || '', phone || '', email || '',
        Number(fee_amount) || 0, payment_status || 'pending', payment_mode || '', payment_date || null, notes || '']);
    logActivity(req.user, { action: 'create', entityType: 'performer_group', entityId: result.id, label: name.trim() });
    res.json({ id: result.id });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.put('/:id', async (req, res) => {
  const { name, category, contact_person, phone, email, fee_amount, payment_status, payment_mode, payment_date, notes } = req.body;
  try {
    await db.run(`
      UPDATE performer_groups SET
        name=COALESCE($1,name), category=COALESCE($2,category), contact_person=COALESCE($3,contact_person),
        phone=COALESCE($4,phone), email=COALESCE($5,email),
        fee_amount=COALESCE($6,fee_amount), payment_status=COALESCE($7,payment_status),
        payment_mode=COALESCE($8,payment_mode), payment_date=$9, notes=COALESCE($10,notes),
        updated_at=NOW()
      WHERE id=$11
    `, [name || null, category !== undefined ? category : null, contact_person !== undefined ? contact_person : null,
        phone !== undefined ? phone : null, email !== undefined ? email : null,
        fee_amount !== undefined && fee_amount !== '' ? Number(fee_amount) : null,
        payment_status || null, payment_mode !== undefined ? payment_mode : null,
        payment_date || null, notes !== undefined ? notes : null, req.params.id]);
    logActivity(req.user, { action: 'update', entityType: 'performer_group', entityId: Number(req.params.id), label: name });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.delete('/:id', async (req, res) => {
  const existing = await db.get('SELECT name FROM performer_groups WHERE id=$1', [req.params.id]);
  await db.run('DELETE FROM performer_groups WHERE id=$1', [req.params.id]);
  logActivity(req.user, { action: 'delete', entityType: 'performer_group', entityId: Number(req.params.id), label: existing?.name });
  res.json({ ok: true });
});

module.exports = router;
