const express = require('express');
const db = require('../db');
const { logActivity } = require('../lib/activityLogger');
const {
  PAYMENT_APPROVAL_ROLES,
  PURCHASE_APPROVAL_ROLES,
  createApprovalRows
} = require('../lib/financeHelper');

const router = express.Router();

// One query fragment (used by both /summary and /outward) that attaches
// each outward transaction's approval progress as a JSON array — including
// who (if anyone) currently holds each required role, so the admin UI can
// flag "nobody is currently tagged as Congress Treasurer" rather than a
// silently-stuck pending approval.
const APPROVALS_SUBQUERY = `
  (SELECT COALESCE(json_agg(json_build_object(
      'required_role', fta.required_role,
      'status', fta.status,
      'decided_at', fta.decided_at,
      'remarks', fta.remarks,
      'approved_by', hm.name,
      'assigned_to', ahm.name
    ) ORDER BY fta.id), '[]'::json)
   FROM finance_transaction_approvals fta
   LEFT JOIN host_members hm ON hm.id = fta.approved_by_host_member_id
   LEFT JOIN host_members ahm ON ahm.leadership_role = fta.required_role
   WHERE fta.transaction_id = ft.id
  ) AS approvals
`;

// --- Summary / dashboard numbers ---
router.get('/summary', async (req, res) => {
  try {
    const inward = await db.get(`SELECT COALESCE(SUM(amount),0) AS total FROM finance_inward_ledger`);
    const outwardPaid = await db.get(`SELECT COALESCE(SUM(amount),0) AS total FROM finance_transactions WHERE type='outward' AND status='paid'`);
    const pending = await db.get(`SELECT COUNT(*) AS count, COALESCE(SUM(amount),0) AS total FROM finance_transactions WHERE type='outward' AND status='pending_approval'`);
    const approved = await db.get(`SELECT COUNT(*) AS count, COALESCE(SUM(amount),0) AS total FROM finance_transactions WHERE type='outward' AND status='approved'`);
    const totalInward = Number(inward.total);
    const totalOutwardPaid = Number(outwardPaid.total);
    res.json({
      total_inward: totalInward,
      total_outward_paid: totalOutwardPaid,
      net_balance: totalInward - totalOutwardPaid,
      pending_approval_count: Number(pending.count),
      pending_approval_amount: Number(pending.total),
      approved_awaiting_payment_count: Number(approved.count),
      approved_awaiting_payment_amount: Number(approved.total)
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Inward ledger: auto-pulled from other modules + manual entries ---
router.get('/inward', async (req, res) => {
  try {
    const rows = await db.all(`SELECT * FROM finance_inward_ledger ORDER BY transaction_date DESC NULLS LAST, source_id DESC`);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/inward', async (req, res) => {
  const { category, payee_or_payer, amount, description, transaction_date, payment_mode, notes } = req.body;
  if (!amount || Number(amount) <= 0) return res.status(400).json({ error: 'A positive amount is required' });
  try {
    const result = await db.run(`
      INSERT INTO finance_transactions (type, category, payee_or_payer, amount, description, transaction_date, payment_mode, status, notes, created_by)
      VALUES ('inward',$1,$2,$3,$4,$5,$6,'recorded',$7,$8) RETURNING id
    `, [category || 'Other', payee_or_payer || '', Number(amount), description || '', transaction_date || null, payment_mode || '', notes || '', req.user?.id || null]);
    logActivity(req.user, { action: 'create', entityType: 'finance_inward', entityId: result.id, label: payee_or_payer || category });
    res.json({ id: result.id });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.put('/inward/:id', async (req, res) => {
  const { category, payee_or_payer, amount, description, transaction_date, payment_mode, notes } = req.body;
  try {
    const existing = await db.get(`SELECT id FROM finance_transactions WHERE id=$1 AND type='inward'`, [req.params.id]);
    if (!existing) return res.status(404).json({ error: 'Manual inward entry not found (auto-pulled rows from other modules cannot be edited here).' });
    await db.run(`
      UPDATE finance_transactions SET
        category=COALESCE($1,category), payee_or_payer=COALESCE($2,payee_or_payer),
        amount=COALESCE($3,amount), description=COALESCE($4,description),
        transaction_date=$5, payment_mode=COALESCE($6,payment_mode), notes=COALESCE($7,notes),
        updated_at=NOW()
      WHERE id=$8
    `, [category || null, payee_or_payer !== undefined ? payee_or_payer : null,
        amount !== undefined && amount !== '' ? Number(amount) : null,
        description !== undefined ? description : null, transaction_date || null,
        payment_mode !== undefined ? payment_mode : null, notes !== undefined ? notes : null, req.params.id]);
    logActivity(req.user, { action: 'update', entityType: 'finance_inward', entityId: Number(req.params.id) });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.delete('/inward/:id', async (req, res) => {
  const existing = await db.get(`SELECT payee_or_payer FROM finance_transactions WHERE id=$1 AND type='inward'`, [req.params.id]);
  if (!existing) return res.status(404).json({ error: 'Manual inward entry not found (auto-pulled rows from other modules cannot be deleted here).' });
  await db.run(`DELETE FROM finance_transactions WHERE id=$1`, [req.params.id]);
  logActivity(req.user, { action: 'delete', entityType: 'finance_inward', entityId: Number(req.params.id), label: existing.payee_or_payer });
  res.json({ ok: true });
});

// --- Outward: plain payments (subtype='payment') and purchase requests ---
// (subtype='purchase') — same table, filtered by ?subtype= query param.
router.get('/outward', async (req, res) => {
  const subtype = req.query.subtype === 'purchase' ? 'purchase' : 'payment';
  try {
    const rows = await db.all(`
      SELECT ft.*, ${APPROVALS_SUBQUERY}
      FROM finance_transactions ft
      WHERE ft.type='outward' AND ft.subtype=$1
      ORDER BY ft.created_at DESC
    `, [subtype]);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/outward/:id', async (req, res) => {
  try {
    const row = await db.get(`
      SELECT ft.*, ${APPROVALS_SUBQUERY}
      FROM finance_transactions ft WHERE ft.id=$1
    `, [req.params.id]);
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json(row);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Create a plain outward payment request (vendor invoice, honorarium, misc
// expense) — needs unanimous approval from all 5 office-bearers.
router.post('/outward', async (req, res) => {
  const { category, payee_or_payer, amount, description, transaction_date, payment_mode, notes } = req.body;
  if (!payee_or_payer || !payee_or_payer.trim()) return res.status(400).json({ error: 'payee_or_payer is required' });
  if (!amount || Number(amount) <= 0) return res.status(400).json({ error: 'A positive amount is required' });
  try {
    const result = await db.run(`
      INSERT INTO finance_transactions (type, subtype, category, payee_or_payer, amount, description, transaction_date, payment_mode, status, notes, created_by)
      VALUES ('outward','payment',$1,$2,$3,$4,$5,$6,'pending_approval',$7,$8) RETURNING id
    `, [category || 'Other', payee_or_payer.trim(), Number(amount), description || '', transaction_date || null, payment_mode || '', notes || '', req.user?.id || null]);
    await createApprovalRows(result.id, 'payment');
    logActivity(req.user, { action: 'create', entityType: 'finance_outward_payment', entityId: result.id, label: payee_or_payer.trim() });
    res.json({ id: result.id, required_roles: PAYMENT_APPROVAL_ROLES });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Create a purchase request (goodies/inventory procurement) — needs
// approval from just President + Treasurer. amount is computed from
// quantity x unit cost so the requester doesn't have to do the math.
router.post('/purchases', async (req, res) => {
  const { purchase_item_name, purchase_category, purchase_unit, purchase_quantity, purchase_unit_cost, payee_or_payer, description, transaction_date, notes } = req.body;
  if (!purchase_item_name || !purchase_item_name.trim()) return res.status(400).json({ error: 'purchase_item_name is required' });
  const qty = Number(purchase_quantity) || 0;
  const unitCost = Number(purchase_unit_cost) || 0;
  if (qty <= 0) return res.status(400).json({ error: 'A positive quantity is required' });
  try {
    const amount = qty * unitCost;
    const result = await db.run(`
      INSERT INTO finance_transactions (
        type, subtype, category, payee_or_payer, amount, description, transaction_date, status, notes,
        purchase_item_name, purchase_category, purchase_unit, purchase_quantity, purchase_unit_cost, created_by
      )
      VALUES ('outward','purchase',$1,$2,$3,$4,$5,'pending_approval',$6,$7,$8,$9,$10,$11,$12) RETURNING id
    `, [
      purchase_category || 'Goodies', payee_or_payer || '', amount, description || '', transaction_date || null, notes || '',
      purchase_item_name.trim(), purchase_category || '', purchase_unit || 'pcs', qty, unitCost, req.user?.id || null
    ]);
    await createApprovalRows(result.id, 'purchase');
    logActivity(req.user, { action: 'create', entityType: 'finance_purchase_request', entityId: result.id, label: purchase_item_name.trim() });
    res.json({ id: result.id, required_roles: PURCHASE_APPROVAL_ROLES });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Edit an outward transaction (payment or purchase) — only while it's still
// awaiting approval, so nobody can quietly change amounts after sign-off.
router.put('/outward/:id', async (req, res) => {
  try {
    const existing = await db.get(`SELECT * FROM finance_transactions WHERE id=$1 AND type='outward'`, [req.params.id]);
    if (!existing) return res.status(404).json({ error: 'Not found' });
    if (existing.status !== 'pending_approval') {
      return res.status(409).json({ error: `This request is already ${existing.status.replace('_', ' ')} and can no longer be edited.` });
    }
    if (existing.subtype === 'purchase') {
      const { purchase_item_name, purchase_category, purchase_unit, purchase_quantity, purchase_unit_cost, payee_or_payer, description, transaction_date, notes } = req.body;
      const qty = purchase_quantity !== undefined && purchase_quantity !== '' ? Number(purchase_quantity) : existing.purchase_quantity;
      const unitCost = purchase_unit_cost !== undefined && purchase_unit_cost !== '' ? Number(purchase_unit_cost) : existing.purchase_unit_cost;
      await db.run(`
        UPDATE finance_transactions SET
          purchase_item_name=COALESCE($1,purchase_item_name), purchase_category=COALESCE($2,purchase_category),
          purchase_unit=COALESCE($3,purchase_unit), purchase_quantity=$4, purchase_unit_cost=$5,
          amount=$6, payee_or_payer=COALESCE($7,payee_or_payer), description=COALESCE($8,description),
          transaction_date=$9, notes=COALESCE($10,notes), updated_at=NOW()
        WHERE id=$11
      `, [purchase_item_name || null, purchase_category !== undefined ? purchase_category : null,
          purchase_unit !== undefined ? purchase_unit : null, qty, unitCost, (Number(qty) || 0) * (Number(unitCost) || 0),
          payee_or_payer !== undefined ? payee_or_payer : null, description !== undefined ? description : null,
          transaction_date || null, notes !== undefined ? notes : null, req.params.id]);
    } else {
      const { category, payee_or_payer, amount, description, transaction_date, payment_mode, notes } = req.body;
      await db.run(`
        UPDATE finance_transactions SET
          category=COALESCE($1,category), payee_or_payer=COALESCE($2,payee_or_payer),
          amount=COALESCE($3,amount), description=COALESCE($4,description),
          transaction_date=$5, payment_mode=COALESCE($6,payment_mode), notes=COALESCE($7,notes),
          updated_at=NOW()
        WHERE id=$8
      `, [category || null, payee_or_payer !== undefined ? payee_or_payer : null,
          amount !== undefined && amount !== '' ? Number(amount) : null, description !== undefined ? description : null,
          transaction_date || null, payment_mode !== undefined ? payment_mode : null, notes !== undefined ? notes : null, req.params.id]);
    }
    logActivity(req.user, { action: 'update', entityType: 'finance_outward', entityId: Number(req.params.id) });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Admin marks an already-fully-approved transaction as actually paid/disbursed.
router.post('/outward/:id/mark-paid', async (req, res) => {
  const { payment_mode, transaction_date } = req.body;
  try {
    const existing = await db.get(`SELECT * FROM finance_transactions WHERE id=$1 AND type='outward'`, [req.params.id]);
    if (!existing) return res.status(404).json({ error: 'Not found' });
    if (existing.status !== 'approved') {
      return res.status(409).json({ error: 'Only a fully-approved request can be marked as paid.' });
    }
    await db.run(`
      UPDATE finance_transactions SET status='paid', payment_mode=COALESCE($1,payment_mode),
        transaction_date=COALESCE($2,transaction_date), updated_at=NOW()
      WHERE id=$3
    `, [payment_mode || null, transaction_date || null, req.params.id]);
    logActivity(req.user, { action: 'update', entityType: 'finance_outward', entityId: Number(req.params.id), label: 'marked paid' });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Cancel/withdraw a request — only while pending or already rejected (never
// once money has actually moved). Only super_admin reaches this at all
// thanks to the global "DELETE requires super_admin" gate in server/index.js.
router.delete('/outward/:id', async (req, res) => {
  const existing = await db.get(`SELECT * FROM finance_transactions WHERE id=$1 AND type='outward'`, [req.params.id]);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  if (existing.status === 'paid') {
    return res.status(409).json({ error: 'A paid transaction cannot be deleted — it is part of the financial record.' });
  }
  await db.run(`DELETE FROM finance_transactions WHERE id=$1`, [req.params.id]);
  logActivity(req.user, { action: 'delete', entityType: 'finance_outward', entityId: Number(req.params.id), label: existing.payee_or_payer || existing.purchase_item_name });
  res.json({ ok: true });
});

module.exports = router;
