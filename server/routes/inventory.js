// Goodies & Inventory: procurement + per-recipient delivery tracking for
// physical items (kits, badges, souvenirs, merchandise, etc.). An
// inventory_items row is the stock-list entry (quantity procured, reorder
// threshold, vendor, committee responsible for it); each
// inventory_distributions row is one recipient who should receive it — who
// it was delivered to, who was assigned to deliver it, and who actually
// delivered it + when. Deliberately separate from checklist_items, which
// has no concept of quantities in stock.
const express = require('express');
const db = require('../db');
const { logActivity } = require('../lib/activityLogger');

const router = express.Router();

const RECIPIENT_TYPES = ['sponsor', 'speaker', 'guest_visitor', 'participant', 'host_member'];
const RECIPIENT_TABLES = {
  sponsor: 'sponsors',
  speaker: 'speakers',
  guest_visitor: 'guest_visitors',
  participant: 'participants',
  host_member: 'host_members'
};

// Same polymorphic-name-join pattern as deliveryMonitor.js, just renamed to
// "recipient" instead of "owner" since this is who RECEIVES the item, not
// who owns the checklist.
const RECIPIENT_NAME_JOIN = `
  LEFT JOIN sponsors rs ON d.recipient_type='sponsor' AND d.recipient_id = rs.id
  LEFT JOIN speakers rsp ON d.recipient_type='speaker' AND d.recipient_id = rsp.id
  LEFT JOIN guest_visitors rgv ON d.recipient_type='guest_visitor' AND d.recipient_id = rgv.id
  LEFT JOIN participants rp ON d.recipient_type='participant' AND d.recipient_id = rp.id
  LEFT JOIN host_members rhm ON d.recipient_type='host_member' AND d.recipient_id = rhm.id
`;
const RECIPIENT_NAME_SELECT = `COALESCE(rs.name, rsp.name, rgv.name, rp.name, rhm.name) AS recipient_name`;

// --- Item master (the stock list) ---

router.get('/', async (req, res) => {
  try {
    const rows = await db.all(`
      SELECT i.*, c.name AS responsible_committee_name,
        COALESCE(SUM(d.quantity) FILTER (WHERE d.status='delivered'), 0)::int AS quantity_distributed,
        COUNT(d.id) FILTER (WHERE d.status='pending')::int AS pending_count,
        COUNT(d.id) FILTER (WHERE d.status='delivered')::int AS delivered_count,
        COUNT(d.id) FILTER (WHERE d.status != 'cancelled')::int AS recipient_count
      FROM inventory_items i
      LEFT JOIN committees c ON c.id = i.responsible_committee_id
      LEFT JOIN inventory_distributions d ON d.inventory_item_id = i.id
      GROUP BY i.id, c.name
      ORDER BY i.category, i.name
    `);
    const withStock = rows.map((r) => {
      const remaining = r.quantity_procured - r.quantity_distributed;
      return {
        ...r,
        quantity_remaining: remaining,
        low_stock: r.reorder_threshold !== null && remaining <= r.reorder_threshold
      };
    });
    res.json(withStock);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/', async (req, res) => {
  const { name, category, unit, quantity_procured, reorder_threshold, vendor_name, unit_cost, procurement_status, responsible_committee_id, notes } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });
  try {
    const result = await db.run(`
      INSERT INTO inventory_items (name, category, unit, quantity_procured, reorder_threshold, vendor_name, unit_cost, procurement_status, responsible_committee_id, notes)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id
    `, [name.trim(), category || '', unit || 'pcs', Number(quantity_procured) || 0, reorder_threshold !== undefined && reorder_threshold !== '' ? Number(reorder_threshold) : null,
        vendor_name || '', unit_cost !== undefined && unit_cost !== '' ? Number(unit_cost) : null, procurement_status || 'planned',
        responsible_committee_id || null, notes || '']);
    logActivity(req.user, { action: 'create', entityType: 'inventory_item', entityId: result.id, label: name.trim() });
    res.json({ id: result.id });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const existing = await db.get('SELECT * FROM inventory_items WHERE id=$1', [req.params.id]);
    if (!existing) return res.status(404).json({ error: 'Inventory item not found.' });
    const body = req.body;
    const name = body.name !== undefined ? body.name.trim() : existing.name;
    const category = body.category !== undefined ? body.category : existing.category;
    const unit = body.unit !== undefined ? body.unit : existing.unit;
    const quantity_procured = body.quantity_procured !== undefined ? Number(body.quantity_procured) : existing.quantity_procured;
    const vendor_name = body.vendor_name !== undefined ? body.vendor_name : existing.vendor_name;
    const procurement_status = body.procurement_status !== undefined ? body.procurement_status : existing.procurement_status;
    const notes = body.notes !== undefined ? body.notes : existing.notes;
    // Not COALESCE'd — an explicit null/empty clears these (goes back to
    // "no threshold" / "no cost" / "Unassigned"); omitting the field leaves
    // it untouched, same pattern used throughout checklist_items/templates.
    const reorder_threshold = body.reorder_threshold !== undefined
      ? (body.reorder_threshold === '' || body.reorder_threshold === null ? null : Number(body.reorder_threshold)) : existing.reorder_threshold;
    const unit_cost = body.unit_cost !== undefined
      ? (body.unit_cost === '' || body.unit_cost === null ? null : Number(body.unit_cost)) : existing.unit_cost;
    const responsible_committee_id = body.responsible_committee_id !== undefined
      ? (body.responsible_committee_id || null) : existing.responsible_committee_id;
    if (!name) return res.status(400).json({ error: 'name cannot be empty' });
    await db.run(`
      UPDATE inventory_items SET
        name=$1, category=$2, unit=$3, quantity_procured=$4, reorder_threshold=$5, vendor_name=$6,
        unit_cost=$7, procurement_status=$8, responsible_committee_id=$9, notes=$10, updated_at=NOW()
      WHERE id=$11
    `, [name, category, unit, quantity_procured, reorder_threshold, vendor_name, unit_cost, procurement_status, responsible_committee_id, notes, req.params.id]);
    logActivity(req.user, { action: 'update', entityType: 'inventory_item', entityId: Number(req.params.id), label: name });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const existing = await db.get('SELECT name FROM inventory_items WHERE id=$1', [req.params.id]);
    if (!existing) return res.status(404).json({ error: 'Inventory item not found.' });
    await db.run('DELETE FROM inventory_items WHERE id=$1', [req.params.id]);
    logActivity(req.user, { action: 'delete', entityType: 'inventory_item', entityId: Number(req.params.id), label: existing.name });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// --- Per-recipient distributions ("who it was delivered to") ---
// NOTE: literal paths (/monitor, /monitor/summary, /distributions/:id) are
// registered BEFORE /:id/distributions and /:id below where there's any
// ambiguity, so they're never swallowed as an :id value — same lesson
// learned from checklistHelper.js/deliveryMonitor.js route ordering.

router.get('/:itemId/distributions', async (req, res) => {
  try {
    const rows = await db.all(`
      SELECT d.*, ${RECIPIENT_NAME_SELECT}, am.name AS assigned_host_member_name, dm.name AS delivered_by_name
      FROM inventory_distributions d
      ${RECIPIENT_NAME_JOIN}
      LEFT JOIN host_members am ON am.id = d.assigned_host_member_id
      LEFT JOIN host_members dm ON dm.id = d.delivered_by_host_member_id
      WHERE d.inventory_item_id=$1
      ORDER BY d.id
    `, [req.params.itemId]);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/:itemId/distributions', async (req, res) => {
  const { recipient_type, recipient_id, quantity, assigned_host_member_id, notes } = req.body;
  if (!RECIPIENT_TYPES.includes(recipient_type)) {
    return res.status(400).json({ error: `recipient_type must be one of: ${RECIPIENT_TYPES.join(', ')}` });
  }
  if (!recipient_id) return res.status(400).json({ error: 'recipient_id is required' });
  try {
    const result = await db.run(`
      INSERT INTO inventory_distributions (inventory_item_id, recipient_type, recipient_id, quantity, assigned_host_member_id, notes)
      VALUES ($1,$2,$3,$4,$5,$6) RETURNING id
    `, [req.params.itemId, recipient_type, recipient_id, Number(quantity) || 1, assigned_host_member_id || null, notes || '']);
    res.json({ id: result.id });
  } catch (e) {
    if (e.message && e.message.includes('inventory_distributions_inventory_item_id_recipient_type_recipient_id_key')) {
      return res.status(400).json({ error: 'This recipient already has a delivery record for this item.' });
    }
    res.status(400).json({ error: e.message });
  }
});

// Bulk-assign one item to EVERY current entity of a recipient_type (e.g.
// "Congress Kit" -> every delegate) in one action, the same "quick add all"
// pattern used for checklist templates. Skips anyone who already has a
// distribution record for this item so it can be safely re-run as new
// entities are added, without creating duplicates.
router.post('/:itemId/distributions/bulk', async (req, res) => {
  const { recipient_type, quantity, assigned_host_member_id } = req.body;
  if (!RECIPIENT_TYPES.includes(recipient_type)) {
    return res.status(400).json({ error: `recipient_type must be one of: ${RECIPIENT_TYPES.join(', ')}` });
  }
  const table = RECIPIENT_TABLES[recipient_type];
  try {
    const result = await db.run(`
      INSERT INTO inventory_distributions (inventory_item_id, recipient_type, recipient_id, quantity, assigned_host_member_id)
      SELECT $1, $2, e.id, $3, $4
      FROM ${table} e
      WHERE NOT EXISTS (
        SELECT 1 FROM inventory_distributions d WHERE d.inventory_item_id=$1 AND d.recipient_type=$2 AND d.recipient_id=e.id
      )
      RETURNING id
    `, [req.params.itemId, recipient_type, Number(quantity) || 1, assigned_host_member_id || null]);
    res.json({ created: result.rowCount });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.put('/distributions/:id', async (req, res) => {
  try {
    const existing = await db.get('SELECT * FROM inventory_distributions WHERE id=$1', [req.params.id]);
    if (!existing) return res.status(404).json({ error: 'Distribution record not found.' });
    const body = req.body;
    const quantity = body.quantity !== undefined ? Number(body.quantity) : existing.quantity;
    const notes = body.notes !== undefined ? body.notes : existing.notes;
    // Not COALESCE'd — explicit null clears the assignment; omitting leaves it untouched.
    const assigned_host_member_id = body.assigned_host_member_id !== undefined
      ? (body.assigned_host_member_id || null) : existing.assigned_host_member_id;
    const status = body.status !== undefined ? body.status : existing.status;

    // Delivered-by + delivered-at is a stamped audit trail, not a plain
    // field: it's set automatically on the pending -> delivered transition
    // (defaulting to whoever was assigned, since that's usually who
    // actually did it — overridable if a stand-in delivered instead), and
    // cleared if the item is reopened back to pending/cancelled.
    let delivered_by_host_member_id = existing.delivered_by_host_member_id;
    let delivered_at = existing.delivered_at;
    if (status === 'delivered' && existing.status !== 'delivered') {
      delivered_by_host_member_id = body.delivered_by_host_member_id !== undefined
        ? (body.delivered_by_host_member_id || null)
        : (assigned_host_member_id || null);
      delivered_at = new Date();
    } else if (status !== 'delivered' && existing.status === 'delivered') {
      delivered_by_host_member_id = null;
      delivered_at = null;
    } else if (body.delivered_by_host_member_id !== undefined) {
      delivered_by_host_member_id = body.delivered_by_host_member_id || null;
    }

    await db.run(`
      UPDATE inventory_distributions SET
        quantity=$1, notes=$2, assigned_host_member_id=$3, status=$4,
        delivered_by_host_member_id=$5, delivered_at=$6, updated_at=NOW()
      WHERE id=$7
    `, [quantity, notes, assigned_host_member_id, status, delivered_by_host_member_id, delivered_at, req.params.id]);
    if (status === 'delivered' && existing.status !== 'delivered') {
      const item = await db.get('SELECT name FROM inventory_items WHERE id=$1', [existing.inventory_item_id]);
      logActivity(req.user, { action: 'deliver', entityType: 'inventory_distribution', entityId: Number(req.params.id), label: item?.name, details: `to ${existing.recipient_type} #${existing.recipient_id}` });
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.delete('/distributions/:id', async (req, res) => {
  await db.run('DELETE FROM inventory_distributions WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

// --- Cross-item, cross-committee monitor (mirrors deliveryMonitor.js) ---

router.get('/monitor/summary', async (req, res) => {
  try {
    const rows = await db.all(`
      SELECT c.id AS committee_id, c.name AS committee_name,
        COUNT(d.id)::int AS total,
        COUNT(*) FILTER (WHERE d.status='delivered')::int AS delivered,
        COUNT(*) FILTER (WHERE d.status='pending')::int AS pending
      FROM inventory_distributions d
      JOIN inventory_items i ON i.id = d.inventory_item_id
      LEFT JOIN committees c ON c.id = i.responsible_committee_id
      WHERE d.status != 'cancelled'
      GROUP BY c.id, c.name
      ORDER BY c.name IS NULL, c.name
    `);
    res.json(rows.map((r) => ({ ...r, completion_pct: r.total > 0 ? Math.round((r.delivered / r.total) * 100) : null })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/monitor', async (req, res) => {
  try {
    const { committee_id, status, recipient_type, inventory_item_id } = req.query;
    const conditions = [];
    const params = [];
    if (committee_id !== undefined && committee_id !== '') {
      if (committee_id === 'unassigned') {
        conditions.push('i.responsible_committee_id IS NULL');
      } else {
        params.push(committee_id);
        conditions.push(`i.responsible_committee_id = $${params.length}`);
      }
    }
    if (status) { params.push(status); conditions.push(`d.status = $${params.length}`); }
    if (recipient_type) { params.push(recipient_type); conditions.push(`d.recipient_type = $${params.length}`); }
    if (inventory_item_id) { params.push(inventory_item_id); conditions.push(`d.inventory_item_id = $${params.length}`); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = await db.all(`
      SELECT d.*, i.name AS item_name, i.category AS item_category,
        c.name AS committee_name, ${RECIPIENT_NAME_SELECT},
        am.name AS assigned_host_member_name, dm.name AS delivered_by_name
      FROM inventory_distributions d
      JOIN inventory_items i ON i.id = d.inventory_item_id
      LEFT JOIN committees c ON c.id = i.responsible_committee_id
      ${RECIPIENT_NAME_JOIN}
      LEFT JOIN host_members am ON am.id = d.assigned_host_member_id
      LEFT JOIN host_members dm ON dm.id = d.delivered_by_host_member_id
      ${where}
      ORDER BY (d.status='pending') DESC, d.id
    `, params);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
