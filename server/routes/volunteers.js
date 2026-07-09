// Volunteers: external / non-club-member helpers brought in for data entry
// (hired temp staff, one-off helpers) — distinct from 'host_member' (an
// actual Skål Coimbatore club member who pays the ₹5000 host contribution
// and sits on committees). A volunteer has no club/payment/committee
// baggage: just a name/contact, and whichever modules an admin grants them
// DIRECTLY (no committee membership required — see committeeModuleAccess.js's
// grantedModulesForVolunteer()/requireModuleAccess()).
const express = require('express');
const db = require('../db');
const { MODULE_KEYS, isValidModuleKey } = require('./committeeModuleAccess');
const { logActivity } = require('../lib/activityLogger');

const router = express.Router();

// --- Duplicate-entry protection --- same idea as host members/delegates:
// match on phone first (most reliable), falling back to an exact
// case-insensitive name match only when no phone is on file for either side.
function normPhone(p) {
  return (p || '').replace(/\D/g, '').slice(-10);
}
function normName(n) {
  return (n || '').trim().toLowerCase().replace(/\s+/g, ' ');
}
async function findDuplicateVolunteer(runner, { name, phone, excludeId }) {
  const np = normPhone(phone);
  const nn = normName(name);
  let row = null;
  if (np) {
    let sql = `SELECT id, name, phone, organization FROM volunteers WHERE phone <> '' AND RIGHT(regexp_replace(phone, '[^0-9]', '', 'g'), 10) = $1`;
    const params = [np];
    if (excludeId) { sql += ' AND id <> $2'; params.push(excludeId); }
    sql += ' LIMIT 1';
    row = await runner.get(sql, params);
  }
  if (!row && nn) {
    let sql = `SELECT id, name, phone, organization FROM volunteers WHERE lower(trim(name)) = $1`;
    const params = [nn];
    if (excludeId) { sql += ' AND id <> $2'; params.push(excludeId); }
    sql += ' LIMIT 1';
    row = await runner.get(sql, params);
  }
  return row;
}

router.get('/', async (req, res) => {
  try {
    const rows = await db.all(`
      SELECT v.*,
        COALESCE(
          (SELECT json_agg(vma.module_key ORDER BY vma.module_key) FROM volunteer_module_access vma WHERE vma.volunteer_id = v.id),
          '[]'
        ) AS module_access,
        (SELECT u.id FROM users u WHERE u.volunteer_id = v.id LIMIT 1) AS user_id
      FROM volunteers v
      ORDER BY v.name
    `);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Registered BEFORE '/:id' — otherwise Express would treat "module-keys" as
// an :id value and this route would never be reached (same trap avoided in
// committees.js, which has no generic GET /:id to collide with).
router.get('/module-keys', (req, res) => res.json(MODULE_KEYS));

router.get('/:id', async (req, res) => {
  try {
    const row = await db.get('SELECT * FROM volunteers WHERE id=$1', [req.params.id]);
    if (!row) return res.status(404).json({ error: 'not found' });
    res.json(row);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/', async (req, res) => {
  const { name, phone, email, organization, notes, force } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  try {
    if (!force) {
      const dup = await findDuplicateVolunteer(db, { name, phone });
      if (dup) {
        return res.status(409).json({
          error: 'duplicate',
          message: `A volunteer named "${dup.name}"${dup.phone ? ' with phone ' + dup.phone : ''} already exists${dup.organization ? ' (' + dup.organization + ')' : ''}. Save anyway?`,
          existing: dup
        });
      }
    }
    const result = await db.run(
      `INSERT INTO volunteers (name, phone, email, organization, notes) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [name.trim(), phone || '', email || '', organization || '', notes || '']
    );
    logActivity(req.user, { action: 'create', entityType: 'volunteer', entityId: result.id, label: name.trim() });
    res.json({ id: result.id });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.put('/:id', async (req, res) => {
  const { name, phone, email, organization, notes, force } = req.body;
  try {
    if (!force && (name !== undefined || phone !== undefined)) {
      const current = await db.get('SELECT name, phone FROM volunteers WHERE id=$1', [req.params.id]);
      const candidate = { name: name !== undefined ? name : current && current.name, phone: phone !== undefined ? phone : current && current.phone };
      const dup = await findDuplicateVolunteer(db, { ...candidate, excludeId: req.params.id });
      if (dup) {
        return res.status(409).json({
          error: 'duplicate',
          message: `A volunteer named "${dup.name}"${dup.phone ? ' with phone ' + dup.phone : ''} already exists${dup.organization ? ' (' + dup.organization + ')' : ''}. Save anyway?`,
          existing: dup
        });
      }
    }
    await db.run(
      `UPDATE volunteers SET name=COALESCE($1,name), phone=COALESCE($2,phone), email=COALESCE($3,email),
        organization=COALESCE($4,organization), notes=COALESCE($5,notes) WHERE id=$6`,
      [name || null, phone !== undefined ? phone : null, email !== undefined ? email : null,
        organization !== undefined ? organization : null, notes !== undefined ? notes : null, req.params.id]
    );
    logActivity(req.user, { action: 'update', entityType: 'volunteer', entityId: Number(req.params.id), label: name });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.delete('/:id', async (req, res) => {
  const existing = await db.get('SELECT name FROM volunteers WHERE id=$1', [req.params.id]);
  await db.run('DELETE FROM volunteers WHERE id=$1', [req.params.id]);
  logActivity(req.user, { action: 'delete', entityType: 'volunteer', entityId: Number(req.params.id), label: existing?.name });
  res.json({ ok: true });
});

// Replace the full set of modules granted directly to this volunteer (admin
// picks from MODULE_KEYS via checkboxes and saves the whole list at once) —
// no committee membership needed, unlike host_member's committee-based grant.
router.get('/:id/modules', async (req, res) => {
  try {
    const rows = await db.all('SELECT module_key FROM volunteer_module_access WHERE volunteer_id=$1 ORDER BY module_key', [req.params.id]);
    res.json(rows.map((r) => r.module_key));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/:id/modules', async (req, res) => {
  const keys = Array.isArray(req.body.module_keys) ? req.body.module_keys : [];
  const invalid = keys.filter((k) => !isValidModuleKey(k));
  if (invalid.length) return res.status(400).json({ error: `Unknown module key(s): ${invalid.join(', ')}` });
  try {
    await db.transaction(async (tx) => {
      await tx.run('DELETE FROM volunteer_module_access WHERE volunteer_id=$1', [req.params.id]);
      for (const key of keys) {
        await tx.run('INSERT INTO volunteer_module_access (volunteer_id, module_key) VALUES ($1,$2) ON CONFLICT DO NOTHING', [req.params.id, key]);
      }
    });
    logActivity(req.user, { action: 'update', entityType: 'volunteer_modules', entityId: Number(req.params.id), details: keys.join(', ') || 'none' });
    res.json({ ok: true, module_keys: keys });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

module.exports = router;
