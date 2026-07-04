// Master checklist templates — the predefined set of checklist items that
// SHOULD be completed for each category (Sponsors, Guest Speakers, Guest
// Visitors, Delegates/participants, Host Members). Managed from the
// Checklists & Milestones admin tab. These are the "menu" admins pick from
// (or quick-add all of) onto any individual's own checklist_items rows —
// editing or deleting a template here never touches checklists already
// handed out to a specific sponsor/speaker/etc.
//
// Delete is restricted to super admins the same way as every other resource
// in this app: server/index.js already gates ALL DELETE requests under /api
// behind requireSuperAdmin, globally, before any route-specific handler runs.
const express = require('express');
const db = require('../db');

const router = express.Router();

const OWNER_TYPES = ['sponsor', 'speaker', 'guest_visitor', 'participant', 'host_member'];

router.get('/', async (req, res) => {
  try {
    const { owner_type } = req.query;
    if (owner_type && !OWNER_TYPES.includes(owner_type)) {
      return res.status(400).json({ error: `owner_type must be one of: ${OWNER_TYPES.join(', ')}` });
    }
    const rows = owner_type
      ? await db.all('SELECT * FROM checklist_templates WHERE owner_type=$1 ORDER BY sort_order, id', [owner_type])
      : await db.all('SELECT * FROM checklist_templates ORDER BY owner_type, sort_order, id');
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/', async (req, res) => {
  const { owner_type, category, label, sort_order } = req.body;
  if (!owner_type || !OWNER_TYPES.includes(owner_type)) {
    return res.status(400).json({ error: `owner_type is required and must be one of: ${OWNER_TYPES.join(', ')}` });
  }
  if (!label || !label.trim()) return res.status(400).json({ error: 'label is required' });
  try {
    const result = await db.run(
      `INSERT INTO checklist_templates (owner_type, category, label, sort_order) VALUES ($1,$2,$3,$4) RETURNING id`,
      [owner_type, category || '', label.trim(), Number(sort_order) || 0]
    );
    res.json({ id: result.id });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.put('/:id', async (req, res) => {
  const { category, label, sort_order } = req.body;
  if (label !== undefined && !label.trim()) return res.status(400).json({ error: 'label cannot be empty' });
  try {
    const existing = await db.get('SELECT id FROM checklist_templates WHERE id=$1', [req.params.id]);
    if (!existing) return res.status(404).json({ error: 'Checklist template item not found.' });
    await db.run(
      `UPDATE checklist_templates SET
        category=COALESCE($1,category), label=COALESCE($2,label), sort_order=COALESCE($3,sort_order)
       WHERE id=$4`,
      [category !== undefined ? category : null, label !== undefined ? label.trim() : null,
        sort_order !== undefined ? Number(sort_order) : null, req.params.id]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const existing = await db.get('SELECT id FROM checklist_templates WHERE id=$1', [req.params.id]);
    if (!existing) return res.status(404).json({ error: 'Checklist template item not found.' });
    await db.run('DELETE FROM checklist_templates WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

module.exports = router;
