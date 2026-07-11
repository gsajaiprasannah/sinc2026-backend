// Self-service endpoints for a logged-in vendor — an outside supplier
// (a 'vendors' record) who can maintain their OWN product catalog (with a
// photo of each product) and see + update the delivery status of the orders
// placed with them — Purchase Requests from Finance and Inventory Items from
// Goodies & Inventory — but nothing else about the system. Same self-scoping
// pattern as transporterPortal.js/driverPortal.js (req.user's linked
// vendor_id), so a vendor can never see or touch another vendor's data.
const express = require('express');
const multer = require('multer');
const db = require('../db');
const { requireAuth } = require('../auth');
const { saveFile, deleteStoredFile } = require('../uploadHelper');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

async function myVendorId(req) {
  const row = await db.get('SELECT vendor_id FROM users WHERE id=$1', [req.user.id]);
  return row ? row.vendor_id : null;
}

function requireVendorRole(req, res, next) {
  requireAuth(req, res, async () => {
    if (req.user.role !== 'vendor') {
      return res.status(403).json({ error: 'This login is not a vendor account.' });
    }
    const vendorId = await myVendorId(req);
    if (!vendorId) {
      return res.status(404).json({ error: 'This login is not yet linked to a vendor profile. Ask an admin to link it from Settings.' });
    }
    req.vendorId = vendorId;
    next();
  });
}

// Profile + own product catalog + everything ordered from this vendor
// (purchase requests + inventory items), each with its delivery status.
router.get('/me', requireVendorRole, async (req, res) => {
  try {
    const profile = await db.get('SELECT * FROM vendors WHERE id=$1', [req.vendorId]);
    const products = await db.all('SELECT * FROM vendor_products WHERE vendor_id=$1 ORDER BY name', [req.vendorId]);
    const purchases = await db.all(`
      SELECT id, purchase_item_name, purchase_category, purchase_unit, purchase_quantity, purchase_unit_cost, amount,
        status AS approval_status, delivery_status, expected_delivery_date, actual_delivery_date, transaction_date, created_at
      FROM finance_transactions WHERE vendor_id=$1 AND subtype='purchase' ORDER BY created_at DESC
    `, [req.vendorId]);
    const inventoryItems = await db.all(`
      SELECT id, name, category, unit, quantity_procured, unit_cost, procurement_status, expected_delivery_date, actual_delivery_date, created_at
      FROM inventory_items WHERE vendor_id=$1 ORDER BY created_at DESC
    `, [req.vendorId]);
    res.json({ profile, products, purchases, inventoryItems });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- My Products: the vendor's own catalog ---
router.get('/products', requireVendorRole, async (req, res) => {
  try {
    const rows = await db.all('SELECT * FROM vendor_products WHERE vendor_id=$1 ORDER BY name', [req.vendorId]);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/products', requireVendorRole, async (req, res) => {
  const { name, category, unit, unit_price, description, status } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Product name is required' });
  try {
    const result = await db.run(`
      INSERT INTO vendor_products (vendor_id, name, category, unit, unit_price, description, status)
      VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id
    `, [req.vendorId, name.trim(), category || '', unit || 'pcs', unit_price || null, description || '', status || 'active']);
    res.json({ id: result.id });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.put('/products/:id', requireVendorRole, async (req, res) => {
  const owned = await db.get('SELECT id FROM vendor_products WHERE id=$1 AND vendor_id=$2', [req.params.id, req.vendorId]);
  if (!owned) return res.status(404).json({ error: 'Product not found' });
  const { name, category, unit, unit_price, description, status } = req.body;
  try {
    await db.run(`
      UPDATE vendor_products SET
        name=COALESCE($1,name), category=COALESCE($2,category), unit=COALESCE($3,unit),
        unit_price=$4, description=COALESCE($5,description), status=COALESCE($6,status), updated_at=NOW()
      WHERE id=$7
    `, [name || null, category !== undefined ? category : null, unit !== undefined ? unit : null,
        unit_price !== undefined && unit_price !== '' ? Number(unit_price) : null,
        description !== undefined ? description : null, status || null, req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.delete('/products/:id', requireVendorRole, async (req, res) => {
  const owned = await db.get('SELECT id, photo_url FROM vendor_products WHERE id=$1 AND vendor_id=$2', [req.params.id, req.vendorId]);
  if (!owned) return res.status(404).json({ error: 'Product not found' });
  await deleteStoredFile(owned.photo_url);
  await db.run('DELETE FROM vendor_products WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

// Take/upload a photo of a product — own products only.
router.post('/products/:id/photo', requireVendorRole, (req, res, next) => {
  upload.single('file')(req, res, (err) => {
    if (err) {
      const friendly = err.code === 'LIMIT_FILE_SIZE' ? 'Photo is too large (max 10MB).' : 'Upload was interrupted — please try again.';
      return res.status(400).json({ error: friendly });
    }
    next();
  });
}, async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'file is required' });
  try {
    const existing = await db.get('SELECT photo_url FROM vendor_products WHERE id=$1 AND vendor_id=$2', [req.params.id, req.vendorId]);
    if (!existing) return res.status(404).json({ error: 'Product not found' });
    const storedPath = await saveFile(req.file, 'vendor-products');
    await db.run('UPDATE vendor_products SET photo_url=$1, updated_at=NOW() WHERE id=$2', [storedPath, req.params.id]);
    if (existing.photo_url) await deleteStoredFile(existing.photo_url);
    res.json({ photo_url: storedPath });
  } catch (e) {
    console.error('Vendor product photo upload failed —', e.message);
    res.status(500).json({ error: 'Upload failed: ' + e.message });
  }
});

// --- My Orders: purchase requests + inventory items ordered from this vendor ---
router.get('/orders', requireVendorRole, async (req, res) => {
  try {
    const purchases = await db.all(`
      SELECT id, purchase_item_name, purchase_category, purchase_unit, purchase_quantity, purchase_unit_cost, amount,
        status AS approval_status, delivery_status, expected_delivery_date, actual_delivery_date, transaction_date, created_at
      FROM finance_transactions WHERE vendor_id=$1 AND subtype='purchase' ORDER BY created_at DESC
    `, [req.vendorId]);
    const inventoryItems = await db.all(`
      SELECT id, name, category, unit, quantity_procured, unit_cost, procurement_status, expected_delivery_date, actual_delivery_date, created_at
      FROM inventory_items WHERE vendor_id=$1 ORDER BY created_at DESC
    `, [req.vendorId]);
    res.json({ purchases, inventoryItems });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Vendor updates the delivery status of one of their own Purchase Requests —
// scoped so they can never touch another vendor's, or anything about the
// payment-approval side of the record (amount/status/approvals are untouched).
router.put('/orders/purchase/:id/delivery', requireVendorRole, async (req, res) => {
  const { delivery_status, expected_delivery_date, actual_delivery_date } = req.body;
  if (delivery_status && !['ordered', 'in_transit', 'delivered', 'delayed', 'cancelled'].includes(delivery_status)) {
    return res.status(400).json({ error: 'Invalid delivery_status' });
  }
  try {
    const owned = await db.get(`SELECT id FROM finance_transactions WHERE id=$1 AND vendor_id=$2 AND subtype='purchase'`, [req.params.id, req.vendorId]);
    if (!owned) return res.status(404).json({ error: 'Order not found' });
    await db.run(`
      UPDATE finance_transactions SET
        delivery_status=COALESCE($1,delivery_status),
        expected_delivery_date=COALESCE($2,expected_delivery_date),
        actual_delivery_date=CASE WHEN $1='delivered' AND actual_delivery_date IS NULL THEN NOW()::date ELSE COALESCE($3,actual_delivery_date) END,
        updated_at=NOW()
      WHERE id=$4
    `, [delivery_status || null, expected_delivery_date || null, actual_delivery_date || null, req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Vendor updates their own Inventory Item's procurement/delivery progress —
// restricted to the forward-moving states a vendor would actually report
// (ordered/received/delayed); 'planned'/'distributing'/'completed' stay
// admin-only since those are about our own internal handling after receipt.
router.put('/orders/inventory/:id/delivery', requireVendorRole, async (req, res) => {
  const { procurement_status, expected_delivery_date, actual_delivery_date } = req.body;
  if (procurement_status && !['ordered', 'received', 'delayed'].includes(procurement_status)) {
    return res.status(400).json({ error: 'Vendors can only set status to ordered, received, or delayed.' });
  }
  try {
    const owned = await db.get('SELECT id FROM inventory_items WHERE id=$1 AND vendor_id=$2', [req.params.id, req.vendorId]);
    if (!owned) return res.status(404).json({ error: 'Item not found' });
    await db.run(`
      UPDATE inventory_items SET
        procurement_status=COALESCE($1,procurement_status),
        expected_delivery_date=COALESCE($2,expected_delivery_date),
        actual_delivery_date=CASE WHEN $1='received' AND actual_delivery_date IS NULL THEN NOW()::date ELSE COALESCE($3,actual_delivery_date) END,
        updated_at=NOW()
      WHERE id=$4
    `, [procurement_status || null, expected_delivery_date || null, actual_delivery_date || null, req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

module.exports = router;
