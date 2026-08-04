// GST tax invoices for registrations, sponsors, stall bookings and host
// member contributions.
//
// Design constraints that drive most of what follows:
//
//  * An issued invoice is NEVER edited. GST requires a gapless, sequential
//    series per book, so a mistake is cancelled (the number stays consumed and
//    on record) and a fresh invoice raised. There is deliberately no PUT here.
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

const router = express.Router();

// Series prefix per module. Separate books so an auditor can see at a glance
// what a number refers to, and so a gap in one cannot be caused by another.
const MODULES = {
  registration: { series: 'REG', label: 'Delegate registration' },
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
             p.name, p.company, p.gstin, p.billing_address, p.state_code, p.address, p.notes
        FROM registrations r
        LEFT JOIN participants p ON p.registration_id = r.id AND p.is_primary = 1
       WHERE r.id = $1
    `, [entityId]);
    if (!r) return null;
    return {
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
    const gst = computeGst({ amount: party.amount, rate, basis, orgStateCode: org.state_code, partyStateCode: party.state_code });
    const partyCheck = party.gstin ? validateGstin(party.gstin, null) : null;

    res.json({
      ok: true, module: req.params.module, label: cfg.label,
      org, party, ...gst, sac: org.default_sac,
      amount_in_words: amountInWords(gst.total),
      party_gstin_check: partyCheck,
      blockers: issueBlockers(org, party)
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
      const gst = computeGst({ amount: party.amount, rate, basis, orgStateCode: org.state_code, partyStateCode: party.state_code });
      const { series, invoice_number } = await nextInvoiceNumber(tx, cfg.series);

      const row = await tx.run(`
        INSERT INTO invoices
          (invoice_number, series, module, entity_id, party_name, party_address, party_gstin, party_state_code,
           description, sac, gst_rate, tax_basis, gross_amount, taxable_value, cgst, sgst, igst, total, created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
        RETURNING id
      `, [invoice_number, series, module, entityId,
          party.attention ? `${party.name} (Attn: ${party.attention})` : party.name,
          party.address, party.gstin, party.state_code,
          req.body.description || party.description, org.default_sac, rate, basis,
          party.amount, gst.taxable_value, gst.cgst, gst.sgst, gst.igst, gst.total,
          req.user ? req.user.username : null]);

      return { id: row.id, invoice_number };
    });

    logActivity(req.user, { action: 'create', entityType: 'invoice', entityId: result.id, label: result.invoice_number });
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message, blockers: e.blockers || null });
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

module.exports = router;
module.exports._internals = { financialYear, MODULES, issueBlockers };
