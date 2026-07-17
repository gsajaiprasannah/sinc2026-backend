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
const { createApprovalRows } = require('../lib/financeHelper');

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

// Minimal Committee/Vendor lookups for the item form's "Responsible
// committee" and "Vendor (from master)" dropdowns — the Goodies & Inventory
// module doesn't otherwise grant access to the Committees or Vendor
// Management admin data, so these expose just id+name (nothing sensitive).
// Registered before any /:id-shaped routes so the literal paths are never
// swallowed as an id.
router.get('/committees-lite', async (req, res) => {
  try {
    const rows = await db.all(`SELECT id, name FROM committees ORDER BY name`);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
router.get('/vendors-lite', async (req, res) => {
  try {
    const rows = await db.all(`SELECT id, name, category FROM vendors ORDER BY name`);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Minimal per-recipient-type name lookups for the distribution modal's
// "Add one recipient" / bulk-assign forms — same reasoning as committees-lite/
// vendors-lite above: a committee only granted Goodies & Inventory (not the
// separate Sponsors/Guest Speakers/Guest Visitors/Delegate Registrations
// admin data) still needs real names to record a delivery against, instead
// of a raw numeric id. host-members-lite doubles as both a recipient list
// (recipient_type='host_member') and the assigned/delivered-by picker.
router.get('/sponsors-lite', async (req, res) => {
  try {
    const rows = await db.all(`SELECT id, name FROM sponsors ORDER BY name`);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
router.get('/speakers-lite', async (req, res) => {
  try {
    const rows = await db.all(`SELECT id, name FROM speakers ORDER BY name`);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
router.get('/guestvisitors-lite', async (req, res) => {
  try {
    const rows = await db.all(`SELECT id, name FROM guest_visitors ORDER BY name`);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
router.get('/participants-lite', async (req, res) => {
  try {
    const rows = await db.all(`
      SELECT p.id, p.name, p.participant_code, c.name AS club_name
      FROM participants p LEFT JOIN clubs c ON c.id = p.club_id
      ORDER BY p.name
    `);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
router.get('/host-members-lite', async (req, res) => {
  try {
    const rows = await db.all(`SELECT id, name, company FROM host_members ORDER BY name`);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Merchandise Requirement ---
// Rolls up how many Shirt-size / T-Shirt-size units are needed for
// procurement, counted from the shirt_size/tshirt_size fields collected on
// Delegates (participants) and Host Members — kept as two separate totals
// since they're typically ordered/handed out separately. Surfaced as a
// chart in the Goodies & Inventory tab so whoever's placing the merchandise
// order can see exact per-size counts without exporting a spreadsheet.
const MERCH_SIZE_ORDER = ['XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL'];
async function merchSizeBreakdown(table, column) {
  const rows = await db.all(`
    SELECT ${column} AS size, COUNT(*)::int AS n
    FROM ${table}
    WHERE ${column} IS NOT NULL AND ${column} <> ''
    GROUP BY ${column}
  `);
  const map = {};
  rows.forEach((r) => { map[r.size] = Number(r.n); });
  const known = MERCH_SIZE_ORDER.filter((s) => map[s]).map((size) => ({ size, count: map[size] }));
  const other = Object.keys(map).filter((s) => !MERCH_SIZE_ORDER.includes(s)).sort()
    .map((size) => ({ size, count: map[size] }));
  return [...known, ...other];
}
router.get('/merchandise-requirement', async (req, res) => {
  try {
    const [delegateShirt, delegateTee, hostShirt, hostTee] = await Promise.all([
      merchSizeBreakdown('participants', 'shirt_size'),
      merchSizeBreakdown('participants', 'tshirt_size'),
      merchSizeBreakdown('host_members', 'shirt_size'),
      merchSizeBreakdown('host_members', 'tshirt_size'),
    ]);
    const delegateTotal = (await db.get('SELECT COUNT(*)::int AS n FROM participants')).n;
    const hostTotal = (await db.get('SELECT COUNT(*)::int AS n FROM host_members')).n;
    const delegateSized = (await db.get(`SELECT COUNT(*)::int AS n FROM participants WHERE shirt_size IS NOT NULL AND shirt_size <> '' OR tshirt_size IS NOT NULL AND tshirt_size <> ''`)).n;
    const hostSized = (await db.get(`SELECT COUNT(*)::int AS n FROM host_members WHERE shirt_size IS NOT NULL AND shirt_size <> '' OR tshirt_size IS NOT NULL AND tshirt_size <> ''`)).n;
    res.json({
      delegates: { total: delegateTotal, sizesOnFile: delegateSized, shirt: delegateShirt, tshirt: delegateTee },
      hostMembers: { total: hostTotal, sizesOnFile: hostSized, shirt: hostShirt, tshirt: hostTee },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Per-person breakdown of exactly who has which Shirt/T-Shirt size on file —
// the answer to "who chose what size", so whoever's packing/handing out
// merchandise doesn't have to cross-reference the full Delegates/Host
// Members lists every time. Only rows with at least one size filled in are
// returned (matches the "sizesOnFile" counts on /merchandise-requirement).
router.get('/merchandise-size-list', async (req, res) => {
  try {
    const rows = await db.all(`
      SELECT 'Delegate' AS type, p.name, p.phone, c.name AS club_or_company, p.shirt_size, p.tshirt_size
      FROM participants p
      LEFT JOIN clubs c ON c.id = p.club_id
      WHERE (p.shirt_size IS NOT NULL AND p.shirt_size <> '') OR (p.tshirt_size IS NOT NULL AND p.tshirt_size <> '')
      UNION ALL
      SELECT 'Host Member' AS type, h.name, h.phone, h.company AS club_or_company, h.shirt_size, h.tshirt_size
      FROM host_members h
      WHERE (h.shirt_size IS NOT NULL AND h.shirt_size <> '') OR (h.tshirt_size IS NOT NULL AND h.tshirt_size <> '')
      ORDER BY type, name
    `);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Requirements: procurement asks that flow through to a real Finance
// Purchase Request. Distinct from inventory_items (the stock list) — a
// requirement doesn't track stock of its own, it's just something someone
// needs, waiting for the Purchase team to either raise a PR for it or
// dismiss it. Registered before the /:id-shaped inventory_items routes
// below so literal paths are never swallowed as an id.
router.get('/requirements', async (req, res) => {
  try {
    const rows = await db.all(`
      SELECT r.*, ft.status AS purchase_request_status, u.username AS raised_by_username
      FROM inventory_requirements r
      LEFT JOIN finance_transactions ft ON ft.id = r.purchase_request_id
      LEFT JOIN users u ON u.id = r.raised_by
      ORDER BY (r.status = 'open') DESC, r.category, r.size NULLS FIRST, r.item_name
    `);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/requirements', async (req, res) => {
  const { item_name, category, size, quantity_needed, unit, notes } = req.body;
  if (!item_name || !item_name.trim()) return res.status(400).json({ error: 'item_name is required' });
  const qty = Number(quantity_needed) || 0;
  if (qty <= 0) return res.status(400).json({ error: 'A positive quantity_needed is required' });
  try {
    const result = await db.run(`
      INSERT INTO inventory_requirements (item_name, category, size, quantity_needed, unit, source, status, notes, raised_by)
      VALUES ($1,$2,$3,$4,$5,'manual','open',$6,$7) RETURNING id
    `, [item_name.trim(), category || 'General', size || null, qty, unit || 'pcs', notes || '', req.user?.id || null]);
    logActivity(req.user, { action: 'create', entityType: 'inventory_requirement', entityId: result.id, label: item_name.trim() });
    res.json({ id: result.id });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.put('/requirements/:id', async (req, res) => {
  try {
    const existing = await db.get('SELECT * FROM inventory_requirements WHERE id=$1', [req.params.id]);
    if (!existing) return res.status(404).json({ error: 'Requirement not found.' });
    const { item_name, category, size, quantity_needed, unit, notes, status } = req.body;
    if (status && !['open', 'requested', 'fulfilled', 'cancelled'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }
    await db.run(`
      UPDATE inventory_requirements SET
        item_name=COALESCE($1,item_name), category=COALESCE($2,category), size=$3,
        quantity_needed=COALESCE($4,quantity_needed), unit=COALESCE($5,unit),
        notes=COALESCE($6,notes), status=COALESCE($7,status), updated_at=NOW()
      WHERE id=$8
    `, [item_name || null, category || null, size !== undefined ? (size || null) : existing.size,
        quantity_needed !== undefined && quantity_needed !== '' ? Number(quantity_needed) : null,
        unit || null, notes !== undefined ? notes : null, status || null, req.params.id]);
    logActivity(req.user, { action: 'update', entityType: 'inventory_requirement', entityId: Number(req.params.id) });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.delete('/requirements/:id', async (req, res) => {
  try {
    const existing = await db.get('SELECT item_name FROM inventory_requirements WHERE id=$1', [req.params.id]);
    if (!existing) return res.status(404).json({ error: 'Requirement not found.' });
    await db.run('DELETE FROM inventory_requirements WHERE id=$1', [req.params.id]);
    logActivity(req.user, { action: 'delete', entityType: 'inventory_requirement', entityId: Number(req.params.id), label: existing.item_name });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Recomputes the Delegate/Host Member shirt & T-shirt size totals (same
// numbers as GET /merchandise-requirement) and upserts them into
// inventory_requirements as source='auto-merchandise' rows, one per
// (category, size). Safe to re-run: an existing row for a bucket that's
// still 'open' gets its quantity refreshed in place; a bucket already moved
// to 'requested'/'fulfilled'/'cancelled' by the Purchase team is left
// completely untouched so re-syncing can't silently reopen or resize
// something they've already actioned. A bucket that drops to zero (e.g.
// everyone in that size updated their info) is removed, but only while
// still 'open'.
const MERCH_GROUPS = [
  { table: 'participants', column: 'shirt_size', category: 'Merchandise – Shirt – Delegates', label: 'Shirt' },
  { table: 'participants', column: 'tshirt_size', category: 'Merchandise – Tee – Delegates', label: 'Tee' },
  { table: 'host_members', column: 'shirt_size', category: 'Merchandise – Shirt – Host Members', label: 'Shirt' },
  { table: 'host_members', column: 'tshirt_size', category: 'Merchandise – Tee – Host Members', label: 'Tee' },
];
router.post('/requirements/sync-merchandise', async (req, res) => {
  try {
    let created = 0, updated = 0, skipped = 0;
    const keptIds = [];
    for (const group of MERCH_GROUPS) {
      const breakdown = await merchSizeBreakdown(group.table, group.column);
      for (const { size, count } of breakdown) {
        const existing = await db.get(
          `SELECT id, status FROM inventory_requirements WHERE source='auto-merchandise' AND category=$1 AND size=$2`,
          [group.category, size]
        );
        if (existing) {
          keptIds.push(existing.id);
          if (existing.status === 'open') {
            await db.run(`UPDATE inventory_requirements SET quantity_needed=$1, updated_at=NOW() WHERE id=$2`, [count, existing.id]);
            updated++;
          } else {
            skipped++;
          }
        } else {
          const result = await db.run(`
            INSERT INTO inventory_requirements (item_name, category, size, quantity_needed, unit, source, status)
            VALUES ($1,$2,$3,$4,'pcs','auto-merchandise','open') RETURNING id
          `, [`${group.label} size ${size}`, group.category, size, count]);
          keptIds.push(result.id);
          created++;
        }
      }
    }
    if (keptIds.length) {
      await db.run(
        `DELETE FROM inventory_requirements WHERE source='auto-merchandise' AND status='open' AND id NOT IN (${keptIds.map((_, i) => `$${i + 1}`).join(',')})`,
        keptIds
      );
    } else {
      await db.run(`DELETE FROM inventory_requirements WHERE source='auto-merchandise' AND status='open'`);
    }
    res.json({ ok: true, created, updated, skipped });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Turns an open requirement into a real Finance Purchase Request — the same
// underlying finance_transactions row that POST /api/finance/purchases
// creates, just pre-filled from the requirement so the Purchase team doesn't
// have to re-type what's already there. Requires a unit cost (needed to
// compute the PR amount); vendor + expected delivery date are optional.
router.post('/requirements/:id/raise-purchase-request', async (req, res) => {
  const { purchase_unit_cost, vendor_id, expected_delivery_date, payee_or_payer, notes } = req.body;
  const unitCost = Number(purchase_unit_cost) || 0;
  if (unitCost <= 0) return res.status(400).json({ error: 'A positive purchase_unit_cost is required' });
  try {
    const reqRow = await db.get('SELECT * FROM inventory_requirements WHERE id=$1', [req.params.id]);
    if (!reqRow) return res.status(404).json({ error: 'Requirement not found.' });
    if (reqRow.purchase_request_id) return res.status(409).json({ error: 'A purchase request has already been raised for this requirement.' });
    let payee = payee_or_payer || '';
    if (vendor_id && !payee.trim()) {
      const v = await db.get('SELECT name FROM vendors WHERE id=$1', [vendor_id]);
      if (v) payee = v.name;
    }
    const amount = reqRow.quantity_needed * unitCost;
    const itemLabel = reqRow.size ? `${reqRow.item_name} (${reqRow.size})` : reqRow.item_name;
    const result = await db.run(`
      INSERT INTO finance_transactions (
        type, subtype, category, payee_or_payer, amount, description, status, notes,
        purchase_item_name, purchase_category, purchase_unit, purchase_quantity, purchase_unit_cost, created_by,
        vendor_id, expected_delivery_date
      )
      VALUES ('outward','purchase',$1,$2,$3,$4,'pending_approval',$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id
    `, [
      reqRow.category, payee, amount, `Raised from requirement: ${itemLabel}`, notes || reqRow.notes || '',
      itemLabel, reqRow.category, reqRow.unit, reqRow.quantity_needed, unitCost, req.user?.id || null,
      vendor_id || null, expected_delivery_date || null
    ]);
    await createApprovalRows(result.id, 'purchase');
    await db.run(`UPDATE inventory_requirements SET status='requested', purchase_request_id=$1, updated_at=NOW() WHERE id=$2`, [result.id, req.params.id]);
    logActivity(req.user, { action: 'create', entityType: 'finance_purchase_request', entityId: result.id, label: itemLabel });
    res.json({ id: result.id, purchase_request_id: result.id });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/', async (req, res) => {
  const { name, category, unit, quantity_procured, reorder_threshold, vendor_name, unit_cost, procurement_status, responsible_committee_id, notes, vendor_id, expected_delivery_date } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });
  try {
    // If a vendor master is picked, auto-fill the free-text vendor_name from
    // it unless one was typed explicitly — same back-compat approach as
    // finance.js's purchase requests.
    let vendorName = vendor_name || '';
    if (vendor_id && !vendorName.trim()) {
      const v = await db.get('SELECT name FROM vendors WHERE id=$1', [vendor_id]);
      if (v) vendorName = v.name;
    }
    const result = await db.run(`
      INSERT INTO inventory_items (name, category, unit, quantity_procured, reorder_threshold, vendor_name, unit_cost, procurement_status, responsible_committee_id, notes, vendor_id, expected_delivery_date)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id
    `, [name.trim(), category || '', unit || 'pcs', Number(quantity_procured) || 0, reorder_threshold !== undefined && reorder_threshold !== '' ? Number(reorder_threshold) : null,
        vendorName, unit_cost !== undefined && unit_cost !== '' ? Number(unit_cost) : null, procurement_status || 'planned',
        responsible_committee_id || null, notes || '', vendor_id || null, expected_delivery_date || null]);
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
    const vendor_id = body.vendor_id !== undefined ? (body.vendor_id || null) : existing.vendor_id;
    const expected_delivery_date = body.expected_delivery_date !== undefined ? (body.expected_delivery_date || null) : existing.expected_delivery_date;
    const actual_delivery_date = body.actual_delivery_date !== undefined ? (body.actual_delivery_date || null) : existing.actual_delivery_date;
    if (!name) return res.status(400).json({ error: 'name cannot be empty' });
    await db.run(`
      UPDATE inventory_items SET
        name=$1, category=$2, unit=$3, quantity_procured=$4, reorder_threshold=$5, vendor_name=$6,
        unit_cost=$7, procurement_status=$8, responsible_committee_id=$9, notes=$10, vendor_id=$11,
        expected_delivery_date=$12, actual_delivery_date=$13, updated_at=NOW()
      WHERE id=$14
    `, [name, category, unit, quantity_procured, reorder_threshold, vendor_name, unit_cost, procurement_status, responsible_committee_id, notes,
        vendor_id, expected_delivery_date, actual_delivery_date, req.params.id]);
    logActivity(req.user, { action: 'update', entityType: 'inventory_item', entityId: Number(req.params.id), label: name });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Admin-side quick update of just an item's delivery progress — same effect
// as the vendor's own PUT /vendor/orders/inventory/:id/delivery, just also
// reachable by an admin tracking it on the vendor's behalf.
router.put('/:id/delivery', async (req, res) => {
  const { procurement_status, expected_delivery_date, actual_delivery_date } = req.body;
  try {
    const existing = await db.get('SELECT id FROM inventory_items WHERE id=$1', [req.params.id]);
    if (!existing) return res.status(404).json({ error: 'Inventory item not found.' });
    await db.run(`
      UPDATE inventory_items SET
        procurement_status=COALESCE($1,procurement_status),
        expected_delivery_date=COALESCE($2,expected_delivery_date),
        actual_delivery_date=CASE WHEN $1='received' AND actual_delivery_date IS NULL THEN NOW()::date ELSE COALESCE($3,actual_delivery_date) END,
        updated_at=NOW()
      WHERE id=$4
    `, [procurement_status || null, expected_delivery_date || null, actual_delivery_date || null, req.params.id]);
    logActivity(req.user, { action: 'update', entityType: 'inventory_item', entityId: Number(req.params.id), label: `delivery: ${procurement_status || '—'}` });
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
    const { committee_id, status, recipient_type, recipient_id, inventory_item_id } = req.query;
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
    // recipient_id is only meaningful alongside recipient_type (ids aren't
    // unique across recipient tables), but the goodies-per-person modal
    // always sends both together, so no extra validation needed here.
    if (recipient_id) { params.push(recipient_id); conditions.push(`d.recipient_id = $${params.length}`); }
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
