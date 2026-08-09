// GST computation and GSTIN validation, kept out of the route so it can be
// unit-tested without a database.
//
// Nothing here is tax advice. It implements the mechanical rules — the split
// between CGST/SGST and IGST, and the inclusive/exclusive arithmetic — but the
// rate, the SAC code and whether a given receipt is even a taxable supply are
// decisions for whoever files the returns.

const GSTIN_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

// Indian state codes as used in the first two digits of a GSTIN.
const STATE_CODES = {
  '01': 'Jammu & Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab', '04': 'Chandigarh',
  '05': 'Uttarakhand', '06': 'Haryana', '07': 'Delhi', '08': 'Rajasthan', '09': 'Uttar Pradesh',
  '10': 'Bihar', '11': 'Sikkim', '12': 'Arunachal Pradesh', '13': 'Nagaland', '14': 'Manipur',
  '15': 'Mizoram', '16': 'Tripura', '17': 'Meghalaya', '18': 'Assam', '19': 'West Bengal',
  '20': 'Jharkhand', '21': 'Odisha', '22': 'Chhattisgarh', '23': 'Madhya Pradesh',
  '24': 'Gujarat', '26': 'Dadra & Nagar Haveli and Daman & Diu', '27': 'Maharashtra',
  '29': 'Karnataka', '30': 'Goa', '31': 'Lakshadweep', '32': 'Kerala', '33': 'Tamil Nadu',
  '34': 'Puducherry', '35': 'Andaman & Nicobar Islands', '36': 'Telangana',
  '37': 'Andhra Pradesh', '38': 'Ladakh', '97': 'Other Territory'
};

// The 4th character of the embedded PAN encodes the type of entity. A club is
// normally an AOP or a Trust; a 'P' means the GSTIN belongs to an individual,
// which is worth flagging loudly on a club's own settings screen.
const PAN_ENTITY = {
  C: 'Company', P: 'Individual / Proprietor', H: 'Hindu Undivided Family',
  F: 'Firm / LLP', A: 'Association of Persons (AOP)', T: 'Trust',
  B: 'Body of Individuals', L: 'Local Authority', J: 'Artificial Juridical Person',
  G: 'Government'
};

// GSTIN check digit: weighted sum over the first 14 characters, alternating
// factors of 1 and 2, with each product folded in base 36.
function gstinCheckDigit(first14) {
  let total = 0;
  for (let i = 0; i < 14; i++) {
    const v = GSTIN_CHARS.indexOf(first14[i]);
    if (v < 0) return null;
    const p = v * (i % 2 === 0 ? 1 : 2);
    total += Math.floor(p / 36) + (p % 36);
  }
  return GSTIN_CHARS[(36 - (total % 36)) % 36];
}

/**
 * Validates a GSTIN's structure and check digit, and reports what it implies.
 * Returns { valid, errors[], warnings[], state_code, state, pan, entity_type }.
 * A GSTIN can be perfectly valid and still be the wrong one — hence warnings
 * separate from errors.
 */
function validateGstin(raw, expectedStateCode) {
  const g = String(raw || '').trim().toUpperCase();
  const out = { input: g, valid: false, errors: [], warnings: [], state_code: null, state: null, pan: null, entity_type: null };
  if (!g) { out.errors.push('No GSTIN provided.'); return out; }
  if (g.length !== 15) { out.errors.push(`A GSTIN is 15 characters; this is ${g.length}.`); return out; }
  if (!/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/.test(g)) {
    out.errors.push('Does not match the GSTIN pattern (2 digits, 5 letters, 4 digits, letter, entity code, Z, check digit).');
    return out;
  }
  out.state_code = g.slice(0, 2);
  out.state = STATE_CODES[out.state_code] || null;
  out.pan = g.slice(2, 12);
  out.entity_type = PAN_ENTITY[out.pan[3]] || null;

  if (!out.state) out.errors.push(`State code "${out.state_code}" is not a recognised Indian state code.`);
  const expect = gstinCheckDigit(g.slice(0, 14));
  if (expect && g[14] !== expect) {
    out.errors.push(`Check digit is "${g[14]}" but should be "${expect}" — this GSTIN does not exist.`);
  }
  out.valid = out.errors.length === 0;

  if (expectedStateCode && out.state_code !== String(expectedStateCode)) {
    out.warnings.push(
      `Registered in ${out.state || out.state_code} (code ${out.state_code}), but the address given is in ` +
      `${STATE_CODES[expectedStateCode] || 'state code ' + expectedStateCode} (code ${expectedStateCode}). ` +
      `GST registration is state-specific — check this is the right certificate.`
    );
  }
  return out;
}

// Money is held to 2 decimals throughout. Using a rounded paise integer
// internally avoids the classic case where taxable + tax != total by a paisa.
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/**
 * Determines the PLACE OF SUPPLY, which is what actually decides CGST+SGST
 * versus IGST — not the recipient's postal address, and not their GSTIN alone.
 *
 * The congress is an event held in Coimbatore, so the relevant provision is
 * IGST Act s.12(7) — services by way of organisation of, or admission to, an
 * event:
 *
 *   s.12(7)(a)(i)  recipient is a REGISTERED person
 *                  -> place of supply is the LOCATION OF THE RECIPIENT,
 *                     i.e. the state of the GSTIN they give us.
 *
 *   s.12(7)(b)     recipient is UNREGISTERED
 *                  -> place of supply is where the EVENT IS ACTUALLY HELD,
 *                     i.e. Tamil Nadu, whatever address they gave us.
 *
 * The practical consequences, which are easy to get wrong:
 *
 *   - A delegate with a Maharashtra GSTIN is an inter-state supply: IGST.
 *   - A delegate from Maharashtra with NO GSTIN is still an INTRA-state
 *     supply, because the event is in Tamil Nadu: CGST + SGST. Charging them
 *     IGST would be wrong even though they live outside the state.
 *   - The state is always read from the GSTIN's first two digits. A separately
 *     typed state code is never allowed to override it, because GST
 *     registration is state-specific and the GSTIN is the authoritative fact.
 *
 * s.12(7) applies where the recipient is in India. A foreign delegate with no
 * Indian registration is out of scope of this helper — treat those separately
 * and take advice; this returns the event's own state for them, which keeps
 * them intra-state rather than silently inventing an export.
 *
 * Not tax advice: the rate, the SAC and whether a given receipt is a taxable
 * supply at all remain decisions for whoever files the returns.
 */
function placeOfSupply({ orgStateCode, partyGstin, partyStateCode }) {
  const eventState = String(orgStateCode || '');
  const g = String(partyGstin || '').trim().toUpperCase();
  const registered = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/.test(g);

  if (registered) {
    return {
      state_code: g.slice(0, 2),
      registered: true,
      basis: 'Recipient is registered — place of supply is the recipient\'s state (IGST Act s.12(7)(a)(i)).'
    };
  }
  // Unregistered: the event's own location governs, so anything typed into a
  // state field is deliberately ignored here rather than quietly producing
  // IGST on a B2C invoice.
  return {
    state_code: eventState,
    registered: false,
    ignored_state_code: partyStateCode && String(partyStateCode) !== eventState ? String(partyStateCode) : null,
    basis: 'Recipient is unregistered — place of supply is where the event is held (IGST Act s.12(7)(b)).'
  };
}

/**
 * Splits an amount into taxable value and tax.
 *
 *   basis 'inclusive' — `amount` already contains the tax (what was collected)
 *   basis 'exclusive' — tax is added on top of `amount`
 *
 * Intra-state supply splits the tax equally into CGST and SGST; inter-state
 * charges IGST. Which of the two applies is decided by placeOfSupply() above,
 * not by comparing addresses.
 */
function computeGst({ amount, rate, basis, orgStateCode, partyStateCode, partyGstin }) {
  const amt = Number(amount) || 0;
  const r = Number(rate) || 0;
  const inclusive = basis === 'inclusive';

  const taxable = inclusive ? round2(amt / (1 + r / 100)) : round2(amt);
  const total = inclusive ? round2(amt) : round2(amt + (amt * r) / 100);
  // Derive tax from the two rounded ends so the three figures always reconcile.
  const tax = round2(total - taxable);

  const pos = placeOfSupply({ orgStateCode, partyGstin, partyStateCode });
  const interState = !!(orgStateCode && pos.state_code && pos.state_code !== String(orgStateCode));

  let cgst = 0, sgst = 0, igst = 0;
  if (interState) {
    igst = tax;
  } else {
    // Halve, then give any odd paisa to CGST so the parts still sum to `tax`.
    cgst = round2(tax / 2);
    sgst = round2(tax - cgst);
  }

  return {
    taxable_value: taxable, cgst, sgst, igst, total, tax,
    inter_state: interState, rate: r, basis,
    // Rule 46(n) of the CGST Rules requires the place of supply, with the name
    // of the state, on any inter-state invoice — so it is returned here to be
    // printed rather than merely used and discarded.
    place_of_supply_code: pos.state_code || null,
    place_of_supply: pos.state_code ? (STATE_CODES[pos.state_code] || null) : null,
    place_of_supply_basis: pos.basis,
    recipient_registered: pos.registered,
    ignored_state_code: pos.ignored_state_code || null
  };
}

// "22000" -> "Twenty Two Thousand Rupees Only" — required on a tax invoice.
const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten',
  'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
function twoDigits(n) {
  if (n < 20) return ONES[n];
  return TENS[Math.floor(n / 10)] + (n % 10 ? ' ' + ONES[n % 10] : '');
}
function numberToWords(num) {
  const n = Math.floor(Math.abs(Number(num) || 0));
  if (n === 0) return 'Zero';
  // Indian grouping: crore, lakh, thousand, hundred.
  const parts = [];
  const crore = Math.floor(n / 10000000);
  const lakh = Math.floor((n % 10000000) / 100000);
  const thousand = Math.floor((n % 100000) / 1000);
  const hundred = Math.floor((n % 1000) / 100);
  const rest = n % 100;
  if (crore) parts.push(twoDigits(crore) + ' Crore');
  if (lakh) parts.push(twoDigits(lakh) + ' Lakh');
  if (thousand) parts.push(twoDigits(thousand) + ' Thousand');
  if (hundred) parts.push(ONES[hundred] + ' Hundred');
  if (rest) parts.push(twoDigits(rest));
  return parts.join(' ');
}
function amountInWords(amount) {
  const a = round2(amount);
  const rupees = Math.floor(a);
  const paise = Math.round((a - rupees) * 100);
  let s = `${numberToWords(rupees)} Rupees`;
  if (paise) s += ` and ${numberToWords(paise)} Paise`;
  return s + ' Only';
}

module.exports = { validateGstin, computeGst, placeOfSupply, amountInWords, numberToWords, round2, STATE_CODES, PAN_ENTITY, gstinCheckDigit };
