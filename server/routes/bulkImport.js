// Admin Bulk Import — update existing delegates and host members from an
// uploaded .xlsx or .csv.
//
// Deliberately UPDATE-ONLY. Rows that match nothing are reported back as
// errors and change nothing, rather than being inserted. Creating delegates
// still happens through participants.js's /bulk-upload (which has the
// duplicate-detection guardrails); mixing "update" and "create" into one
// endpoint is how a mistyped reg number silently becomes a phantom delegate,
// which is exactly what produced the 53-delegate reconciliation problem.
//
// Two-step by design:
//   POST /preview  -> parses, matches, diffs, returns what WOULD change
//   POST /apply    -> re-parses the same file and writes, inside one transaction
//
// The file is re-sent for /apply rather than cached server-side, so there's no
// per-admin upload state to expire, and two admins importing at once can't
// collide on a shared slot.

const express = require('express');
const multer = require('multer');
const db = require('../db');
const { readSheet } = require('../lib/sheetReader');
const { logActivity } = require('../lib/activityLogger');
const { normalizeSex } = require('../lib/sex');

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 }
});

// ---------------------------------------------------------------------------
// Target definitions
// ---------------------------------------------------------------------------
// Columns an import is allowed to write, per target. Anything outside this
// list is ignored even if the sheet has a matching header — the whitelist is
// what stops a stray "id" or "badge_token" column from being overwritten.

const TARGETS = {
  delegates: {
    table: 'participants',
    label: 'Delegate',
    keyFields: ['reg_number', 'is_primary'],
    editable: [
      'name', 'phone', 'whatsapp', 'email', 'address', 'designation', 'sex',
      'dietary_preference', 'drink_preference', 'special_requests', 'business_profile',
      'travel_mode', 'travel_number', 'travel_datetime', 'arrival_point',
      'departure_mode', 'departure_number', 'departure_datetime', 'departure_point',
      'pickup_by', 'pickup_vehicle', 'pickup_phone', 'spoc_name', 'spoc_phone',
      'shirt_size', 'tshirt_size', 'waist_size',
      'aadhaar_number', 'passport_number', 'notes'
    ]
  },
  hostmembers: {
    table: 'host_members',
    label: 'Host member',
    keyFields: ['email'],
    editable: [
      'name', 'phone', 'email', 'company', 'designation', 'category', 'sex',
      'leadership_role', 'shirt_size', 'tshirt_size', 'waist_size',
      'payment_status', 'payment_amount', 'payment_mode', 'payment_date', 'notes'
    ]
  }
};

// Fields constrained by a CHECK in db.js. A bad value here fails the whole
// transaction at COMMIT time with an opaque Postgres error, so they're
// validated up front and reported against the offending row instead.
const ENUMS = {
  travel_mode: ['flight', 'train', 'road', 'other'],
  departure_mode: ['flight', 'train', 'road', 'other'],
  payment_status: ['paid', 'pending']
};

// ---------------------------------------------------------------------------
// Value handling
// ---------------------------------------------------------------------------

function normalizePrimaryFlag(raw) {
  const v = String(raw == null ? '' : raw).trim().toLowerCase();
  if (v === '') return null;
  if (['1', 'yes', 'y', 'true', 'primary', 'primary registrant', 'main'].includes(v)) return 1;
  if (['0', 'no', 'n', 'false', 'co', 'co registrant', 'co-registrant', 'spouse', 'accompanying'].includes(v)) return 0;
  return null;
}

function normPhoneKey(p) {
  return String(p || '').replace(/\D/g, '').slice(-10);
}

// Converts a sheet cell into the value to store. Returns { value } or
// { error } — never throws, so one bad cell reports as a row error rather
// than aborting the whole preview.
function coerce(field, raw) {
  const s = String(raw == null ? '' : raw).trim();

  if (field === 'sex') {
    if (s === '') return { value: null };
    const v = normalizeSex(s);
    if (!v) return { error: `sex "${s}" is not recognised (use M or F)` };
    return { value: v };
  }

  if (ENUMS[field]) {
    if (s === '') return { value: null };
    const v = s.toLowerCase();
    if (!ENUMS[field].includes(v)) {
      return { error: `${field} "${s}" must be one of: ${ENUMS[field].join(', ')}` };
    }
    return { value: v };
  }

  if (field === 'payment_amount') {
    if (s === '') return { value: null };
    const n = Number(s.replace(/[^0-9.\-]/g, ''));
    if (!Number.isFinite(n)) return { error: `payment_amount "${s}" is not a number` };
    return { value: n };
  }

  if (field === 'payment_date') {
    if (s === '') return { value: null };
    // Already ISO (the common case — sheetReader normalises date cells to
    // YYYY-MM-DD): take it verbatim. Round-tripping through Date here would
    // reintroduce the UTC shift that cellToString exists to avoid.
    const iso = s.match(/^(\d{4}-\d{2}-\d{2})/);
    if (iso) return { value: iso[1] };
    // Slash/dot dates are read as DAY first (12/08/2026 = 12 August), the
    // Indian convention. JavaScript's Date would read that same string as
    // 8 December, so it is parsed explicitly rather than handed to Date.
    const dmy = s.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4})$/);
    if (dmy) {
      const [, dd, mm, yyyy] = dmy;
      const day = Number(dd), mon = Number(mm);
      if (day < 1 || day > 31 || mon < 1 || mon > 12) {
        return { error: `payment_date "${s}" is not a valid date (expected DD/MM/YYYY)` };
      }
      return { value: `${yyyy}-${String(mon).padStart(2, '0')}-${String(day).padStart(2, '0')}` };
    }
    // Anything else (12 Aug 2026, Aug 12 2026) is unambiguous enough for Date.
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) return { error: `payment_date "${s}" is not a valid date` };
    const p = (n) => String(n).padStart(2, '0');
    return { value: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` };
  }

  return { value: s };
}

// Blank cells mean "leave this field alone", not "clear it". Without this an
// import built from a partial export would wipe every column the sheet didn't
// happen to include. Clearing a field stays a deliberate act done in the form.
function isBlank(v) {
  return v === null || v === undefined || String(v).trim() === '';
}

function sameValue(a, b) {
  if (a === null || a === undefined) return b === null || b === undefined || b === '';
  if (b === null || b === undefined) return String(a).trim() === '';
  return String(a).trim() === String(b).trim();
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

async function loadDelegateIndex(runner) {
  const rows = await runner.all(`
    SELECT p.*, r.reg_number
      FROM participants p
      LEFT JOIN registrations r ON r.id = p.registration_id
  `);
  const byRegPrimary = new Map();   // "SINC-0117|1" -> row
  const byRegOnly = new Map();      // "SINC-0117"   -> [rows]
  for (const r of rows) {
    if (!r.reg_number) continue;
    const reg = String(r.reg_number).trim().toUpperCase();
    byRegPrimary.set(`${reg}|${r.is_primary ? 1 : 0}`, r);
    if (!byRegOnly.has(reg)) byRegOnly.set(reg, []);
    byRegOnly.get(reg).push(r);
  }
  return { rows, byRegPrimary, byRegOnly };
}

async function loadHostIndex(runner) {
  const rows = await runner.all(`SELECT * FROM host_members`);
  const byEmail = new Map();
  const byPhone = new Map();
  for (const r of rows) {
    const e = String(r.email || '').trim().toLowerCase();
    if (e) byEmail.set(e, r);
    const p = normPhoneKey(r.phone);
    if (p) byPhone.set(p, r);
  }
  return { rows, byEmail, byPhone };
}

// Returns { record } or { error } for one sheet row.
function matchDelegate(idx, row) {
  const reg = String(row.reg_number || '').trim().toUpperCase();
  if (!reg) return { error: 'no reg number in this row' };

  const candidates = idx.byRegOnly.get(reg);
  if (!candidates || !candidates.length) return { error: `reg number ${reg} not found` };

  const flag = normalizePrimaryFlag(row.is_primary);

  // A single registration holds exactly one delegate — the primary/co column
  // is then redundant and can be omitted from the sheet.
  if (candidates.length === 1 && flag === null) return { record: candidates[0] };

  if (flag === null) {
    return { error: `${reg} has ${candidates.length} delegates — add an "Is Primary" column (1 = primary, 0 = co-registrant)` };
  }

  const hit = idx.byRegPrimary.get(`${reg}|${flag}`);
  if (!hit) {
    return { error: `${reg} has no ${flag ? 'primary registrant' : 'co-registrant'}` };
  }
  return { record: hit };
}

function matchHostMember(idx, row) {
  const email = String(row.email || '').trim().toLowerCase();
  if (email && idx.byEmail.has(email)) return { record: idx.byEmail.get(email) };

  // Host members are often on file without an email, so phone is a documented
  // fallback rather than a silent guess — the preview names which one matched.
  const phone = normPhoneKey(row.phone);
  if (phone && idx.byPhone.has(phone)) return { record: idx.byPhone.get(phone), via: 'phone' };

  if (!email && !phone) return { error: 'row has neither email nor phone to match on' };
  return { error: `no host member with ${email ? `email ${email}` : `phone ${row.phone}`}` };
}

// ---------------------------------------------------------------------------
// Core: parse -> match -> diff
// ---------------------------------------------------------------------------

async function buildPlan(runner, target, buffer, filename) {
  const cfg = TARGETS[target];
  const { columns, rows, ignored } = readSheet(buffer, filename);

  const editableInSheet = columns.filter((c) => cfg.editable.includes(c));
  if (!editableInSheet.length) {
    throw new Error(`The file has no updatable columns for ${cfg.label.toLowerCase()}s. Download the template to see the expected headers.`);
  }

  const idx = target === 'delegates' ? await loadDelegateIndex(runner) : await loadHostIndex(runner);

  const changes = [];   // { id, row, label, fields: [{field, before, after}] }
  const errors = [];    // { row, message }
  const unchanged = [];
  const seen = new Map();

  for (const r of rows) {
    const m = target === 'delegates' ? matchDelegate(idx, r) : matchHostMember(idx, r);
    if (m.error) { errors.push({ row: r._row, message: m.error }); continue; }
    const rec = m.record;

    // Two sheet rows resolving to one record means the later row silently wins.
    // Better to refuse and let the operator fix the sheet.
    if (seen.has(rec.id)) {
      errors.push({ row: r._row, message: `duplicate — sheet row ${seen.get(rec.id)} already targets ${rec.name}` });
      continue;
    }
    seen.set(rec.id, r._row);

    const fields = [];
    let rowFailed = false;
    for (const field of editableInSheet) {
      if (isBlank(r[field])) continue;              // blank = leave alone
      const c = coerce(field, r[field]);
      if (c.error) { errors.push({ row: r._row, message: c.error }); rowFailed = true; break; }
      if (sameValue(rec[field], c.value)) continue; // no-op
      fields.push({ field, before: rec[field], after: c.value });
    }
    if (rowFailed) continue;

    if (!fields.length) { unchanged.push({ row: r._row, label: rec.name }); continue; }
    changes.push({ id: rec.id, row: r._row, label: rec.name, matchedVia: m.via || null, fields });
  }

  return {
    target,
    table: cfg.table,
    columns: editableInSheet,
    ignoredColumns: ignored,
    totalRows: rows.length,
    changes,
    errors,
    unchangedCount: unchanged.length
  };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

function parseTarget(req) {
  const t = String(req.body.target || req.query.target || '').trim();
  if (!TARGETS[t]) {
    const err = new Error(`target must be one of: ${Object.keys(TARGETS).join(', ')}`);
    err.status = 400;
    throw err;
  }
  return t;
}

// POST /api/bulk-import/preview   (multipart: file, target)
router.post('/preview', upload.single('file'), async (req, res) => {
  try {
    const target = parseTarget(req);
    if (!req.file) return res.status(400).json({ error: 'A file is required (field name: file)' });
    const plan = await buildPlan(db, target, req.file.buffer, req.file.originalname);
    res.json({ ok: true, ...plan });
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message });
  }
});

// POST /api/bulk-import/apply   (multipart: file, target)
router.post('/apply', upload.single('file'), async (req, res) => {
  try {
    const target = parseTarget(req);
    if (!req.file) return res.status(400).json({ error: 'A file is required (field name: file)' });
    const cfg = TARGETS[target];

    const result = await db.transaction(async (tx) => {
      // Re-derived inside the transaction so the diff reflects the data as it
      // is right now, not as it was when the admin clicked Preview.
      const plan = await buildPlan(tx, target, req.file.buffer, req.file.originalname);

      // Refuse a partial write. If the sheet has errors the operator fixes the
      // sheet and re-uploads — a half-applied import is far harder to reason
      // about than one that did nothing.
      if (plan.errors.length) {
        const err = new Error(`${plan.errors.length} row(s) could not be matched or validated. Nothing was written.`);
        err.status = 422;
        err.plan = plan;
        throw err;
      }

      for (const ch of plan.changes) {
        const sets = ch.fields.map((f, i) => `${f.field} = $${i + 1}`).join(', ');
        const vals = ch.fields.map((f) => f.after);
        vals.push(ch.id);
        await tx.run(`UPDATE ${cfg.table} SET ${sets} WHERE id = $${vals.length}`, vals);
      }
      return plan;
    });

    logActivity(req.user, {
      action: 'bulk_update',
      entityType: target === 'delegates' ? 'participant' : 'host_member',
      label: `${result.changes.length} ${cfg.label.toLowerCase()}(s) updated via ${req.file.originalname}`,
      details: `${result.changes.reduce((n, c) => n + c.fields.length, 0)} field(s) changed`
    });

    res.json({
      ok: true,
      updated: result.changes.length,
      fieldsChanged: result.changes.reduce((n, c) => n + c.fields.length, 0),
      unchanged: result.unchangedCount
    });
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message, plan: e.plan || null });
  }
});

// GET /api/bulk-import/template?target=delegates
// Header-only CSV so the operator starts from columns that are guaranteed to
// map, rather than guessing at spellings.
router.get('/template', (req, res) => {
  const t = String(req.query.target || '').trim();
  if (!TARGETS[t]) return res.status(400).json({ error: 'unknown target' });
  const cfg = TARGETS[t];
  const headers = [...cfg.keyFields, ...cfg.editable];
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="sinc2026-${t}-import-template.csv"`);
  res.send(headers.join(',') + '\n');
});

// GET /api/bulk-import/fields — powers the on-screen "accepted columns" help.
router.get('/fields', (req, res) => {
  res.json(Object.fromEntries(
    Object.entries(TARGETS).map(([k, v]) => [k, { label: v.label, key: v.keyFields, editable: v.editable }])
  ));
});

module.exports = router;
module.exports.TARGETS = TARGETS;
module.exports._internals = { coerce, matchDelegate, matchHostMember, normalizePrimaryFlag, buildPlan };
