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
const { logActivity } = require('../lib/activityLogger');

const router = express.Router();

const OWNER_TYPES = ['sponsor', 'speaker', 'guest_visitor', 'participant', 'host_member'];
const OWNER_TABLES = {
  sponsor: 'sponsors',
  speaker: 'speakers',
  guest_visitor: 'guest_visitors',
  participant: 'participants',
  host_member: 'host_members'
};

const SELECT_WITH_COMMITTEE = `
  SELECT t.*, c.name AS responsible_committee_name
  FROM checklist_templates t
  LEFT JOIN committees c ON c.id = t.responsible_committee_id
`;

// Templates are meant to be the definitive "this must be accomplished for
// every X" list, not just a copy-paste menu — so saving one (create or edit,
// including just assigning/changing its committee) immediately reaches out
// to every EXISTING entity of that owner_type: it creates the checklist item
// if that entity doesn't have it yet, and — for items that already exist but
// were never given a committee of their own (still following whichever
// default applied when they were added) — updates them to the template's
// current committee. Items that already have their own explicit committee
// override are never touched, preserving the "template default + per-item
// override" design. Without this sync, assigning a committee to a template
// only affects checklist items created AFTER that point via quick-add,
// which looked like the assignment "wasn't reflecting" anywhere for anyone
// already on the list.
// Only the "adopt the committee" half — used on its own to catch items still
// sitting under a template's OLD label/category right before a rename, so
// they aren't stranded without ever receiving whatever committee was just
// assigned. Never creates new items (that would create orphans under a
// label about to become stale).
async function syncCommitteeForExistingItems(ownerType, category, label, committeeId) {
  if (committeeId === null || committeeId === undefined) return 0;
  const result = await db.run(
    `UPDATE checklist_items SET responsible_committee_id=$1, updated_at=NOW()
     WHERE owner_type=$2 AND category=$3 AND label=$4 AND responsible_committee_id IS NULL
     RETURNING id`,
    [committeeId, ownerType, category || '', label]
  );
  return result.rowCount || 0;
}

// Templates are meant to be the definitive "this must be accomplished for
// every X" list, not just a copy-paste menu — so saving one (create or edit,
// including just assigning/changing its committee) immediately reaches out
// to every EXISTING entity of that owner_type: it creates the checklist item
// if that entity doesn't have it yet, and — for items that already exist but
// were never given a committee of their own (still following whichever
// default applied when they were added) — updates them to the template's
// current committee. Items that already have their own explicit committee
// override are never touched, preserving the "template default + per-item
// override" design. Without this sync, assigning a committee to a template
// only affects checklist items created AFTER that point via quick-add,
// which looked like the assignment "wasn't reflecting" anywhere for anyone
// already on the list.
async function syncTemplateToExistingEntities(template) {
  const table = OWNER_TABLES[template.owner_type];
  if (!table) return { created: 0, updated: 0 };
  const category = template.category || '';
  const label = template.label;
  const committeeId = template.responsible_committee_id || null;

  const createResult = await db.run(
    `INSERT INTO checklist_items (owner_type, owner_id, category, label, status, sort_order, responsible_committee_id)
     SELECT $1, e.id, $2, $3, 'pending', $4, $5
     FROM ${table} e
     WHERE NOT EXISTS (
       SELECT 1 FROM checklist_items ci
       WHERE ci.owner_type=$1 AND ci.owner_id=e.id AND ci.category=$2 AND ci.label=$3
     )
     RETURNING id`,
    [template.owner_type, category, label, template.sort_order || 0, committeeId]
  );

  const updated = await syncCommitteeForExistingItems(template.owner_type, category, label, committeeId);

  return { created: createResult.rowCount || 0, updated };
}

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
    const template = await db.get('SELECT * FROM checklist_templates WHERE id=$1', [result.id]);
    const sync = await syncTemplateToExistingEntities(template);
    logActivity(req.user, { action: 'create', entityType: 'checklist_template', entityId: result.id, label: label.trim(), details: owner_type });
    res.json({ id: result.id, sync });
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
    // If the label/category changed, also sync any existing items still
    // under the OLD label so they aren't stranded without ever having
    // received the (possibly brand-new) committee assignment being saved
    // here — then sync again under the new identity for creation/backfill.
    // Uses the committee-only helper (never creates) so a rename can't spawn
    // orphaned items under the label that's being replaced.
    if (existing.label !== label || (existing.category || '') !== category) {
      await syncCommitteeForExistingItems(existing.owner_type, existing.category, existing.label, responsible_committee_id);
    }
    const template = await db.get('SELECT * FROM checklist_templates WHERE id=$1', [req.params.id]);
    const sync = await syncTemplateToExistingEntities(template);
    logActivity(req.user, { action: 'update', entityType: 'checklist_template', entityId: Number(req.params.id), label, details: template.owner_type });
    res.json({ ok: true, sync });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const existing = await db.get('SELECT id, label, owner_type FROM checklist_templates WHERE id=$1', [req.params.id]);
    if (!existing) return res.status(404).json({ error: 'Checklist template item not found.' });
    await db.run('DELETE FROM checklist_templates WHERE id=$1', [req.params.id]);
    logActivity(req.user, { action: 'delete', entityType: 'checklist_template', entityId: Number(req.params.id), label: existing.label, details: existing.owner_type });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

module.exports = router;
