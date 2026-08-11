// GST tax invoices for registrations, sponsors, stall bookings and host
// member contributions.
//
// Design constraints that drive most of what follows:
//
//  * An issued invoice can be corrected in place (PUT /:id), but never
//    silently: every field change is written to invoice_revisions first, in the
//    same transaction, with the old value, the new value and who made it. The
//    invoice number itself is immutable, so a copy already sitting in someone's
//    inbox always still refers to this document. Cancellation remains available
//    for a mistake too fundamental to correct — the number stays consumed so
//    the series has no gap.
//
//  * Amounts are never taken from the client on edit. Changing the amount,
//    rate, basis or party state re-runs computeGst server-side, so the tax
//    lines can never end up disagreeing with the amount they were computed from.
//
//  * Numbers come from invoice_counters under a row lock, so two admins
//    clicking "Issue" at the same moment cannot be handed the same number.
//
//  * Nothing can be issued until the club's own GSTIN is set and valid. An
//    invoice without a correct supplier GSTIN is worse than no invoice — the
//    recipient cannot claim credit and the series has to be reissued.
//
// None of this is tax advice: the rate, the SAC and whether a particular
// receipt is a taxable supply at all are decisions for whoever files returns.

const express = require('express');
const db = require('../db');
const { validateGstin, computeGst, amountInWords } = require('../lib/gst');
const { logActivity } = require('../lib/activityLogger');
const resend = require('../lib/resendHelper');

const router = express.Router();

// Series prefix per module. Separate books so an auditor can see at a glance
// what a number refers to, and so a gap in one cannot be caused by another.
const MODULES = {
  // 'DEL' for delegate. Was 'REG' until 10 Aug 2026; any invoice already
  // issued under SINC/<FY>/REG keeps its number, because an invoice number is
  // permanent once raised. That leaves the REG book closed at whatever it had
  // reached and DEL starting fresh at 0001 — two series in the ledger rather
  // than a renumbered one, which is the correct way round: renumbering an
  // issued invoice would break the copy the delegate already holds.
  registration: { series: 'DEL', label: 'Delegate registration' },
  sponsor: { series: 'SPN', label: 'Sponsorship' },
  stall: { series: 'STL', label: 'Exhibition stall' },
  host_member: { series: 'HST', label: 'Host club contribution' }
};

// Indian financial year: 1 April to 31 March. Invoice series restart each year.
function financialYear(d = new Date()) {
  const y = d.getFullYear();
  const startYear = d.getMonth() >= 3 ? y : y - 1;
  return `${String(startYear).slice(2)}-${String(startYear + 1).slice(2)}`;
}

async function getOrg(runner) {
  return runner.get('SELECT * FROM org_settings WHERE id = 1');
}

// The party being billed, per module. Each returns a common shape so the
// issue path stays identical regardless of what is being invoiced.
async function loadParty(runner, module, entityId) {
  if (module === 'registration') {
    const r = await runner.get(`
      SELECT r.id, r.reg_number, r.reg_type, r.amount_paid, r.amount_due, r.payment_status,
             p.name, p.company, p.gstin, p.billing_address, p.state_code, p.address, p.notes, p.email
        FROM registrations r
        LEFT JOIN participants p ON p.registration_id = r.id AND p.is_primary = 1
       WHERE r.id = $1
    `, [entityId]);
    if (!r) return null;
    return {
      email: r.email || null,
      name: r.company || r.name || 'Delegate',
      // A company-paid registration is billed to the company with the
      // delegate named beneath; an individual is billed directly.
      attention: r.company ? r.name : null,
      address: r.billing_address || r.address || null,
      // Falls back to the GSTIN buried in the import notes blob for rows the
      // office has not yet re-entered against the proper column.
      gstin: r.gstin || (String(r.notes || '').match(/GSTIN[^:]*:\s*([A-Za-z0-9]+)/) || [])[1] || null,
      state_code: r.state_code || null,
      amount: Number(r.amount_paid) || 0,
      reference: r.reg_number,
      description: `SINC2026 delegate registration (${r.reg_type || 'registration'}) — ${r.reg_number}`
    };
  }
  if (module === 'sponsor') {
    const s = await runner.get('SELECT * FROM sponsors WHERE id = $1', [entityId]);
    if (!s) return null;
    return {
      email: s.email || null,
      name: s.name, attention: s.contact_person || null,
      address: s.billing_address || null, gstin: s.gstin || null, state_code: s.state_code || null,
      // Sponsors already had payment_amount long before the invoice work
      // added `amount`; prefer whichever is set so existing sponsors are
      // invoiceable without re-keying the figure.
      amount: Number(s.amount || s.payment_amount) || 0, reference: `SPONSOR-${s.id}`,
      description: `SINC2026 sponsorship${s.tier ? ' — ' + s.tier : ''}`
    };
  }
  if (module === 'stall') {
    const b = await runner.get(`
      SELECT b.*, s.stall_number, h.name AS hall_name
        FROM stall_bookings b
        LEFT JOIN stalls s ON s.id = b.stall_id
        LEFT JOIN stall_halls h ON h.id = s.hall_id
       WHERE b.id = $1
    `, [entityId]);
    if (!b) return null;
    return {
      email: b.email || null,
      name: b.company_name, attention: b.contact_person || null,
      address: null, gstin: b.gstin || null, state_code: b.state_code || null,
      amount: Number(b.amount) || 0, reference: `STALL-${b.id}`,
      description: `SINC2026 exhibition stall${b.stall_number ? ` — ${b.hall_name || 'Hall'} ${b.stall_number}` : ''}`
    };
  }
  if (module === 'host_member') {
    const h = await runner.get('SELECT * FROM host_members WHERE id = $1', [entityId]);
    if (!h) return null;
    return {
      email: h.email || null,
      name: h.name, attention: null, address: null,
      gstin: h.gstin || null, state_code: null,
      amount: Number(h.payment_amount) || 0, reference: `HOST-${h.id}`,
      description: 'SINC2026 host club contribution'
    };
  }
  return null;
}

// Reserves the next number in a series. SELECT ... FOR UPDATE serialises
// concurrent callers on the counter row rather than letting both read the
// same last_number.
async function nextInvoiceNumber(tx, seriesPrefix) {
  const fy = financialYear();
  const series = `SINC/${fy}/${seriesPrefix}`;
  await tx.run('INSERT INTO invoice_counters (series, last_number) VALUES ($1, 0) ON CONFLICT (series) DO NOTHING', [series]);
  const row = await tx.get('SELECT last_number FROM invoice_counters WHERE series = $1 FOR UPDATE', [series]);
  const next = Number(row.last_number) + 1;
  await tx.run('UPDATE invoice_counters SET last_number = $1 WHERE series = $2', [next, series]);
  return { series, invoice_number: `${series}/${String(next).padStart(4, '0')}` };
}

// --- org settings ----------------------------------------------------------

router.get('/settings', async (req, res) => {
  try {
    const org = await getOrg(db);
    const check = org && org.gstin ? validateGstin(org.gstin, org.state_code) : null;
    res.json({ ok: true, settings: org || null, gstin_check: check });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/settings', async (req, res) => {
  const b = req.body || {};
  try {
    // A GSTIN that fails structure or checksum is refused outright. A valid
    // one whose state disagrees with the address is allowed but reported —
    // an organisation can legitimately be registered elsewhere, so that is a
    // judgement call for the office, not a hard block.
    let check = null;
    if (b.gstin) {
      check = validateGstin(b.gstin, b.state_code || (await getOrg(db) || {}).state_code);
      if (!check.valid) {
        return res.status(400).json({ error: 'That GSTIN is not valid: ' + check.errors.join(' '), gstin_check: check });
      }
    }
    const fields = ['legal_name', 'address', 'city', 'state', 'state_code', 'pincode', 'gstin', 'pan',
      'email', 'phone', 'default_gst_rate', 'default_sac', 'tax_basis', 'bank_details', 'invoice_footer'];
    const sets = [], vals = [];
    for (const f of fields) {
      if (b[f] === undefined) continue;
      vals.push(f === 'gstin' ? String(b[f] || '').toUpperCase().trim() || null : (b[f] === '' ? null : b[f]));
      sets.push(`${f} = $${vals.length}`);
    }
    if (!sets.length) return res.status(400).json({ error: 'Nothing to update.' });
    sets.push('updated_at = NOW()');
    await db.run(`UPDATE org_settings SET ${sets.join(', ')} WHERE id = 1`, vals);
    logActivity(req.user, { action: 'update', entityType: 'org_settings', label: 'GST / invoice settings' });
    res.json({ ok: true, gstin_check: check });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// --- preview ---------------------------------------------------------------
// Shows exactly what would be issued without consuming an invoice number.

router.get('/preview/:module/:entityId', async (req, res) => {
  try {
    const cfg = MODULES[req.params.module];
    if (!cfg) return res.status(400).json({ error: 'Unknown module.' });
    const org = await getOrg(db);
    const party = await loadParty(db, req.params.module, Number(req.params.entityId));
    if (!party) return res.status(404).json({ error: 'That record no longer exists.' });

    const rate = Number(req.query.rate ?? org.default_gst_rate);
    const basis = req.query.basis || org.tax_basis;
    const gst = computeGst({ amount: party.amount, rate, basis, orgStateCode: org.state_code, partyStateCode: party.state_code, partyGstin: party.gstin });
    const partyCheck = party.gstin ? validateGstin(party.gstin, null) : null;

    res.json({
      ok: true, module: req.params.module, label: cfg.label,
      org, party, ...gst, sac: org.default_sac,
      amount_in_words: amountInWords(gst.total),
      party_gstin_check: partyCheck,
      blockers: issueBlockers(org, party),
      warnings: issueWarnings(org, party)
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Reasons this cannot be issued yet. Returned by both preview and issue so the
// screen can explain the problem before the button is pressed.
function issueBlockers(org, party) {
  const out = [];
  if (!org || !org.gstin) out.push('The club GSTIN has not been set — add it under GST Settings before issuing invoices.');
  else if (!validateGstin(org.gstin, org.state_code).valid) out.push('The club GSTIN on file is not valid.');
  if (!org || !org.legal_name) out.push('The club legal name has not been set.');
  if (!party) out.push('The record being invoiced no longer exists.');
  else if (!(Number(party.amount) > 0)) out.push('This record has no amount recorded, so there is nothing to invoice.');
  return out;
}

// Things that do NOT stop an invoice being raised, but that whoever is raising
// it should see and consciously accept first. Kept separate from issueBlockers
// on purpose: a blocker means "cannot", a warning means "are you sure".
//
// A missing party GSTIN is the important one — it makes the invoice B2C, which
// means the recipient cannot claim input credit on it, and it cannot be fixed
// by them afterwards without the invoice being reissued. Far cheaper to pause
// and ask than to reissue later.
function issueWarnings(org, party) {
  const out = [];
  if (!party) return out;
  if (!party.gstin) {
    out.push('No GSTIN on file for this party. The invoice will be raised as B2C (unregistered), so they will not be able to claim input tax credit on it. Add their GSTIN first if they have one.');
  } else {
    const check = validateGstin(party.gstin, null);
    if (!check.valid) out.push(`The GSTIN on file (${party.gstin}) does not look valid: ${check.reason || 'failed the checksum'}. It will be printed on the invoice exactly as stored.`);
  }
  if (!party.state_code) {
    out.push('No state code on file, so the invoice will be taxed as intra-state (CGST + SGST). If this party is outside Tamil Nadu it should be IGST instead.');
  }
  if (!party.email) out.push('No email address on file for this party, so the invoice cannot be emailed until one is entered.');
  return out;
}

// --- issue -----------------------------------------------------------------

router.post('/issue', async (req, res) => {
  const module = String(req.body.module || '');
  const entityId = Number(req.body.entity_id);
  const cfg = MODULES[module];
  if (!cfg) return res.status(400).json({ error: 'Unknown module.' });
  if (!entityId) return res.status(400).json({ error: 'entity_id is required.' });

  try {
    const result = await db.transaction(async (tx) => {
      const org = await getOrg(tx);
      const party = await loadParty(tx, module, entityId);
      const blockers = issueBlockers(org, party);
      if (blockers.length) {
        const err = new Error(blockers.join(' '));
        err.status = 409; err.blockers = blockers;
        throw err;
      }

      // Warnings (chiefly: no GSTIN on file) must be acknowledged explicitly.
      // Enforced here rather than only in the browser so the confirmation
      // can't be bypassed by calling the API directly — the point is that a
      // human saw the B2C consequence before the number was consumed.
      const warnings = issueWarnings(org, party);
      if (warnings.length && !req.body.acknowledge_warnings) {
        const err = new Error('This invoice needs confirmation before it can be raised.');
        err.status = 428; err.warnings = warnings;
        throw err;
      }

      const existing = await tx.get(
        `SELECT invoice_number FROM invoices WHERE module=$1 AND entity_id=$2 AND status='issued'`,
        [module, entityId]
      );
      if (existing) {
        const err = new Error(`Invoice ${existing.invoice_number} has already been issued for this record. Cancel it first if it needs correcting.`);
        err.status = 409;
        throw err;
      }

      const rate = Number(req.body.rate ?? org.default_gst_rate);
      const basis = req.body.basis || org.tax_basis;
      const gst = computeGst({ amount: party.amount, rate, basis, orgStateCode: org.state_code, partyStateCode: party.state_code, partyGstin: party.gstin });
      const { series, invoice_number } = await nextInvoiceNumber(tx, cfg.series);

      const row = await tx.run(`
        INSERT INTO invoices
          (invoice_number, series, module, entity_id, party_name, party_address, party_gstin, party_state_code,
           party_email, description, sac, gst_rate, tax_basis, gross_amount, taxable_value, cgst, sgst, igst, total, created_by,
           place_of_supply, place_of_supply_code)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
        RETURNING id
      `, [invoice_number, series, module, entityId,
          party.attention ? `${party.name} (Attn: ${party.attention})` : party.name,
          party.address, party.gstin,
          // The stored state follows the place of supply actually applied, so
          // the invoice can never show a state that disagrees with its own tax.
          gst.place_of_supply_code || party.state_code, party.email,
          req.body.description || party.description, org.default_sac, rate, basis,
          party.amount, gst.taxable_value, gst.cgst, gst.sgst, gst.igst, gst.total,
          req.user ? req.user.username : null,
          gst.place_of_supply, gst.place_of_supply_code]);

      return { id: row.id, invoice_number };
    });

    logActivity(req.user, { action: 'create', entityType: 'invoice', entityId: result.id, label: result.invoice_number });
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message, blockers: e.blockers || null, warnings: e.warnings || null });
  }
});

// --- billing readiness -----------------------------------------------------

// A work queue of everyone who could be invoiced, and what is missing from
// their billing details. The point is to fix those gaps from the paperwork
// already on file BEFORE a delegate asks for an invoice — because correcting a
// name or GSTIN after the invoice has been issued and emailed costs a reissue
// or an edit-with-reason, whereas correcting it here costs nothing at all.
//
// Set-based rather than looping loadParty per entity: this runs over every
// registration, sponsor, stall and host member at once, and a per-row query
// would be ~200 round trips for a screen that gets opened repeatedly.
const READINESS_SQL = {
  registration: `
    SELECT r.id AS entity_id, r.reg_number AS reference, r.amount_paid AS amount,
           p.name AS contact_name, p.company, p.gstin, p.billing_address, p.state_code, p.email
      FROM registrations r
      LEFT JOIN participants p ON p.registration_id = r.id AND p.is_primary = 1
     WHERE COALESCE(r.amount_paid, 0) > 0`,
  sponsor: `
    SELECT s.id AS entity_id, 'SPONSOR-' || s.id AS reference,
           COALESCE(s.amount, s.payment_amount) AS amount,
           s.contact_person AS contact_name, s.name AS company,
           s.gstin, s.billing_address, s.state_code, s.email
      FROM sponsors s
     WHERE COALESCE(s.amount, s.payment_amount, 0) > 0 AND s.status <> 'cancelled'`,
  stall: `
    SELECT b.id AS entity_id, 'STALL-' || b.id AS reference, b.amount,
           b.contact_person AS contact_name, b.company_name AS company,
           b.gstin, NULL AS billing_address, b.state_code, b.email
      FROM stall_bookings b
     WHERE COALESCE(b.amount, 0) > 0 AND b.status <> 'cancelled'`,
  host_member: `
    SELECT h.id AS entity_id, 'HOST-' || h.id AS reference, h.payment_amount AS amount,
           h.name AS contact_name, h.company, h.gstin,
           NULL AS billing_address, NULL AS state_code, h.email
      FROM host_members h
     WHERE COALESCE(h.payment_amount, 0) > 0 AND h.payment_status = 'paid'`
};

// Severity matters: a wrong GSTIN produces an invoice the recipient cannot use
// and which cannot be corrected without a reissue, so it outranks a missing
// address, which is cosmetic on most invoices.
function billingIssues(row) {
  const issues = [];
  if (!row.gstin) issues.push({ field: 'gstin', severity: 'warn', text: 'No GSTIN — would be invoiced as B2C' });
  else if (!validateGstin(row.gstin, null).valid) issues.push({ field: 'gstin', severity: 'error', text: `GSTIN "${row.gstin}" fails validation` });
  if (row.gstin && !row.state_code) issues.push({ field: 'state_code', severity: 'error', text: 'GSTIN on file but no state code — tax split may be wrong' });
  if (!row.email) issues.push({ field: 'email', severity: 'warn', text: 'No email — invoice cannot be sent' });
  if (!row.billing_address) issues.push({ field: 'billing_address', severity: 'info', text: 'No billing address' });
  if (!row.company && !row.contact_name) issues.push({ field: 'party_name', severity: 'error', text: 'No name or company to bill' });
  return issues;
}

router.get('/billing-readiness', async (req, res) => {
  try {
    const wanted = req.query.module && READINESS_SQL[req.query.module]
      ? [req.query.module] : Object.keys(READINESS_SQL);

    // One lookup of live invoices, so the report can mark who is already done
    // and — more usefully — flag anyone whose details changed after invoicing.
    const live = await db.all(`SELECT module, entity_id, invoice_number, party_gstin, party_name FROM invoices WHERE status = 'issued'`);
    const liveBy = {};
    live.forEach((i) => { liveBy[`${i.module}:${i.entity_id}`] = i; });

    const out = [];
    for (const mod of wanted) {
      const rows = await db.all(READINESS_SQL[mod]);
      rows.forEach((r) => {
        const inv = liveBy[`${mod}:${r.entity_id}`] || null;
        const issues = billingIssues(r);
        out.push({
          module: mod,
          module_label: MODULES[mod].label,
          entity_id: r.entity_id,
          reference: r.reference,
          party_name: r.company || r.contact_name || '',
          contact_name: r.contact_name || '',
          amount: Number(r.amount) || 0,
          gstin: r.gstin || '',
          state_code: r.state_code || '',
          billing_address: r.billing_address || '',
          email: r.email || '',
          invoice_number: inv ? inv.invoice_number : null,
          // Once invoiced, a details change is no longer free — surface it.
          drifted: !!(inv && (inv.party_gstin || '') !== (r.gstin || '')),
          issues,
          status: issues.some((i) => i.severity === 'error') ? 'error'
            : issues.some((i) => i.severity === 'warn') ? 'warn' : 'ready'
        });
      });
    }

    out.sort((a, b) => {
      const rank = { error: 0, warn: 1, ready: 2 };
      if (rank[a.status] !== rank[b.status]) return rank[a.status] - rank[b.status];
      return b.amount - a.amount; // biggest money first within a band
    });

    const summary = {
      total: out.length,
      ready: out.filter((r) => r.status === 'ready').length,
      warn: out.filter((r) => r.status === 'warn').length,
      error: out.filter((r) => r.status === 'error').length,
      invoiced: out.filter((r) => r.invoice_number).length,
      drifted: out.filter((r) => r.drifted).length
    };
    res.json({ ok: true, summary, rows: out });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- list / fetch / cancel -------------------------------------------------

router.get('/', async (req, res) => {
  try {
    const where = [], vals = [];
    if (req.query.module) { vals.push(req.query.module); where.push(`module = $${vals.length}`); }
    if (req.query.status) { vals.push(req.query.status); where.push(`status = $${vals.length}`); }
    const rows = await db.all(
      `SELECT * FROM invoices ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC`, vals);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const inv = await db.get('SELECT * FROM invoices WHERE id = $1', [req.params.id]);
    if (!inv) return res.status(404).json({ error: 'Invoice not found.' });
    const org = await getOrg(db);
    res.json({ ok: true, invoice: inv, org, amount_in_words: amountInWords(inv.total) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Cancellation, not deletion. The number stays consumed so the series has no
// gap, and the reason is recorded.
router.post('/:id/cancel', async (req, res) => {
  const reason = String(req.body.reason || '').trim();
  if (!reason) return res.status(400).json({ error: 'A reason is required to cancel an invoice.' });
  try {
    const inv = await db.get('SELECT * FROM invoices WHERE id = $1', [req.params.id]);
    if (!inv) return res.status(404).json({ error: 'Invoice not found.' });
    if (inv.status === 'cancelled') return res.status(409).json({ error: 'That invoice is already cancelled.' });
    await db.run(`UPDATE invoices SET status='cancelled', cancelled_reason=$1 WHERE id=$2`, [reason, req.params.id]);
    logActivity(req.user, { action: 'update', entityType: 'invoice', entityId: Number(req.params.id), label: `Cancelled ${inv.invoice_number}`, details: reason });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- capture missing billing details on the source record ------------------

// Where each module keeps the party's billing fields. A registration bills the
// primary participant, so the GSTIN belongs on that participant row, not on the
// registration — which is why this can't just be a generic UPDATE.
const PARTY_TABLES = {
  registration: { table: 'participants', columns: ['gstin', 'state_code', 'billing_address', 'email'] },
  sponsor: { table: 'sponsors', columns: ['gstin', 'state_code', 'billing_address', 'email'] },
  stall: { table: 'stall_bookings', columns: ['gstin', 'state_code', 'email'] },
  host_member: { table: 'host_members', columns: ['gstin', 'email'] }
};

// Lets the "no GSTIN — do you want to add it?" prompt write the number straight
// onto the delegate/sponsor record before the invoice is raised, so the details
// are fixed at source rather than only on this one invoice. The state code is
// derived from the GSTIN's first two digits when not given, because those two
// digits ARE the state and a mismatch between them silently produces the wrong
// tax split.
router.put('/party/:module/:entityId', async (req, res) => {
  const cfg = PARTY_TABLES[req.params.module];
  if (!cfg) return res.status(400).json({ error: 'Unknown module.' });
  const entityId = Number(req.params.entityId);

  const gstin = req.body.gstin === undefined ? undefined : String(req.body.gstin || '').trim().toUpperCase();
  if (gstin) {
    const check = validateGstin(gstin, null);
    if (!check.valid) {
      return res.status(400).json({ error: `That GSTIN does not look valid: ${check.reason || 'failed the checksum'}. Please re-check the number.` });
    }
  }

  const patch = {};
  if (gstin !== undefined) patch.gstin = gstin || null;
  if (req.body.billing_address !== undefined) patch.billing_address = String(req.body.billing_address || '').trim() || null;
  if (req.body.email !== undefined) patch.email = String(req.body.email || '').trim() || null;
  if (req.body.state_code !== undefined) patch.state_code = String(req.body.state_code || '').trim() || null;
  else if (gstin) patch.state_code = gstin.slice(0, 2);

  const cols = Object.keys(patch).filter((c) => cfg.columns.includes(c));
  if (!cols.length) return res.status(400).json({ error: 'Nothing to update.' });

  try {
    const vals = cols.map((c) => patch[c]);
    const sets = cols.map((c, i) => `${c} = $${i + 1}`).join(', ');

    if (req.params.module === 'registration') {
      // The billing party is the primary participant on that registration.
      vals.push(entityId);
      const r = await db.run(
        `UPDATE participants SET ${sets} WHERE registration_id = $${vals.length} AND is_primary = 1`, vals);
      if (!r.rowCount) return res.status(404).json({ error: 'No primary delegate found on that registration.' });
    } else {
      vals.push(entityId);
      const r = await db.run(`UPDATE ${cfg.table} SET ${sets} WHERE id = $${vals.length}`, vals);
      if (!r.rowCount) return res.status(404).json({ error: 'That record no longer exists.' });
    }

    logActivity(req.user, {
      action: 'update', entityType: 'invoice-party', entityId,
      label: `Billing details updated (${req.params.module})`, details: cols.join(', ')
    });
    res.json({ ok: true, updated: cols, state_code: patch.state_code || null });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- edit ------------------------------------------------------------------

// Fields an issued invoice can be corrected on. The invoice NUMBER, series,
// module and entity are deliberately absent — those identify the document, and
// letting them change would make an invoice already in someone's inbox refer to
// something else entirely.
//
// Editing in place (rather than forcing cancel-and-reissue) keeps the number a
// recipient already holds valid. The trade is that the figures could change
// silently, so every change is written to invoice_revisions before the update
// lands, in the same transaction. Amounts re-run computeGst rather than being
// taken from the client, so the tax can never disagree with the amount.
const EDITABLE_TEXT_FIELDS = ['party_name', 'party_address', 'party_gstin', 'party_state_code', 'party_email', 'description', 'sac', 'invoice_date'];

router.put('/:id', async (req, res) => {
  try {
    const out = await db.transaction(async (tx) => {
      const inv = await tx.get('SELECT * FROM invoices WHERE id = $1', [req.params.id]);
      if (!inv) { const e = new Error('Invoice not found.'); e.status = 404; throw e; }
      if (inv.status === 'cancelled') {
        const e = new Error('That invoice is cancelled — reissue rather than editing it.');
        e.status = 409; throw e;
      }
      const org = await getOrg(tx);

      const changes = [];
      const sets = [], vals = [];
      const stage = (field, newVal) => {
        const oldVal = inv[field] === null || inv[field] === undefined ? '' : String(inv[field]);
        const nv = newVal === null || newVal === undefined ? '' : String(newVal);
        if (oldVal === nv) return;
        changes.push({ field, old_value: oldVal, new_value: nv });
        vals.push(newVal === '' ? null : newVal);
        sets.push(`${field} = $${vals.length}`);
      };

      EDITABLE_TEXT_FIELDS.forEach((f) => {
        if (Object.prototype.hasOwnProperty.call(req.body, f)) stage(f, req.body[f]);
      });

      // Any of amount / rate / basis / state changing means the whole tax
      // calculation is redone from scratch — never trust a client-sent total.
      const wantsMoneyChange = ['gross_amount', 'gst_rate', 'tax_basis'].some(
        (f) => Object.prototype.hasOwnProperty.call(req.body, f)
      )
        || Object.prototype.hasOwnProperty.call(req.body, 'party_state_code')
        // The GSTIN decides the place of supply, and therefore whether this is
        // CGST+SGST or IGST — so adding or changing one has to re-run the tax,
        // not just relabel the invoice.
        || Object.prototype.hasOwnProperty.call(req.body, 'party_gstin');

      if (wantsMoneyChange) {
        const amount = Number(req.body.gross_amount ?? inv.gross_amount);
        const rate = Number(req.body.gst_rate ?? inv.gst_rate);
        const basis = req.body.tax_basis || inv.tax_basis;
        if (!(amount > 0)) { const e = new Error('The invoice amount must be greater than zero.'); e.status = 400; throw e; }
        if (!(rate >= 0)) { const e = new Error('The GST rate must be zero or more.'); e.status = 400; throw e; }
        const partyState = Object.prototype.hasOwnProperty.call(req.body, 'party_state_code')
          ? req.body.party_state_code : inv.party_state_code;
        const partyGstinForTax = Object.prototype.hasOwnProperty.call(req.body, 'party_gstin')
          ? req.body.party_gstin : inv.party_gstin;
        const gst = computeGst({ amount, rate, basis, orgStateCode: org.state_code, partyStateCode: partyState, partyGstin: partyGstinForTax });
        stage('gross_amount', amount);
        stage('gst_rate', rate);
        stage('tax_basis', basis);
        stage('taxable_value', gst.taxable_value);
        stage('cgst', gst.cgst);
        stage('sgst', gst.sgst);
        stage('igst', gst.igst);
        stage('place_of_supply_code', gst.place_of_supply_code);
        stage('place_of_supply', gst.place_of_supply);
        stage('total', gst.total);
      }

      if (!sets.length) return { changed: 0, invoice: inv };

      const reason = String(req.body.reason || '').trim() || null;
      const who = req.user ? req.user.username : null;
      for (const c of changes) {
        await tx.run(
          `INSERT INTO invoice_revisions (invoice_id, field, old_value, new_value, reason, changed_by)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [inv.id, c.field, c.old_value, c.new_value, reason, who]
        );
      }
      vals.push(inv.id);
      await tx.run(`UPDATE invoices SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
      const updated = await tx.get('SELECT * FROM invoices WHERE id = $1', [inv.id]);
      return { changed: changes.length, invoice: updated, fields: changes.map((c) => c.field) };
    });

    if (out.changed) {
      logActivity(req.user, {
        action: 'update', entityType: 'invoice', entityId: Number(req.params.id),
        label: `Edited ${out.invoice.invoice_number}`, details: out.fields.join(', ')
      });
    }
    res.json({ ok: true, ...out, amount_in_words: amountInWords(out.invoice.total) });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// Full edit history, newest first — shown under the invoice so a corrected
// figure can always be traced back to what it was.
router.get('/:id/revisions', async (req, res) => {
  try {
    const rows = await db.all(
      'SELECT * FROM invoice_revisions WHERE invoice_id = $1 ORDER BY id DESC', [req.params.id]);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- email -----------------------------------------------------------------

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// The PDF is rendered in the browser (jsPDF, same code path as the Download
// button) and posted here as base64, rather than being re-rendered server-side.
// That guarantees the attachment is exactly the document the admin just looked
// at, and avoids a second PDF implementation that would inevitably drift.
router.post('/:id/email', async (req, res) => {
  try {
    const inv = await db.get('SELECT * FROM invoices WHERE id = $1', [req.params.id]);
    if (!inv) return res.status(404).json({ error: 'Invoice not found.' });
    if (inv.status === 'cancelled') {
      return res.status(409).json({ error: 'That invoice is cancelled — it should not be emailed.' });
    }
    if (!resend.isConfigured()) {
      return res.status(503).json({ error: 'Email is not configured on the server (RESEND_API_KEY is missing).' });
    }

    const to = String(req.body.to || inv.party_email || '').trim();
    if (!to) {
      return res.status(400).json({ error: 'No email address on file for this party — enter one to send the invoice.' });
    }
    if (!EMAIL_RE.test(to)) return res.status(400).json({ error: `"${to}" does not look like an email address.` });

    const pdf = String(req.body.pdf_base64 || '').replace(/^data:[^,]*,/, '');
    if (!pdf) return res.status(400).json({ error: 'The invoice PDF was not supplied.' });

    const org = await getOrg(db);
    const orgName = (org && org.legal_name) || 'Skål International Coimbatore';
    const filename = `${inv.invoice_number.replace(/[\/\\]/g, '-')}.pdf`;
    const money = (n) => `Rs. ${Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

    const html = `
      <div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#333;line-height:1.6;">
        <p>Dear ${escapeHtml(inv.party_name)},</p>
        <p>Please find attached the GST invoice <strong>${escapeHtml(inv.invoice_number)}</strong>
           dated ${new Date(inv.invoice_date).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })}
           towards ${escapeHtml(inv.description || 'your payment')}.</p>
        <table style="border-collapse:collapse;margin:16px 0;">
          <tr><td style="padding:4px 16px 4px 0;">Invoice number</td><td style="padding:4px 0;"><strong>${escapeHtml(inv.invoice_number)}</strong></td></tr>
          <tr><td style="padding:4px 16px 4px 0;">Taxable value</td><td style="padding:4px 0;">${money(inv.taxable_value)}</td></tr>
          ${Number(inv.igst) > 0
            ? `<tr><td style="padding:4px 16px 4px 0;">IGST</td><td style="padding:4px 0;">${money(inv.igst)}</td></tr>`
            : `<tr><td style="padding:4px 16px 4px 0;">CGST</td><td style="padding:4px 0;">${money(inv.cgst)}</td></tr>
               <tr><td style="padding:4px 16px 4px 0;">SGST</td><td style="padding:4px 0;">${money(inv.sgst)}</td></tr>`}
          <tr><td style="padding:4px 16px 4px 0;"><strong>Total</strong></td><td style="padding:4px 0;"><strong>${money(inv.total)}</strong></td></tr>
        </table>
        ${inv.party_gstin
          ? `<p style="color:#666;">GSTIN on record: ${escapeHtml(inv.party_gstin)}</p>`
          : `<p style="color:#666;">This invoice has been raised without a GSTIN. If you are GST-registered and need the invoice reissued against your GSTIN, please reply to this email.</p>`}
        <p>If anything on the invoice needs correcting, please reply and we will put it right.</p>
        <p>Warm regards,<br/>${escapeHtml(orgName)}<br/>
           Skål International India National Congress 2026</p>
      </div>`;

    const sent = await resend.sendEmail({
      to, subject: `Invoice ${inv.invoice_number} — SINC 2026`, html,
      fromName: orgName,
      attachments: [{ filename, content: pdf }]
    });
    if (!sent.ok) return res.status(502).json({ error: `Could not send: ${sent.error}` });

    await db.run(
      `UPDATE invoices SET emailed_at = NOW(), emailed_to = $1, email_count = email_count + 1 WHERE id = $2`,
      [to, inv.id]
    );
    logActivity(req.user, {
      action: 'update', entityType: 'invoice', entityId: inv.id,
      label: `Emailed ${inv.invoice_number}`, details: to
    });
    res.json({ ok: true, to, message_id: sent.id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

module.exports = router;
module.exports._internals = { financialYear, MODULES, issueBlockers, issueWarnings, EDITABLE_TEXT_FIELDS };
