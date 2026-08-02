// Shared spreadsheet reader for the admin Bulk Import screen.
//
// The office works in Excel (delegates-directory.xlsx, host-members-directory.xlsx)
// but hand-built lists still arrive as CSV, so both are accepted and normalised
// into the same shape: an array of plain objects keyed by canonical column name.
//
// Header normalisation is deliberately forgiving. A column exported from this
// system comes back as "Reg Number", a hand-typed one might be "reg_number",
// "REG NO" or "Registration Number" — all three should land on the same field
// rather than being silently dropped as unknown.

const { parse } = require('csv-parse/sync');

// Canonical field -> the header spellings we accept for it. Compared after
// lowercasing and collapsing every non-alphanumeric run to a single space, so
// "Reg. Number", "REG_NUMBER" and "reg number" all reduce to "reg number".
const HEADER_ALIASES = {
  reg_number: ['reg number', 'reg no', 'regno', 'registration number', 'registration no', 'sinc number', 'sinc no'],
  is_primary: ['is primary', 'primary', 'primary registrant', 'registrant type', 'delegate type'],
  participant_code: ['participant code', 'delegate code', 'badge code'],
  name: ['name', 'full name', 'delegate name', 'member name', 'participant name'],
  phone: ['phone', 'mobile', 'mobile number', 'phone number', 'contact', 'contact number'],
  whatsapp: ['whatsapp', 'whatsapp number', 'wa number'],
  email: ['email', 'email address', 'e mail', 'mail'],
  address: ['address', 'postal address'],
  designation: ['designation', 'job title', 'title', 'role'],
  sex: ['sex', 'gender', 'm f'],
  company: ['company', 'organisation', 'organization', 'firm', 'company name'],
  category: ['category', 'member category'],
  dietary_preference: ['dietary preference', 'dietary', 'food preference', 'meal preference', 'food'],
  drink_preference: ['drink preference', 'drink', 'beverage preference'],
  special_requests: ['special requests', 'special request', 'requests'],
  business_profile: ['business profile', 'profile', 'business'],
  travel_mode: ['travel mode', 'arrival mode', 'mode of travel', 'mode of arrival'],
  travel_number: ['travel number', 'arrival number', 'flight number', 'train number', 'flight no', 'arrival flight'],
  travel_datetime: ['travel datetime', 'arrival datetime', 'arrival date time', 'arrival', 'arrival date'],
  arrival_point: ['arrival point', 'arrival airport', 'arrival station'],
  departure_mode: ['departure mode', 'mode of departure'],
  departure_number: ['departure number', 'departure flight', 'departure flight no', 'departure train'],
  departure_datetime: ['departure datetime', 'departure date time', 'departure', 'departure date'],
  departure_point: ['departure point', 'departure airport', 'departure station'],
  pickup_by: ['pickup by', 'pick up by'],
  pickup_vehicle: ['pickup vehicle', 'pick up vehicle', 'vehicle'],
  pickup_phone: ['pickup phone', 'pick up phone', 'driver phone'],
  spoc_name: ['spoc name', 'spoc'],
  spoc_phone: ['spoc phone', 'spoc contact'],
  shirt_size: ['shirt size', 'shirt'],
  tshirt_size: ['tshirt size', 't shirt size', 't shirt', 'tshirt'],
  waist_size: ['waist size', 'waist', 'trouser size'],
  aadhaar_number: ['aadhaar number', 'aadhar number', 'aadhaar', 'aadhar'],
  passport_number: ['passport number', 'passport no', 'passport'],
  leadership_role: ['leadership role', 'club role', 'office'],
  payment_status: ['payment status', 'payment'],
  payment_amount: ['payment amount', 'amount', 'amount paid'],
  payment_mode: ['payment mode', 'mode of payment'],
  payment_date: ['payment date', 'paid on'],
  notes: ['notes', 'note', 'remarks', 'comment', 'comments']
};

// Flattened alias -> canonical, built once at require time.
const ALIAS_TO_FIELD = {};
for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
  ALIAS_TO_FIELD[field.replace(/_/g, ' ')] = field;
  for (const a of aliases) ALIAS_TO_FIELD[a] = field;
}

function normalizeHeader(h) {
  return String(h == null ? '' : h)
    .replace(/﻿/g, '')          // strip the BOM Excel loves to prepend
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Returns { field, raw } — field is null when the column isn't one we know,
// which the caller surfaces as an "ignored column" warning rather than an error.
function mapHeader(raw) {
  const key = normalizeHeader(raw);
  return { raw: String(raw == null ? '' : raw).trim(), field: ALIAS_TO_FIELD[key] || null };
}

// Excel stores dates as a serial number of days since 1899-12-30. When a sheet
// column is date-formatted, the raw cell value arrives as e.g. 46246 rather
// than "2026-08-12", so it has to be converted or the import writes a number
// into a date field.
function excelSerialToISO(n) {
  const ms = Math.round((Number(n) - 25569) * 86400 * 1000);
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return String(n);
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

// Formats using LOCAL date parts, not toISOString(). xlsx with cellDates:true
// hands back a Date built from the sheet's wall-clock value; serialising that
// through UTC shifts it backwards for any timezone east of Greenwich, so a
// cell reading 12 Aug arrives as 11 Aug. India is UTC+5:30 — this bit us.
function cellToString(v) {
  if (v == null) return '';
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return '';
    // xlsx round-trips dates through a floating-point day serial, so a cell
    // holding midnight can come back as 23:59:59.999 the previous day.
    // Rounding to the nearest minute absorbs that drift before the date parts
    // are read; without it, 12 Aug reads as 11 Aug.
    const d = new Date(Math.round(v.getTime() / 60000) * 60000);
    const p = (n) => String(n).padStart(2, '0');
    const date = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    const time = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
    return time === '00:00:00' ? date : `${date} ${time}`;
  }
  return String(v).trim();
}

function isXlsx(filename, buffer) {
  if (/\.(xlsx|xlsm|xltx)$/i.test(filename || '')) return true;
  // xlsx is a zip — "PK\x03\x04". Sniffing the magic bytes catches a file
  // that was renamed to .csv but is really a workbook.
  return buffer && buffer.length > 4 && buffer[0] === 0x50 && buffer[1] === 0x4b;
}

/**
 * Parses an uploaded buffer into { columns, rows, ignored }.
 *   columns  canonical field names found, in sheet order
 *   rows     array of { _row, <field>: string }  (_row = 1-based sheet row)
 *   ignored  header labels that matched no known field
 */
function readSheet(buffer, filename) {
  let matrix; // array of arrays, first row = headers

  if (isXlsx(filename, buffer)) {
    // Required lazily so a CSV-only deployment doesn't pay the parse cost.
    const XLSX = require('xlsx');
    const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
    const sheetName = wb.SheetNames[0];
    if (!sheetName) throw new Error('The workbook has no sheets.');
    matrix = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, raw: true, blankrows: false });
  } else {
    const text = buffer.toString('utf8').replace(/^﻿/, '');
    matrix = parse(text, { columns: false, skip_empty_lines: true, relax_column_count: true, trim: true });
  }

  if (!matrix.length) throw new Error('The file is empty.');

  const headerRow = matrix[0];
  const mapped = headerRow.map(mapHeader);
  const ignored = mapped.filter((m) => !m.field && m.raw).map((m) => m.raw);
  const columns = mapped.filter((m) => m.field).map((m) => m.field);

  if (!columns.length) {
    throw new Error('No recognised columns. The first row must be a header row — try downloading the template.');
  }

  const rows = [];
  for (let i = 1; i < matrix.length; i++) {
    const cells = matrix[i] || [];
    const rec = { _row: i + 1 };
    let hasValue = false;
    mapped.forEach((m, idx) => {
      if (!m.field) return;
      let v = cells[idx];
      // A date-formatted Excel cell for a datetime field comes through as a serial.
      if (typeof v === 'number' && /_datetime$|_date$/.test(m.field) && v > 20000 && v < 80000) {
        v = excelSerialToISO(v);
      }
      const s = cellToString(v);
      rec[m.field] = s;
      if (s !== '') hasValue = true;
    });
    if (hasValue) rows.push(rec);
  }

  return { columns, rows, ignored };
}

module.exports = { readSheet, mapHeader, normalizeHeader, HEADER_ALIASES };
