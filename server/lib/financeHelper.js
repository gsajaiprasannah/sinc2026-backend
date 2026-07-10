// Shared Finance-module logic used by both the admin-only routes
// (server/routes/finance.js) and the self-service approval routes exposed
// to leadership host members (server/routes/host.js). Kept in one place so
// "who needs to approve what, and what happens once everyone has" only
// lives in a single spot rather than being duplicated across both routers.
const db = require('../db');

// A plain outward payment (vendor invoice, honorarium, misc expense) needs
// unanimous sign-off from all five office-bearers.
const PAYMENT_APPROVAL_ROLES = ['President', 'Secretary', 'Treasurer', 'Congress Chairman', 'Congress Treasurer'];

// A goodies/inventory purchase request is lighter-weight — just the
// President and Treasurer need to approve before it's actioned.
const PURCHASE_APPROVAL_ROLES = ['President', 'Treasurer'];

// Every leadership_role that can ever be asked to approve something in the
// Finance module — used to decide whether the self-service portal should
// show the "Approvals" section at all for a given logged-in host member.
const ALL_FINANCE_APPROVER_ROLES = Array.from(new Set([...PAYMENT_APPROVAL_ROLES, ...PURCHASE_APPROVAL_ROLES]));

function approvalRolesForSubtype(subtype) {
  return subtype === 'purchase' ? PURCHASE_APPROVAL_ROLES : PAYMENT_APPROVAL_ROLES;
}

// Called right after a finance_transactions row is created (type='outward').
// Seeds one pending approval row per required role for that subtype.
async function createApprovalRows(transactionId, subtype) {
  const roles = approvalRolesForSubtype(subtype);
  for (const role of roles) {
    await db.run(
      `INSERT INTO finance_transaction_approvals (transaction_id, required_role) VALUES ($1,$2)
       ON CONFLICT (transaction_id, required_role) DO NOTHING`,
      [transactionId, role]
    );
  }
}

// Once a purchase request's approvals are all in, automatically create (or
// top up) the matching inventory_items row — this is the one and only path
// that auto-populates inventory from an actual approved procurement
// decision. Matches on name+category (case-insensitive); if nothing matches
// a brand-new inventory item is created with procurement_status='ordered'.
async function linkPurchaseToInventory(tx) {
  const existing = await db.get(
    `SELECT * FROM inventory_items WHERE LOWER(name) = LOWER($1) AND LOWER(COALESCE(category,'')) = LOWER(COALESCE($2,'')) LIMIT 1`,
    [tx.purchase_item_name, tx.purchase_category || '']
  );
  let inventoryItemId;
  if (existing) {
    await db.run(
      `UPDATE inventory_items SET
         quantity_procured = quantity_procured + $1,
         vendor_name = COALESCE($2, vendor_name),
         unit_cost = COALESCE($3, unit_cost),
         procurement_status = CASE WHEN procurement_status = 'planned' THEN 'ordered' ELSE procurement_status END,
         updated_at = NOW()
       WHERE id = $4`,
      [tx.purchase_quantity || 0, tx.payee_or_payer || null, tx.purchase_unit_cost || null, existing.id]
    );
    inventoryItemId = existing.id;
  } else {
    const created = await db.run(
      `INSERT INTO inventory_items (name, category, unit, quantity_procured, vendor_name, unit_cost, procurement_status)
       VALUES ($1,$2,$3,$4,$5,$6,'ordered') RETURNING id`,
      [
        tx.purchase_item_name,
        tx.purchase_category || '',
        tx.purchase_unit || 'pcs',
        tx.purchase_quantity || 0,
        tx.payee_or_payer || null,
        tx.purchase_unit_cost || null
      ]
    );
    inventoryItemId = created.id;
  }
  await db.run(`UPDATE finance_transactions SET inventory_item_id = $1, updated_at = NOW() WHERE id = $2`, [inventoryItemId, tx.id]);
  return inventoryItemId;
}

// Re-checks a transaction's approval rows after any single decision and
// flips the parent finance_transactions.status accordingly:
//   - any rejection  -> transaction status = 'rejected' immediately
//   - all approved   -> transaction status = 'approved'
//                       (+ auto-link to inventory if it's a purchase)
//   - otherwise       -> stays 'pending_approval'
async function finalizeApprovalIfReady(transactionId) {
  const rows = await db.all(
    `SELECT status FROM finance_transaction_approvals WHERE transaction_id = $1`,
    [transactionId]
  );
  const anyRejected = rows.some(r => r.status === 'rejected');
  const allApproved = rows.length > 0 && rows.every(r => r.status === 'approved');

  if (anyRejected) {
    await db.run(`UPDATE finance_transactions SET status='rejected', updated_at=NOW() WHERE id=$1 AND status='pending_approval'`, [transactionId]);
    return 'rejected';
  }
  if (allApproved) {
    await db.run(`UPDATE finance_transactions SET status='approved', updated_at=NOW() WHERE id=$1 AND status='pending_approval'`, [transactionId]);
    const tx = await db.get(`SELECT * FROM finance_transactions WHERE id=$1`, [transactionId]);
    if (tx && tx.subtype === 'purchase') {
      await linkPurchaseToInventory(tx);
    }
    return 'approved';
  }
  return 'pending_approval';
}

module.exports = {
  PAYMENT_APPROVAL_ROLES,
  PURCHASE_APPROVAL_ROLES,
  ALL_FINANCE_APPROVER_ROLES,
  approvalRolesForSubtype,
  createApprovalRows,
  linkPurchaseToInventory,
  finalizeApprovalIfReady
};
