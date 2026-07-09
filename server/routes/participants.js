const express = require('express');
const multer = require('multer');
const { parse } = require('csv-parse/sync');
const db = require('../db');
const { attachChecklistRoutes, deleteChecklistForOwner } = require('./checklistHelper');
const { logActivity } = require('../lib/activityLogger');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

const FIELDS = [
  'registration_id', 'is_primary', 'name', 'phone', 'whatsapp', 'email', 'address', 'club_id', 'designation',
  'dietary_preference',
  'travel_mode', 'travel_number', 'travel_datetime', 'arrival_point',
  'departure_mode', 'departure_number', 'departure_datetime', 'departure_point',
  'pickup_by', 'pickup_vehicle', 'pickup_phone', 'spoc_name', 'spoc_phone', 'notes'
];

// Core identity/registration fields — once a delegate exists, only a super
// admin can change these (everyone else can still freely edit travel info,
// pickup/SPOC, notes, etc.). Enforced here server-side (not just hidden/
// disabled in the admin UI) so a non-super-admin can't bypass the freeze via
// a direct API call — same pattern as the global super-admin-only DELETE
// restriction enforced in server/index.js.
const FROZEN_FIELDS = ['name', 'phone', 'club_id', 'registration_id'];
function normalizeForCompare(v) {
  return v === undefined || v === null ? '' : String(v);
}

// --- Duplicate-entry protection ---
// The same person often gets entered more than once (a CSV re-import, a
// second WhatsApp form submission, manual double entry). We treat two rows
// as the "same person" only when the name matches AND at least one strong
// identifier (phone or email) also matches — name alone is too common
// (many "Ramesh Kumar"s) to safely auto-block on.
function normName(n) {
  return (n || '').trim().toLowerCase().replace(/\s+/g, ' ');
}
function normPhone(p) {
  return (p || '').replace(/\D/g, '').slice(-10);
}
function normEmail(e) {
  return (e || '').trim().toLowerCase();
}

async function findDuplicate(runner, { name, phone, email, excludeId }) {
  const nn = normName(name);
  if (!nn) return null;
  const np = normPhone(phone);
  const ne = normEmail(email);
  if (!np && !ne) return null; // not enough signal to safely flag as a duplicate

  const conditions = [];
  const params = [nn];
  let idx = 2;
  if (np) {
    conditions.push(`RIGHT(regexp_replace(COALESCE(p.phone,''), '[^0-9]', '', 'g'), 10) = $${idx}`);
    params.push(np);
    idx++;
  }
  if (ne) {
    conditions.push(`lower(trim(COALESCE(p.email,''))) = $${idx}`);
    params.push(ne);
    idx++;
  }
  let sql = `
    SELECT p.id, p.name, p.phone, p.email, p.participant_code, r.reg_number
    FROM participants p
    LEFT JOIN registrations r ON r.id = p.registration_id
    WHERE lower(trim(p.name)) = $1 AND (${conditions.join(' OR ')})
  `;
  if (excludeId) {
    sql += ` AND p.id <> $${idx}`;
    params.push(excludeId);
  }
  sql += ' LIMIT 1';
  return runner.get(sql, params);
}

// Every participant SELECT joins in the linked "SPOC" delegate_assignment
// (if one exists) so the admin table can show a real host member as SPOC
// instead of the old free-text spoc_name/spoc_phone fields. Legacy free text
// is kept as a fallback for rows that predate this feature.
const SPOC_JOIN = `
  LEFT JOIN delegate_assignments spoc_da ON spoc_da.participant_id = p.id AND spoc_da.role = 'SPOC'
  LEFT JOIN host_members spoc_hm ON spoc_hm.id = spoc_da.host_member_id
`;
const SPOC_SELECT = `spoc_hm.id AS spoc_host_member_id, spoc_hm.name AS spoc_host_member_name, spoc_hm.phone AS spoc_host_member_phone`;

router.get('/', async (req, res) => {
  try {
    const search = req.query.q ? `%${req.query.q}%` : null;
    const rows = search
      ? await db.all(`
          SELECT p.*, r.reg_number, r.reg_type, r.payment_status, c.name AS club_name, ${SPOC_SELECT}
          FROM participants p
          LEFT JOIN registrations r ON r.id = p.registration_id
          LEFT JOIN clubs c ON c.id = p.club_id
          ${SPOC_JOIN}
          WHERE p.name ILIKE $1 OR p.phone ILIKE $1 OR r.reg_number ILIKE $1 OR c.name ILIKE $1
          ORDER BY p.created_at DESC
        `, [search])
      : await db.all(`
          SELECT p.*, r.reg_number, r.reg_type, r.payment_status, c.name AS club_name, ${SPOC_SELECT}
          FROM participants p
          LEFT JOIN registrations r ON r.id = p.registration_id
          LEFT JOIN clubs c ON c.id = p.club_id
          ${SPOC_JOIN}
          ORDER BY p.created_at DESC
        `);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const row = await db.get(`
      SELECT p.*, r.reg_number, r.reg_type, r.payment_status, c.name AS club_name, ${SPOC_SELECT}
      FROM participants p
      LEFT JOIN registrations r ON r.id = p.registration_id
      LEFT JOIN clubs c ON c.id = p.club_id
      ${SPOC_JOIN}
      WHERE p.id = $1
    `, [req.params.id]);
    if (!row) return res.status(404).json({ error: 'not found' });
    res.json(row);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/', async (req, res) => {
  const body = req.body;
  if (!body.name) return res.status(400).json({ error: 'name is required' });
  try {
    if (!body.force) {
      const dup = await findDuplicate(db, { name: body.name, phone: body.phone, email: body.email });
      if (dup) {
        return res.status(409).json({
          error: 'duplicate',
          message: `A participant named "${dup.name}" with a matching phone/email already exists (Registration ID ${dup.participant_code || '—'}, Reg# ${dup.reg_number || '—'}). Save anyway?`,
          existing: dup
        });
      }
    }
    const cols = FIELDS.filter((f) => body[f] !== undefined);
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(',');
    const values = cols.map((c) => body[c]);
    const result = await db.run(
      `INSERT INTO participants (${cols.join(',')}) VALUES (${placeholders}) RETURNING id, participant_code`,
      values
    );
    const row = result.rows[0] || {};
    logActivity(req.user, { action: 'create', entityType: 'participant', entityId: row.id, label: body.name });
    res.json({ id: row.id, participant_code: row.participant_code });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.put('/:id', async (req, res) => {
  const body = req.body;
  try {
    if (req.user && req.user.role !== 'super_admin') {
      const current = await db.get('SELECT name, phone, club_id, registration_id FROM participants WHERE id=$1', [req.params.id]);
      if (!current) return res.status(404).json({ error: 'Delegate not found.' });
      const changedFrozen = FROZEN_FIELDS.filter(
        (f) => body[f] !== undefined && normalizeForCompare(body[f]) !== normalizeForCompare(current[f])
      );
      if (changedFrozen.length) {
        return res.status(403).json({
          error: `Only a super admin can change ${changedFrozen.join(', ')} for an existing delegate.`
        });
      }
    }
    if (!body.force && (body.name !== undefined || body.phone !== undefined || body.email !== undefined)) {
      const current = await db.get('SELECT name, phone, email FROM participants WHERE id=$1', [req.params.id]);
      const candidate = {
        name: body.name !== undefined ? body.name : current && current.name,
        phone: body.phone !== undefined ? body.phone : current && current.phone,
        email: body.email !== undefined ? body.email : current && current.email
      };
      const dup = await findDuplicate(db, { ...candidate, excludeId: req.params.id });
      if (dup) {
        return res.status(409).json({
          error: 'duplicate',
          message: `A participant named "${dup.name}" with a matching phone/email already exists (Registration ID ${dup.participant_code || '—'}, Reg# ${dup.reg_number || '—'}). Save anyway?`,
          existing: dup
        });
      }
    }
    const cols = FIELDS.filter((f) => body[f] !== undefined);
    if (cols.length === 0) return res.json({ ok: true });
    const setClause = cols.map((c, i) => `${c}=$${i + 1}`).join(',');
    const values = cols.map((c) => body[c]);
    await db.run(`UPDATE participants SET ${setClause} WHERE id=$${cols.length + 1}`, [...values, req.params.id]);
    logActivity(req.user, { action: 'update', entityType: 'participant', entityId: Number(req.params.id), label: body.name });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.delete('/:id', async (req, res) => {
  const existing = await db.get('SELECT name FROM participants WHERE id=$1', [req.params.id]);
  await deleteChecklistForOwner('participant', req.params.id);
  await db.run('DELETE FROM participants WHERE id=$1', [req.params.id]);
  logActivity(req.user, { action: 'delete', entityType: 'participant', entityId: Number(req.params.id), label: existing?.name });
  res.json({ ok: true });
});

// Goodies/kit handover checklist (welcome kit, delegate bag, souvenir, ID
// badge, etc.) — fully customizable per delegate, same generic mechanism used
// for sponsor benefits / speaker checklists. GET/POST /:id/checklist.
attachChecklistRoutes(router, 'participant');

// Bulk CSV upload matching participant + dietary + travel + pickup + SPOC fields
router.post('/bulk-upload', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'CSV file is required (field name: file)' });
  try {
    const records = parse(req.file.buffer.toString('utf8'), { columns: true, skip_empty_lines: true, trim: true });
    let imported = 0;
    const skipped = [];
    await db.transaction(async (tx) => {
      for (const r of records) {
        const forceRow = ['1', 'true', 'yes'].includes(String(r.force || '').toLowerCase());
        if (!forceRow) {
          const dup = await findDuplicate(tx, { name: r.name, phone: r.phone, email: r.email });
          if (dup) {
            skipped.push({ name: r.name, reason: `Matches existing ${dup.participant_code || 'participant'} (${dup.name})` });
            continue;
          }
        }
        const club = r.club_name ? await tx.get('SELECT id FROM clubs WHERE name = $1', [r.club_name]) : null;
        const reg = r.reg_number ? await tx.get('SELECT id FROM registrations WHERE reg_number = $1', [r.reg_number]) : null;
        await tx.run(`
          INSERT INTO participants
            (registration_id, is_primary, name, phone, whatsapp, email, address, club_id, designation, dietary_preference,
             travel_mode, travel_number, travel_datetime, arrival_point,
             departure_mode, departure_number, departure_datetime, departure_point,
             pickup_by, pickup_vehicle, pickup_phone, spoc_name, spoc_phone, notes)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)
        `, [
          reg ? reg.id : null,
          r.is_primary !== undefined ? Number(r.is_primary) : 1,
          r.name || '',
          r.phone || '',
          r.whatsapp || r.phone || '',
          r.email || '',
          r.address || '',
          club ? club.id : null,
          r.designation || '',
          r.dietary_preference || null,
          r.travel_mode || null,
          r.travel_number || '',
          r.travel_datetime || '',
          r.arrival_point || '',
          r.departure_mode || null,
          r.departure_number || '',
          r.departure_datetime || '',
          r.departure_point || '',
          r.pickup_by || '',
          r.pickup_vehicle || '',
          r.pickup_phone || '',
          r.spoc_name || '',
          r.spoc_phone || '',
          r.notes || ''
        ]);
        imported++;
      }
    });
    if (imported) logActivity(req.user, { action: 'bulk_create', entityType: 'participant', label: `${imported} delegate(s) via CSV`, details: `${skipped.length} skipped` });
    res.json({ ok: true, imported, skipped: skipped.length, duplicates: skipped });
  } catch (e) {
    res.status(400).json({ error: 'Failed to parse/import CSV: ' + e.message });
  }
});

module.exports = router;
