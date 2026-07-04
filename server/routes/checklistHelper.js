// Shared, generic "customizable checklist" wiring reused across Sponsors
// (benefit checklist), Speakers (what must reach them / be done for them),
// Guest Visitors (offerings), and — for the goodies/kit handover tracker —
// Participants and Host Members. All of them are just checklist_items rows
// distinguished by owner_type + owner_id (see server/db.js). Keeping this in
// one place means the checklist behavior (add/edit/remove arbitrary items)
// stays identical everywhere instead of drifting per entity.
const db = require('../db');

// Call from an owner's own route file (sponsors.js, speakers.js, etc.) to add
// GET/POST nested checklist routes under its existing :id-based router, e.g.
// GET/POST /api/sponsors/:id/checklist
function attachChecklistRoutes(router, ownerType) {
  router.get('/:id/checklist', async (req, res) => {
    try {
      const rows = await db.all(
        'SELECT * FROM checklist_items WHERE owner_type=$1 AND owner_id=$2 ORDER BY sort_order, id',
        [ownerType, req.params.id]
      );
      res.json(rows);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post('/:id/checklist', async (req, res) => {
    const { label, category, status, sort_order, notes } = req.body;
    if (!label || !label.trim()) return res.status(400).json({ error: 'label is required' });
    try {
      const result = await db.run(`
        INSERT INTO checklist_items (owner_type, owner_id, category, label, status, sort_order, notes)
        VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id
      `, [ownerType, req.params.id, category || '', label.trim(), status || 'pending', Number(sort_order) || 0, notes || '']);
      res.json({ id: result.id });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // Convenience: add several items in one call (used by "quick add from
  // template" buttons in the admin UI — still just free-text labels, nothing
  // enforced or hardcoded at the DB level).
  router.post('/:id/checklist/bulk', async (req, res) => {
    const { items } = req.body; // [{ label, category }, ...]
    if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'items array is required' });
    try {
      const ids = [];
      for (const item of items) {
        if (!item || !item.label || !item.label.trim()) continue;
        const result = await db.run(`
          INSERT INTO checklist_items (owner_type, owner_id, category, label, status)
          VALUES ($1,$2,$3,$4,'pending') RETURNING id
        `, [ownerType, req.params.id, item.category || '', item.label.trim()]);
        ids.push(result.id);
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
// are globally unique regardless of which owner they belong to.
function buildChecklistItemsRouter() {
  const express = require('express');
  const router = express.Router();

  router.put('/:itemId', async (req, res) => {
    const { label, category, status, sort_order, notes } = req.body;
    try {
      await db.run(`
        UPDATE checklist_items SET
          label=COALESCE($1,label), category=COALESCE($2,category), status=COALESCE($3,status),
          sort_order=COALESCE($4,sort_order), notes=COALESCE($5,notes), updated_at=NOW()
        WHERE id=$6
      `, [label || null, category !== undefined ? category : null, status || null,
          sort_order !== undefined ? Number(sort_order) : null, notes !== undefined ? notes : null, req.params.itemId]);
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  router.delete('/:itemId', async (req, res) => {
    await db.run('DELETE FROM checklist_items WHERE id=$1', [req.params.itemId]);
    res.json({ ok: true });
  });

  return router;
}

module.exports = { attachChecklistRoutes, deleteChecklistForOwner, buildChecklistItemsRouter };
