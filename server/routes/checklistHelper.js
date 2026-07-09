// Shared, generic "customizable checklist" wiring reused across Sponsors
// (benefit checklist), Speakers (what must reach them / be done for them),
// Guest Visitors (offerings), and — for the goodies/kit handover tracker —
// Participants and Host Members. All of them are just checklist_items rows
// distinguished by owner_type + owner_id (see server/db.js). Keeping this in
// one place means the checklist behavior (add/edit/remove arbitrary items)
// stays identical everywhere instead of drifting per entity.
//
// Delivery accountability: every item can carry a responsible_committee_id
// (who's actually handing this over — e.g. Welcome Kit -> Welcome &
// Registration Committee), a due_date, and — once marked done — who closed
// it out and when (completed_by_user_id / completed_at). See
// server/routes/deliveryMonitor.js for the cross-committee dashboard this
// feeds.
const db = require('../db');
const { logActivity } = require('../lib/activityLogger');

const SELECT_WITH_COMMITTEE = `
  SELECT ci.*, c.name AS responsible_committee_name, u.username AS completed_by_username
  FROM checklist_items ci
  LEFT JOIN committees c ON c.id = ci.responsible_committee_id
  LEFT JOIN users u ON u.id = ci.completed_by_user_id
`;

// Call from an owner's own route file (sponsors.js, speakers.js, etc.) to add
// GET/POST nested checklist routes under its existing :id-based router, e.g.
// GET/POST /api/sponsors/:id/checklist
function attachChecklistRoutes(router, ownerType) {
  router.get('/:id/checklist', async (req, res) => {
    try {
      const rows = await db.all(
        `${SELECT_WITH_COMMITTEE} WHERE ci.owner_type=$1 AND ci.owner_id=$2 ORDER BY ci.sort_order, ci.id`,
        [ownerType, req.params.id]
      );
      res.json(rows);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post('/:id/checklist', async (req, res) => {
    const { label, category, status, sort_order, notes, responsible_committee_id, due_date } = req.body;
    if (!label || !label.trim()) return res.status(400).json({ error: 'label is required' });
    try {
      const result = await db.run(`
        INSERT INTO checklist_items (owner_type, owner_id, category, label, status, sort_order, notes, responsible_committee_id, due_date)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id
      `, [ownerType, req.params.id, category || '', label.trim(), status || 'pending', Number(sort_order) || 0,
          notes || '', responsible_committee_id || null, due_date || null]);
      logActivity(req.user, { action: 'create', entityType: 'checklist_item', entityId: result.id, label: label.trim(), details: `${ownerType} #${req.params.id}` });
      res.json({ id: result.id });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // Convenience: add several items in one call (used by "quick add from
  // template" buttons in the admin UI). Each item can carry over its
  // template's default responsible_committee_id — still just free-text
  // labels otherwise, nothing enforced at the DB level.
  //
  // Skips any label this owner already has a checklist item for. Without
  // this, clicking "Add all suggested items" a second time — or saving a
  // master template (which now auto-creates its item on every existing
  // owner; see checklistTemplates.js) followed by a manual "add all" click —
  // would insert a second, duplicate row for the same label.
  router.post('/:id/checklist/bulk', async (req, res) => {
    const { items } = req.body; // [{ label, category, responsible_committee_id }, ...]
    if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'items array is required' });
    try {
      const ids = [];
      for (const item of items) {
        if (!item || !item.label || !item.label.trim()) continue;
        const result = await db.run(`
          INSERT INTO checklist_items (owner_type, owner_id, category, label, status, responsible_committee_id)
          SELECT $1,$2,$3,$4,'pending',$5
          WHERE NOT EXISTS (
            SELECT 1 FROM checklist_items WHERE owner_type=$1 AND owner_id=$2 AND category=$3 AND label=$4
          )
          RETURNING id
        `, [ownerType, req.params.id, item.category || '', item.label.trim(), item.responsible_committee_id || null]);
        if (result.id !== undefined) ids.push(result.id);
      }
      res.json({ ids });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });
}

// Deletes every checklist row for one owner instance — call this from an
// owner's DELETE /:id route before/alongside deleting the owner row itself,
// since checklist_items has no DB-level FK to clean up automatically.
async function deleteChecklistForOwner(ownerType, ownerId) {
  await db.run('DELETE FROM checklist_items WHERE owner_type=$1 AND owner_id=$2', [ownerType, ownerId]);
}

// Mounted once, standalone, at /api/checklist-items — edit/reorder/delete a
// single item by its own id, shared across every owner type since item ids
// are globally unique regardless of which owner they belong to. Also hosts
// the cross-committee Delivery Monitor endpoints (registered before the
// /:itemId routes so literal paths like /monitor aren't swallowed as ids).
const BULK_ASSIGN_OWNER_TYPES = ['sponsor', 'speaker', 'guest_visitor', 'participant', 'host_member'];

function buildChecklistItemsRouter() {
  const express = require('express');
  const router = express.Router();
  const { attachDeliveryMonitorRoutes } = require('./deliveryMonitor');

  attachDeliveryMonitorRoutes(router);

  // Hand-picked bulk assign: one checklist item -> many owners of the same
  // type in a single call, instead of opening each Sponsor/Speaker/Guest
  // Visitor/Delegate/Host Member one at a time and adding the item there.
  // This is a separate, one-off action from Master Checklist Templates
  // (which auto-syncs onto EVERY existing owner of a type on save/edit) —
  // here the admin explicitly picks which owner_ids get it, right now.
  // Registered before /:itemId so the literal path isn't swallowed as an id.
  router.post('/bulk-assign', async (req, res) => {
    const { owner_type, owner_ids, label, category, responsible_committee_id, due_date } = req.body;
    if (!BULK_ASSIGN_OWNER_TYPES.includes(owner_type)) {
      return res.status(400).json({ error: 'Invalid owner_type' });
    }
    if (!Array.isArray(owner_ids) || !owner_ids.length) {
      return res.status(400).json({ error: 'owner_ids array is required' });
    }
    if (!label || !label.trim()) return res.status(400).json({ error: 'label is required' });
    try {
      const ids = [];
      for (const ownerId of owner_ids) {
        const result = await db.run(`
          INSERT INTO checklist_items (owner_type, owner_id, category, label, status, responsible_committee_id, due_date)
          SELECT $1,$2,$3,$4,'pending',$5,$6
          WHERE NOT EXISTS (
            SELECT 1 FROM checklist_items WHERE owner_type=$1 AND owner_id=$2 AND category=$3 AND label=$4
          )
          RETURNING id
        `, [owner_type, ownerId, category || '', label.trim(), responsible_committee_id || null, due_date || null]);
        if (result.id !== undefined) ids.push(result.id);
      }
      res.json({ created: ids.length, skipped: owner_ids.length - ids.length, ids });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  router.put('/:itemId', async (req, res) => {
    const body = req.body;
    try {
      const existing = await db.get('SELECT * FROM checklist_items WHERE id=$1', [req.params.itemId]);
      if (!existing) return res.status(404).json({ error: 'Checklist item not found.' });

      const label = body.label !== undefined && body.label.trim() ? body.label.trim() : existing.label;
      const category = body.category !== undefined ? body.category : existing.category;
      const status = body.status !== undefined ? body.status : existing.status;
      const sort_order = body.sort_order !== undefined ? Number(body.sort_order) : existing.sort_order;
      const notes = body.notes !== undefined ? body.notes : existing.notes;
      // responsible_committee_id and due_date are NOT wrapped in COALESCE —
      // sending an explicit null clears them (e.g. "unassign committee"),
      // while simply omitting the field leaves the existing value alone.
      const responsible_committee_id = body.responsible_committee_id !== undefined
        ? (body.responsible_committee_id || null) : existing.responsible_committee_id;
      const due_date = body.due_date !== undefined ? (body.due_date || null) : existing.due_date;

      // Track who closed an item out and when, without letting an unrelated
      // edit (e.g. just changing the due date) wipe that history. Moving an
      // item back off "done" clears the completion stamp again.
      let completed_by_user_id = existing.completed_by_user_id;
      let completed_at = existing.completed_at;
      if (status === 'done' && existing.status !== 'done') {
        completed_by_user_id = req.user ? req.user.id : null;
        completed_at = new Date();
      } else if (status !== 'done' && existing.status === 'done') {
        completed_by_user_id = null;
        completed_at = null;
      }

      await db.run(`
        UPDATE checklist_items SET
          label=$1, category=$2, status=$3, sort_order=$4, notes=$5,
          responsible_committee_id=$6, due_date=$7, completed_by_user_id=$8, completed_at=$9, updated_at=NOW()
        WHERE id=$10
      `, [label, category, status, sort_order, notes, responsible_committee_id, due_date, completed_by_user_id, completed_at, req.params.itemId]);
      const justCompleted = status === 'done' && existing.status !== 'done';
      logActivity(req.user, {
        action: justCompleted ? 'complete' : 'update',
        entityType: 'checklist_item',
        entityId: Number(req.params.itemId),
        label,
        details: `${existing.owner_type} #${existing.owner_id}`
      });
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  router.delete('/:itemId', async (req, res) => {
    const existing = await db.get('SELECT label, owner_type, owner_id FROM checklist_items WHERE id=$1', [req.params.itemId]);
    await db.run('DELETE FROM checklist_items WHERE id=$1', [req.params.itemId]);
    logActivity(req.user, { action: 'delete', entityType: 'checklist_item', entityId: Number(req.params.itemId), label: existing?.label, details: existing ? `${existing.owner_type} #${existing.owner_id}` : undefined });
    res.json({ ok: true });
  });

  return router;
}

module.exports = { attachChecklistRoutes, deleteChecklistForOwner, buildChecklistItemsRouter, SELECT_WITH_COMMITTEE };
