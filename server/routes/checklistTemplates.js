// Master checklist templates — the predefined set of checklist items that
// SHOULD be completed for each category (Sponsors, Guest Speakers, Guest
// Visitors, Delegates/participants, Host Members). Managed from the
// Checklists & Milestones admin tab. These are the "menu" admins pick from
// (or quick-add all of) onto any individual's own checklist_items rows —
// editing or deleting a template here never touches checklists already
// handed out to a specific sponsor/speaker/etc.
//
// responsible_committee_id is the DEFAULT delivery-accountable committee for
// every item quick-added from this template (e.g. "Welcome Kit" -> Welcome &
// Registration Committee) — each resulting checklist_items row still carries
// its own responsible_committee_id that can be overridden per person later.
//
// Delete is restricted to super admins the same way as every other resource
// in this app: server/index.js already gates ALL DELETE requests under /api
// behind requireSuperAdmin, globally, before any route-specific handler runs.
const express = require('express');
const db = require('../db');

const router = express.Router();

const OWNER_TYPES = ['sponsor', 'speaker', 'guest_visitor', 'participant', 'host_member'];

const SELECT_WITH_COMMITTEE = `
  SELECT t.*, c.name AS responsible_committee_name
  FROM checklist_templates t
  LEFT JOIN committees c ON c.id = t.responsible_committee_id
`;

router.get('/', async (req, res) => {
  try {
    const { owner_type } = req.query;
    if (owner_type && !OWNER_TYPES.includes(owner_type)) {
      return res.status(400).json({ error: `owner_type must be one of: ${OWNER_TYPES.join(', ')}` });
    }
    const rows = owner_type
      ? await db.all(`${SELECT_WITH_COMMITTEE} WHERE t.owner_type=$1 ORDER BY t.sort_order, t.id`, [owner_type])
      : await db.all(`${SELECT_WITH_COMMITTEE} ORDER BY t.owner_type, t.sort_order, t.id`);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/', async (req, res) => {
  const { owner_type, category, label, sort_order, responsible_committee_id } = req.body;
  if (!owner_type || !OWNER_TYPES.includes(owner_type)) {
    return res.status(400).json({ error: `owner_type is required and must be one of: ${OWNER_TYPES.join(', ')}` });
  }
  if (!label || !label.trim()) return res.status(400).json({ error: 'label is required' });
  try {
    const result = await db.run(
      `INSERT INTO checklist_templates (owner_type, category, label, sort_order, responsible_committee_id) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [owner_type, category || '', label.trim(), Number(sort_order) || 0, responsible_committee_id || null]
    );
    res.json({ id: result.id });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.put('/:id', async (req, res) => {
  const body = req.body;
  if (body.label !== undefined && !body.label.trim()) return res.status(400).json({ error: 'label cannot be empty' });
  try {
    const existing = await db.get('SELECT * FROM checklist_templates WHERE id=$1', [req.params.id]);
    if (!existing) return res.status(404).json({ error: 'Checklist template item not found.' });
    const category = body.category !== undefined ? body.category : existing.category;
    const label = body.label !== undefined ? body.label.trim() : existing.label;
    const sort_order = body.sort_order !== undefined ? Number(body.sort_order) : existing.sort_order;
    // Not COALESCE'd — an explicit null clears the committee assignment
    // (goes back to "Unassigned"); omitting the field leaves it untouched.
    const responsible_committee_id = body.responsible_committee_id !== undefined
      ? (body.responsible_committee_id || null) : existing.responsible_committee_id;
    await db.run(
      `UPDATE checklist_templates SET category=$1, label=$2, sort_order=$3, responsible_committee_id=$4 WHERE id=$5`,
      [category, label, sort_order, responsible_committee_id, req.params.id]
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
