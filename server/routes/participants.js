const express = require('express');
const multer = require('multer');
const { parse } = require('csv-parse/sync');
const db = require('../db');
const { attachChecklistRoutes, deleteChecklistForOwner } = require('./checklistHelper');
const { saveFile, deleteStoredFile } = require('../uploadHelper');
const { logActivity } = require('../lib/activityLogger');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });
// Separate, size-limited instance for the Photo / Business Card uploads —
// same reasoning as speakers.js's own `upload`: the bulk-CSV `upload` above
// has no size cap (CSVs can legitimately be large), but an image upload
// should be capped so one bad file can't exhaust memory.
const uploadImage = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const FIELDS = [
  'registration_id', 'is_primary', 'name', 'phone', 'whatsapp', 'email', 'address', 'club_id', 'designation',
  'dietary_preference', 'drink_preference', 'special_requests', 'business_profile',
  'travel_mode', 'travel_number', 'travel_datetime', 'arrival_point',
  'departure_mode', 'departure_number', 'departure_datetime', 'departure_point',
  'pickup_by', 'pickup_vehicle', 'pickup_phone', 'spoc_name', 'spoc_phone', 'notes',
  // Congress-wide member data collection — see server/db.js comment.
  'shirt_size', 'tshirt_size', 'waist_size'
  // NOTE: pre-tour interest is NOT a column here — it's a row in the
  // pre_tour_participants join table, set/cleared via PUT /:id/pretour below
  // (mirrored on the public side by publicProfile.js's own /pretour route).
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

// --- Primary registrant / co-registrant guardrails ---
// registration_id + is_primary already exist on `participants` (a 'double'
// registration is just two rows sharing one registration_id, one of them
// is_primary=1). This helper enforces the two rules that keep that pairing
// meaningful instead of just two unlinked rows that happen to share a
// registration: (1) a registration can't hold more delegates than its
// reg_type allows (1 for single/congress_only, 2 for double), and (2) a
// registration can't have two primary registrants at once. Both are hard
// blocks (no `force` override) since — unlike the "possibly the same
// person" duplicate check below — there's no legitimate reason to violate
// either rule; the fix is always to pick a different registration or edit
// the existing delegate instead.
const REG_TYPE_LABEL_SERVER = { single: 'Single', double: 'Double', congress_only: 'Congress Only' };
async function checkRegistrationCapacity(runner, registrationId, isPrimary, excludeId) {
  if (!registrationId) return null;
  const reg = await runner.get('SELECT reg_number, reg_type FROM registrations WHERE id=$1', [registrationId]);
  if (!reg) return null; // an invalid id is left for the FK constraint to reject
  const maxAllowed = reg.reg_type === 'double' ? 2 : 1;
  let sql = 'SELECT id, name, is_primary FROM participants WHERE registration_id=$1';
  const params = [registrationId];
  if (excludeId) {
    sql += ' AND id<>$2';
    params.push(excludeId);
  }
  const existing = await runner.all(sql, params);
  const typeLabel = REG_TYPE_LABEL_SERVER[reg.reg_type] || reg.reg_type;
  if (existing.length >= maxAllowed) {
    return `Registration ${reg.reg_number} is a ${typeLabel} registration and already has ${existing.length}/${maxAllowed} delegate(s) linked. Use a different registration, or edit one of the existing delegates instead.`;
  }
  const wantsPrimary = isPrimary === undefined || isPrimary === null || isPrimary === ''
    ? true // matches the DB column default and the form's default selection
    : (isPrimary === '1' || isPrimary === 1 || isPrimary === true);
  if (wantsPrimary) {
    const existingPrimary = existing.find((p) => Number(p.is_primary) === 1);
    if (existingPrimary) {
      return `Registration ${reg.reg_number} already has a primary registrant (${existingPrimary.name}). Save this delegate as a co-registrant instead.`;
    }
  }
  return null;
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

// A delegate's pre-tour interest lives in pre_tour_participants (not a
// participants column — see server/db.js comment), so it has to be pulled in
// as a subquery. ORDER BY id LIMIT 1 because a delegate is only expected to
// be signed up for one pre-tour at a time (PUT /:id/pretour below enforces
// that by replacing any existing row rather than adding a second one).
const PRETOUR_SELECT = `(SELECT ptp.pre_tour_id FROM pre_tour_participants ptp WHERE ptp.participant_id = p.id ORDER BY ptp.id LIMIT 1) AS pre_tour_id`;

router.get('/', async (req, res) => {
  try {
    const search = req.query.q ? `%${req.query.q}%` : null;
    const rows = search
      ? await db.all(`
          SELECT p.*, r.reg_number, r.reg_type, r.payment_status, c.name AS club_name, ${SPOC_SELECT}, ${PRETOUR_SELECT}
          FROM participants p
          LEFT JOIN registrations r ON r.id = p.registration_id
          LEFT JOIN clubs c ON c.id = p.club_id
          ${SPOC_JOIN}
          WHERE p.name ILIKE $1 OR p.phone ILIKE $1 OR r.reg_number ILIKE $1 OR c.name ILIKE $1
          ORDER BY p.created_at DESC
        `, [search])
      : await db.all(`
          SELECT p.*, r.reg_number, r.reg_type, r.payment_status, c.name AS club_name, ${SPOC_SELECT}, ${PRETOUR_SELECT}
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

// Minimal Host Member lookup for the "SPOC" dropdown — the Delegate
// Registrations module doesn't otherwise grant access to the internal Host
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
      SELECT p.*, r.reg_number, r.reg_type, r.payment_status, c.name AS club_name, ${SPOC_SELECT}, ${PRETOUR_SELECT}
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
    if (body.registration_id) {
      const capacityError = await checkRegistrationCapacity(db, body.registration_id, body.is_primary);
      if (capacityError) return res.status(409).json({ error: capacityError });
    }
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
    if (body.registration_id !== undefined || body.is_primary !== undefined) {
      const currentReg = await db.get('SELECT registration_id, is_primary FROM participants WHERE id=$1', [req.params.id]);
      if (currentReg) {
        const targetRegId = body.registration_id !== undefined ? body.registration_id : currentReg.registration_id;
        const targetIsPrimary = body.is_primary !== undefined ? body.is_primary : currentReg.is_primary;
        if (targetRegId) {
          const capacityError = await checkRegistrationCapacity(db, targetRegId, targetIsPrimary, req.params.id);
          if (capacityError) return res.status(409).json({ error: capacityError });
        }
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

// Sets/replaces/clears a delegate's pre-tour signup (one row in
// pre_tour_participants, same table Pre Tours' own "Manage" sub-panel uses —
// see pretours.js's POST/DELETE /:id/participants). Kept here too so the
// Delegates form's Pre-Tour field can save in the same request cycle as the
// rest of the delegate's edits, without the admin needing the separate Pre
// Tours module grant. Unlike pretours.js's own add route, this deliberately
// does NOT enforce the tour's capacity — an admin manually assigning a
// delegate is an intentional override (e.g. a VIP added after the tour
// nominally filled up); the first-come-first-served capacity cap only
// applies to the public self-service signup in publicProfile.js.
router.put('/:id/pretour', async (req, res) => {
  const pretourId = req.body.pre_tour_id ? Number(req.body.pre_tour_id) : null;
  const participantId = req.params.id;
  try {
    const existing = await db.get('SELECT id, pre_tour_id FROM pre_tour_participants WHERE participant_id=$1 ORDER BY id LIMIT 1', [participantId]);
    if (!pretourId) {
      if (existing) await db.run('DELETE FROM pre_tour_participants WHERE id=$1', [existing.id]);
      return res.json({ ok: true, pre_tour_id: null });
    }
    if (existing && Number(existing.pre_tour_id) === pretourId) {
      return res.json({ ok: true, pre_tour_id: pretourId }); // unchanged — leave payment_status/notes intact
    }
    const tour = await db.get('SELECT id FROM pre_tours WHERE id=$1', [pretourId]);
    if (!tour) return res.status(400).json({ error: 'Selected pre-tour no longer exists.' });
    if (existing) await db.run('DELETE FROM pre_tour_participants WHERE id=$1', [existing.id]);
    await db.run(
      `INSERT INTO pre_tour_participants (pre_tour_id, participant_id, payment_status) VALUES ($1,$2,'pending')`,
      [pretourId, participantId]
    );
    res.json({ ok: true, pre_tour_id: pretourId });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Convenience endpoint mirroring /api/assignments/spoc/:participantId — the
// Delegate Registrations module's committee grant doesn't reach the
// admin-only /api/assignments mount, so the SPOC link (a delegate_assignments
// row, not a participants column) is set from here instead. Keeps at most
// one SPOC assignment per delegate, same transaction logic as assignments.js.
router.put('/:id/spoc', async (req, res) => {
  const { host_member_id } = req.body;
  const participantId = req.params.id;
  try {
    await db.transaction(async (tx) => {
      await tx.run(`DELETE FROM delegate_assignments WHERE participant_id=$1 AND role='SPOC'`, [participantId]);
      if (host_member_id) {
        await tx.run(`
          INSERT INTO delegate_assignments (host_member_id, participant_id, role, status)
          VALUES ($1,$2,'SPOC','not_started')
          ON CONFLICT (host_member_id, participant_id) DO UPDATE SET role='SPOC'
        `, [host_member_id, participantId]);
      }
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.delete('/:id', async (req, res) => {
  const existing = await db.get('SELECT name, photo_url, business_card_url FROM participants WHERE id=$1', [req.params.id]);
  if (existing) {
    await deleteStoredFile(existing.photo_url);
    await deleteStoredFile(existing.business_card_url);
  }
  await deleteChecklistForOwner('participant', req.params.id);
  await db.run('DELETE FROM participants WHERE id=$1', [req.params.id]);
  logActivity(req.user, { action: 'delete', entityType: 'participant', entityId: Number(req.params.id), label: existing?.name });
  res.json({ ok: true });
});

// Delegate's own photo — shown on their profile. Replaces any existing
// photo (old file is deleted so storage doesn't leak). Same pattern as
// speakers.js's speaker photo upload.
router.post('/:id/photo', (req, res, next) => {
  uploadImage.single('file')(req, res, (err) => {
    if (err) {
      const friendly = err.code === 'LIMIT_FILE_SIZE' ? 'Photo is too large (max 10MB).' : 'Upload was interrupted — please try again.';
      return res.status(400).json({ error: friendly });
    }
    next();
  });
}, async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'file is required' });
  try {
    const existing = await db.get('SELECT photo_url FROM participants WHERE id=$1', [req.params.id]);
    if (!existing) return res.status(404).json({ error: 'Delegate not found' });
    const storedPath = await saveFile(req.file, 'participant-photos');
    await db.run('UPDATE participants SET photo_url=$1 WHERE id=$2', [storedPath, req.params.id]);
    if (existing.photo_url) await deleteStoredFile(existing.photo_url);
    res.json({ photo_url: storedPath });
  } catch (e) {
    console.error('Delegate photo upload failed —', e.message);
    res.status(500).json({ error: 'Upload failed: ' + e.message });
  }
});

router.delete('/:id/photo', async (req, res) => {
  try {
    const existing = await db.get('SELECT photo_url FROM participants WHERE id=$1', [req.params.id]);
    if (!existing) return res.status(404).json({ error: 'Delegate not found' });
    await db.run('UPDATE participants SET photo_url=NULL WHERE id=$1', [req.params.id]);
    if (existing.photo_url) await deleteStoredFile(existing.photo_url);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Photo/scan of the delegate's business card — same upload mechanism as
// their profile photo, stored as a separate field.
router.post('/:id/business-card', (req, res, next) => {
  uploadImage.single('file')(req, res, (err) => {
    if (err) {
      const friendly = err.code === 'LIMIT_FILE_SIZE' ? 'Image is too large (max 10MB).' : 'Upload was interrupted — please try again.';
      return res.status(400).json({ error: friendly });
    }
    next();
  });
}, async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'file is required' });
  try {
    const existing = await db.get('SELECT business_card_url FROM participants WHERE id=$1', [req.params.id]);
    if (!existing) return res.status(404).json({ error: 'Delegate not found' });
    const storedPath = await saveFile(req.file, 'participant-business-cards');
    await db.run('UPDATE participants SET business_card_url=$1 WHERE id=$2', [storedPath, req.params.id]);
    if (existing.business_card_url) await deleteStoredFile(existing.business_card_url);
    res.json({ business_card_url: storedPath });
  } catch (e) {
    console.error('Delegate business card upload failed —', e.message);
    res.status(500).json({ error: 'Upload failed: ' + e.message });
  }
});

router.delete('/:id/business-card', async (req, res) => {
  try {
    const existing = await db.get('SELECT business_card_url FROM participants WHERE id=$1', [req.params.id]);
    if (!existing) return res.status(404).json({ error: 'Delegate not found' });
    await db.run('UPDATE participants SET business_card_url=NULL WHERE id=$1', [req.params.id]);
    if (existing.business_card_url) await deleteStoredFile(existing.business_card_url);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
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
             drink_preference, special_requests, business_profile,
             travel_mode, travel_number, travel_datetime, arrival_point,
             departure_mode, departure_number, departure_datetime, departure_point,
             pickup_by, pickup_vehicle, pickup_phone, spoc_name, spoc_phone, notes)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27)
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
          r.drink_preference || null,
          r.special_requests || '',
          r.business_profile || null,
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
