const express = require('express');
const multer = require('multer');
const { parse } = require('csv-parse/sync');
const db = require('../db');
const { attachChecklistRoutes, deleteChecklistForOwner } = require('./checklistHelper');
const { logActivity } = require('../lib/activityLogger');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

// --- Duplicate-entry protection ---
// Host members are frequently re-entered (a re-run of the Excel import, a
// second manual add of the same person). We match on phone number first
// (most reliable), falling back to an exact case-insensitive name match only
// when no phone is on file for either side.
function normPhone(p) {
  return (p || '').replace(/\D/g, '').slice(-10);
}
function normName(n) {
  return (n || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

async function findDuplicateHostMember(runner, { name, phone, excludeId }) {
  const np = normPhone(phone);
  const nn = normName(name);
  let row = null;
  if (np) {
    let sql = `SELECT id, name, phone, company FROM host_members WHERE phone <> '' AND RIGHT(regexp_replace(phone, '[^0-9]', '', 'g'), 10) = $1`;
    const params = [np];
    if (excludeId) { sql += ' AND id <> $2'; params.push(excludeId); }
    sql += ' LIMIT 1';
    row = await runner.get(sql, params);
  }
  if (!row && nn) {
    let sql = `SELECT id, name, phone, company FROM host_members WHERE lower(trim(name)) = $1`;
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
      SELECT hm.*,
        COALESCE(
          (SELECT json_agg(json_build_object('id', c.id, 'name', c.name))
           FROM committee_members cmem JOIN committees c ON c.id = cmem.committee_id
           WHERE cmem.host_member_id = hm.id),
          '[]'
        ) AS committees,
        (SELECT COUNT(*) FROM delegate_assignments da WHERE da.host_member_id = hm.id) AS assignment_count,
        (SELECT u.id FROM users u WHERE u.host_member_id = hm.id LIMIT 1) AS user_id
      FROM host_members hm
      ORDER BY hm.name
    `);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const row = await db.get('SELECT * FROM host_members WHERE id=$1', [req.params.id]);
    if (!row) return res.status(404).json({ error: 'not found' });
    res.json(row);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/', async (req, res) => {
  const { name, email, phone, company, designation, category, payment_status, payment_amount, payment_date, payment_mode, notes, force } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  try {
    if (!force) {
      const dup = await findDuplicateHostMember(db, { name, phone });
      if (dup) {
        return res.status(409).json({
          error: 'duplicate',
          message: `A host member named "${dup.name}"${dup.phone ? ' with phone ' + dup.phone : ''} already exists${dup.company ? ' (' + dup.company + ')' : ''}. Save anyway?`,
          existing: dup
        });
      }
    }
    const result = await db.run(`
      INSERT INTO host_members (name, email, phone, company, designation, category, payment_status, payment_amount, payment_date, payment_mode, notes)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id
    `, [name, email || '', phone || '', company || '', designation || '', category || '',
        payment_status || 'pending', Number(payment_amount) || 5000, payment_date || null, payment_mode || '', notes || '']);
    logActivity(req.user, { action: 'create', entityType: 'host_member', entityId: result.id, label: name });
    res.json({ id: result.id });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.put('/:id', async (req, res) => {
  const { name, email, phone, company, designation, category, payment_status, payment_amount, payment_date, payment_mode, notes, force } = req.body;
  try {
    if (!force && (name !== undefined || phone !== undefined)) {
      const current = await db.get('SELECT name, phone FROM host_members WHERE id=$1', [req.params.id]);
      const candidate = {
        name: name !== undefined ? name : current && current.name,
        phone: phone !== undefined ? phone : current && current.phone
      };
      const dup = await findDuplicateHostMember(db, { ...candidate, excludeId: req.params.id });
      if (dup) {
        return res.status(409).json({
          error: 'duplicate',
          message: `A host member named "${dup.name}"${dup.phone ? ' with phone ' + dup.phone : ''} already exists${dup.company ? ' (' + dup.company + ')' : ''}. Save anyway?`,
          existing: dup
        });
      }
    }
    await db.run(`
      UPDATE host_members SET
        name=COALESCE($1,name), email=COALESCE($2,email), phone=COALESCE($3,phone),
        company=COALESCE($4,company), designation=COALESCE($5,designation), category=COALESCE($6,category),
        payment_status=COALESCE($7,payment_status), payment_amount=COALESCE($8,payment_amount),
        payment_date=COALESCE($9,payment_date), payment_mode=COALESCE($10,payment_mode), notes=COALESCE($11,notes)
      WHERE id=$12
    `, [name || null, email || null, phone || null, company || null, designation || null, category || null,
        payment_status || null, payment_amount !== undefined ? Number(payment_amount) : null,
        payment_date || null, payment_mode || null, notes !== undefined ? notes : null, req.params.id]);
    logActivity(req.user, { action: 'update', entityType: 'host_member', entityId: Number(req.params.id), label: name });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.delete('/:id', async (req, res) => {
  const existing = await db.get('SELECT name FROM host_members WHERE id=$1', [req.params.id]);
  await deleteChecklistForOwner('host_member', req.params.id);
  await db.run('DELETE FROM host_members WHERE id=$1', [req.params.id]);
  logActivity(req.user, { action: 'delete', entityType: 'host_member', entityId: Number(req.params.id), label: existing?.name });
  res.json({ ok: true });
});

// Goodies/kit handover checklist — same generic mechanism as sponsors/speakers.
// GET/POST /:id/checklist.
attachChecklistRoutes(router, 'host_member');

// Bulk CSV upload: name,email,phone,company,designation,category
// Matches existing host members by phone number (or exact name if no phone
// on either side) and updates them instead of creating a duplicate row.
router.post('/bulk-upload', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'CSV file is required (field name: file)' });
  try {
    const records = parse(req.file.buffer.toString('utf8'), { columns: true, skip_empty_lines: true, trim: true });
    let inserted = 0, updated = 0;
    await db.transaction(async (tx) => {
      for (const r of records) {
        const name = r.name || r.Name;
        if (!name) continue;
        const phone = r.phone || '';
        const dup = await findDuplicateHostMember(tx, { name, phone });
        if (dup) {
          await tx.run(`
            UPDATE host_members SET name=$1, email=COALESCE(NULLIF($2,''),email), phone=COALESCE(NULLIF($3,''),phone),
              company=COALESCE(NULLIF($4,''),company), designation=COALESCE(NULLIF($5,''),designation),
              category=COALESCE(NULLIF($6,''),category)
            WHERE id=$7
          `, [name, r.email || '', phone, r.company || '', r.designation || '', r.category || '', dup.id]);
          updated++;
        } else {
          await tx.run(`
            INSERT INTO host_members (name, email, phone, company, designation, category)
            VALUES ($1,$2,$3,$4,$5,$6)
          `, [name, r.email || '', phone, r.company || '', r.designation || '', r.category || '']);
          inserted++;
        }
      }
    });
    if (inserted || updated) logActivity(req.user, { action: 'bulk_create', entityType: 'host_member', label: `${inserted} added, ${updated} updated via CSV` });
    res.json({ ok: true, imported: inserted, updated });
  } catch (e) {
    res.status(400).json({ error: 'Failed to parse/import CSV: ' + e.message });
  }
});

module.exports = router;
