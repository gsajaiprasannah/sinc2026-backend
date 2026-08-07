const express = require('express');
const multer = require('multer');
const db = require('../db');
const { attachChecklistRoutes, deleteChecklistForOwner } = require('./checklistHelper');
const { saveFile, deleteStoredFile } = require('../uploadHelper');
const { logActivity } = require('../lib/activityLogger');
const { validateGstin } = require('../lib/gst');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } }); // logos: 10MB is plenty

// Sponsor pass identifiers: SP-0001, SP-0002, ... — same advisory-lock
// pattern as vehicle codes, so two concurrent submits can't collide.
// Billing fields feed the GST invoice, so a malformed GSTIN is rejected here
// rather than being discovered at invoicing time. The state code is derived
// from the GSTIN's first two digits when not supplied — those two digits ARE
// the state, and letting the two disagree silently produces the wrong tax split.
function normaliseBilling(gstin, state_code) {
  const g = gstin === undefined || gstin === null ? null : String(gstin).trim().toUpperCase();
  if (g) {
    const check = validateGstin(g, null);
    if (!check.valid) {
      return { error: `That GSTIN is not valid: ${(check.errors || [check.reason]).filter(Boolean).join(' ')}` };
    }
  }
  let st = state_code === undefined || state_code === null ? null : String(state_code).trim();
  if (!st && g) st = g.slice(0, 2);
  return { gstin: g || null, state_code: st || null };
}

async function computeNextSponsorPassCode(runner) {
  const row = await runner.get(`
    SELECT COALESCE(MAX((regexp_match(sponsor_pass_code, '(\\d+)$'))[1]::int), 0) AS max_num
    FROM sponsors WHERE sponsor_pass_code LIKE 'SP-%'
  `);
  return 'SP-' + String((row && row.max_num ? row.max_num : 0) + 1).padStart(4, '0');
}

router.get('/', async (req, res) => {
  try {
    const rows = await db.all(`
      SELECT s.*, hm.name AS guest_relation_name,
        (SELECT COUNT(*) FROM checklist_items ci WHERE ci.owner_type='sponsor' AND ci.owner_id=s.id) AS checklist_total,
        (SELECT COUNT(*) FROM checklist_items ci WHERE ci.owner_type='sponsor' AND ci.owner_id=s.id AND ci.status='done') AS checklist_done
      FROM sponsors s
      LEFT JOIN host_members hm ON hm.id = s.guest_relation_host_member_id
      ORDER BY s.created_at DESC
    `);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/next-code', async (req, res) => {
  try {
    res.json({ sponsor_pass_code: await computeNextSponsorPassCode(db) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Minimal Host Member lookup for the "Guest Relation member" dropdown — the
// Sponsors module doesn't otherwise grant access to the internal Host
// Members admin data, so this exposes just id+name+company (nothing
// sensitive like payment/phone). Registered before /:id so this literal
// path is never swallowed as an id.
router.get('/host-members-lite', async (req, res) => {
  try {
    const rows = await db.all(`SELECT id, name, company FROM host_members ORDER BY name`);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const row = await db.get(`
      SELECT s.*, hm.name AS guest_relation_name
      FROM sponsors s LEFT JOIN host_members hm ON hm.id = s.guest_relation_host_member_id
      WHERE s.id=$1
    `, [req.params.id]);
    if (!row) return res.status(404).json({ error: 'not found' });
    res.json(row);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/', async (req, res) => {
  let { name, tier, contact_person, phone, email, sponsor_pass_code, guest_relation_host_member_id, status, notes,
    payment_status, payment_amount, payment_mode, payment_date, gstin, billing_address, state_code } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });
  const billing = normaliseBilling(gstin, state_code);
  if (billing.error) return res.status(400).json({ error: billing.error });
  const { gstin: billingGstin, state_code: billingState } = billing;
  try {
    const result = await db.transaction(async (tx) => {
      await tx.run('SELECT pg_advisory_xact_lock(778901)');
      if (!sponsor_pass_code || !sponsor_pass_code.trim()) {
        sponsor_pass_code = await computeNextSponsorPassCode(tx);
      }
      return tx.run(`
        INSERT INTO sponsors (name, tier, contact_person, phone, email, sponsor_pass_code, guest_relation_host_member_id, status, notes,
          payment_status, payment_amount, payment_mode, payment_date, gstin, billing_address, state_code)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id
      `, [name.trim(), tier || '', contact_person || '', phone || '', email || '', sponsor_pass_code,
          guest_relation_host_member_id || null, status || 'confirmed', notes || '',
          payment_status || 'pending', payment_amount ? Number(payment_amount) : null, payment_mode || '', payment_date || null,
          billingGstin, billing_address || null, billingState]);
    });
    logActivity(req.user, { action: 'create', entityType: 'sponsor', entityId: result.id, label: name.trim() });
    res.json({ id: result.id, sponsor_pass_code });
  } catch (e) {
    if (e.code === '23505') {
      return res.status(409).json({ error: `Sponsor pass code "${sponsor_pass_code}" already exists. Please try again.` });
    }
    res.status(400).json({ error: e.message });
  }
});

router.put('/:id', async (req, res) => {
  const { name, tier, contact_person, phone, email, guest_relation_host_member_id, status, notes,
    payment_status, payment_amount, payment_mode, payment_date, gstin, billing_address, state_code } = req.body;
  const billing = normaliseBilling(gstin, state_code);
  if (billing.error) return res.status(400).json({ error: billing.error });
  try {
    // Billing fields are set directly rather than via COALESCE: clearing a
    // GSTIN (sponsor turns out not to be registered) has to be possible, and
    // COALESCE would silently keep the old value when blank is sent.
    await db.run(`
      UPDATE sponsors SET
        name=COALESCE($1,name), tier=COALESCE($2,tier), contact_person=COALESCE($3,contact_person),
        phone=COALESCE($4,phone), email=COALESCE($5,email),
        guest_relation_host_member_id=$6,
        status=COALESCE($7,status), notes=COALESCE($8,notes),
        payment_status=COALESCE($9,payment_status),
        payment_amount=COALESCE($10,payment_amount),
        payment_mode=COALESCE($11,payment_mode),
        payment_date=COALESCE($12,payment_date),
        gstin=CASE WHEN $14::boolean THEN $15 ELSE gstin END,
        billing_address=CASE WHEN $16::boolean THEN $17 ELSE billing_address END,
        state_code=CASE WHEN $18::boolean THEN $19 ELSE state_code END
      WHERE id=$13
    `, [name || null, tier !== undefined ? tier : null, contact_person !== undefined ? contact_person : null,
        phone !== undefined ? phone : null, email !== undefined ? email : null,
        guest_relation_host_member_id || null, status || null, notes !== undefined ? notes : null,
        payment_status || null, payment_amount !== undefined && payment_amount !== '' ? Number(payment_amount) : null,
        payment_mode !== undefined ? payment_mode : null, payment_date || null, req.params.id,
        gstin !== undefined, billing.gstin,
        billing_address !== undefined, billing_address || null,
        // The state is also rewritten whenever a GSTIN is sent, so the pair
        // cannot end up out of step with each other.
        state_code !== undefined || gstin !== undefined, billing.state_code]);
    logActivity(req.user, { action: 'update', entityType: 'sponsor', entityId: Number(req.params.id), label: name });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.delete('/:id', async (req, res) => {
  const row = await db.get('SELECT name, logo_url FROM sponsors WHERE id=$1', [req.params.id]);
  if (row) await deleteStoredFile(row.logo_url);
  await deleteChecklistForOwner('sponsor', req.params.id);
  await db.run('DELETE FROM sponsors WHERE id=$1', [req.params.id]);
  logActivity(req.user, { action: 'delete', entityType: 'sponsor', entityId: Number(req.params.id), label: row?.name });
  res.json({ ok: true });
});

// Sponsor logo — shown on the public homepage next to the sponsor's name.
// Replaces any existing logo (old file is deleted so storage doesn't leak).
router.post('/:id/logo', (req, res, next) => {
  upload.single('file')(req, res, (err) => {
    if (err) {
      const friendly = err.code === 'LIMIT_FILE_SIZE' ? 'Logo image is too large (max 10MB).' : 'Upload was interrupted — please try again.';
      return res.status(400).json({ error: friendly });
    }
    next();
  });
}, async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'file is required' });
  try {
    const existing = await db.get('SELECT logo_url FROM sponsors WHERE id=$1', [req.params.id]);
    if (!existing) return res.status(404).json({ error: 'Sponsor not found' });
    const storedPath = await saveFile(req.file, 'sponsor-logos');
    await db.run('UPDATE sponsors SET logo_url=$1 WHERE id=$2', [storedPath, req.params.id]);
    if (existing.logo_url) await deleteStoredFile(existing.logo_url);
    res.json({ logo_url: storedPath });
  } catch (e) {
    console.error('Sponsor logo upload failed —', e.message);
    res.status(500).json({ error: 'Upload failed: ' + e.message });
  }
});

router.delete('/:id/logo', async (req, res) => {
  try {
    const existing = await db.get('SELECT logo_url FROM sponsors WHERE id=$1', [req.params.id]);
    if (!existing) return res.status(404).json({ error: 'Sponsor not found' });
    await db.run('UPDATE sponsors SET logo_url=NULL WHERE id=$1', [req.params.id]);
    if (existing.logo_url) await deleteStoredFile(existing.logo_url);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

attachChecklistRoutes(router, 'sponsor');

module.exports = router;
