const express = require('express');
const multer = require('multer');
const db = require('../db');
const { logActivity } = require('../lib/activityLogger');
const { saveFile, deleteStoredFile } = require('../uploadHelper');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } }); // product photos: 10MB is plenty

// --- Vendor master (admin side) ---
// One row per outside supplier. Aggregated counts (products / purchase
// orders / inventory items) let the list view answer "who's supplying what"
// at a glance without opening every vendor.
router.get('/', async (req, res) => {
  try {
    const rows = await db.all(`
      SELECT v.*,
        (SELECT COUNT(*) FROM vendor_products vp WHERE vp.vendor_id = v.id) AS product_count,
        (SELECT COUNT(*) FROM finance_transactions ft WHERE ft.vendor_id = v.id AND ft.subtype = 'purchase') AS purchase_count,
        (SELECT COUNT(*) FROM inventory_items ii WHERE ii.vendor_id = v.id) AS inventory_item_count,
        (SELECT id FROM users u WHERE u.vendor_id = v.id LIMIT 1) AS user_id
      FROM vendors v
      ORDER BY v.name
    `);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// All vendor products across every vendor, with the owning vendor's name —
// powers the "quick pick" item dropdown on the Purchase Request form so an
// item can be selected without retyping it, with its vendor auto-resolved.
// Two path segments ("products"/"all"), so it can't collide with GET /:id.
router.get('/products/all', async (req, res) => {
  try {
    const rows = await db.all(`
      SELECT vp.id, vp.vendor_id, v.name AS vendor_name, vp.name, vp.category, vp.unit, vp.unit_price, vp.processing_time_days, vp.status
      FROM vendor_products vp
      JOIN vendors v ON v.id = vp.vendor_id
      ORDER BY v.name, vp.name
    `);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Vendor detail: profile + their own product catalog + everything ordered
// from them across Purchase Requests (Finance) and Inventory Items
// (Goodies & Inventory) — the "what is this vendor supplying, and what's the
// order/delivery status of each" view the Vendor Management module exists for.
router.get('/:id', async (req, res) => {
  try {
    const vendor = await db.get('SELECT * FROM vendors WHERE id=$1', [req.params.id]);
    if (!vendor) return res.status(404).json({ error: 'Vendor not found' });
    const products = await db.all('SELECT * FROM vendor_products WHERE vendor_id=$1 ORDER BY name', [req.params.id]);
    const purchases = await db.all(`
      SELECT id, purchase_item_name, purchase_category, purchase_unit, purchase_quantity, purchase_unit_cost, amount,
        status AS approval_status, delivery_status, expected_delivery_date, actual_delivery_date, transaction_date, created_at
      FROM finance_transactions WHERE vendor_id=$1 AND subtype='purchase' ORDER BY created_at DESC
    `, [req.params.id]);
    const inventoryItems = await db.all(`
      SELECT id, name, category, unit, quantity_procured, unit_cost, procurement_status, expected_delivery_date, actual_delivery_date, created_at
      FROM inventory_items WHERE vendor_id=$1 ORDER BY created_at DESC
    `, [req.params.id]);
    const loginUser = await db.get('SELECT id, username, status FROM users WHERE vendor_id=$1', [req.params.id]);
    res.json({ vendor, products, purchases, inventoryItems, loginUser });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/', async (req, res) => {
  const { name, category, contact_person, phone, email, address, gst_number, status, notes } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Vendor name is required' });
  try {
    const result = await db.run(`
      INSERT INTO vendors (name, category, contact_person, phone, email, address, gst_number, status, notes)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id
    `, [name.trim(), category || '', contact_person || '', phone || '', email || '', address || '', gst_number || '', status || 'active', notes || '']);
    logActivity(req.user, { action: 'create', entityType: 'vendor', entityId: result.id, label: name.trim() });
    res.json({ id: result.id });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.put('/:id', async (req, res) => {
  const { name, category, contact_person, phone, email, address, gst_number, status, notes } = req.body;
  try {
    await db.run(`
      UPDATE vendors SET
        name=COALESCE($1,name), category=COALESCE($2,category), contact_person=COALESCE($3,contact_person),
        phone=COALESCE($4,phone), email=COALESCE($5,email), address=COALESCE($6,address),
        gst_number=COALESCE($7,gst_number), status=COALESCE($8,status), notes=COALESCE($9,notes), updated_at=NOW()
      WHERE id=$10
    `, [name || null, category !== undefined ? category : null, contact_person !== undefined ? contact_person : null,
        phone !== undefined ? phone : null, email !== undefined ? email : null, address !== undefined ? address : null,
        gst_number !== undefined ? gst_number : null, status || null, notes !== undefined ? notes : null, req.params.id]);
    logActivity(req.user, { action: 'update', entityType: 'vendor', entityId: Number(req.params.id), label: name });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.delete('/:id', async (req, res) => {
  const row = await db.get('SELECT name FROM vendors WHERE id=$1', [req.params.id]);
  const products = await db.all('SELECT photo_url FROM vendor_products WHERE vendor_id=$1', [req.params.id]);
  for (const p of products) await deleteStoredFile(p.photo_url);
  await db.run('DELETE FROM vendors WHERE id=$1', [req.params.id]); // vendor_products cascades; purchases/inventory_items keep their row with vendor_id set NULL
  logActivity(req.user, { action: 'delete', entityType: 'vendor', entityId: Number(req.params.id), label: row?.name });
  res.json({ ok: true });
});

// --- Vendor's product catalog (admin can also manage it on the vendor's behalf) ---
router.post('/:id/products', async (req, res) => {
  const { name, category, unit, unit_price, processing_time_days, description, status } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Product name is required' });
  try {
    const vendor = await db.get('SELECT id FROM vendors WHERE id=$1', [req.params.id]);
    if (!vendor) return res.status(404).json({ error: 'Vendor not found' });
    const result = await db.run(`
      INSERT INTO vendor_products (vendor_id, name, category, unit, unit_price, processing_time_days, description, status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id
    `, [req.params.id, name.trim(), category || '', unit || 'pcs', unit_price || null,
        processing_time_days !== undefined && processing_time_days !== '' ? Number(processing_time_days) : null,
        description || '', status || 'active']);
    logActivity(req.user, { action: 'create', entityType: 'vendor_product', entityId: result.id, label: name.trim() });
    res.json({ id: result.id });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.put('/products/:productId', async (req, res) => {
  const { name, category, unit, unit_price, processing_time_days, description, status } = req.body;
  try {
    await db.run(`
      UPDATE vendor_products SET
        name=COALESCE($1,name), category=COALESCE($2,category), unit=COALESCE($3,unit),
        unit_price=$4, processing_time_days=$5, description=COALESCE($6,description), status=COALESCE($7,status), updated_at=NOW()
      WHERE id=$8
    `, [name || null, category !== undefined ? category : null, unit !== undefined ? unit : null,
        unit_price !== undefined && unit_price !== '' ? Number(unit_price) : null,
        processing_time_days !== undefined && processing_time_days !== '' ? Number(processing_time_days) : null,
        description !== undefined ? description : null, status || null, req.params.productId]);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.delete('/products/:productId', async (req, res) => {
  const row = await db.get('SELECT name, photo_url FROM vendor_products WHERE id=$1', [req.params.productId]);
  await deleteStoredFile(row?.photo_url);
  await db.run('DELETE FROM vendor_products WHERE id=$1', [req.params.productId]);
  logActivity(req.user, { action: 'delete', entityType: 'vendor_product', entityId: Number(req.params.productId), label: row?.name });
  res.json({ ok: true });
});

// Product photo — a picture of the actual goods, shown in both the admin
// vendor detail view and the vendor's own portal.
router.post('/products/:productId/photo', (req, res, next) => {
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
    const existing = await db.get('SELECT photo_url FROM vendor_products WHERE id=$1', [req.params.productId]);
    if (!existing) return res.status(404).json({ error: 'Product not found' });
    const storedPath = await saveFile(req.file, 'vendor-products');
    await db.run('UPDATE vendor_products SET photo_url=$1, updated_at=NOW() WHERE id=$2', [storedPath, req.params.productId]);
    if (existing.photo_url) await deleteStoredFile(existing.photo_url);
    res.json({ photo_url: storedPath });
  } catch (e) {
    console.error('Vendor product photo upload failed —', e.message);
    res.status(500).json({ error: 'Upload failed: ' + e.message });
  }
});

module.exports = router;
