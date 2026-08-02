#!/usr/bin/env node
/**
 * clean-delegates.js — one-off data cleanup for the participants (delegates) table.
 *
 *   1. Strips leading honorific/professional titles from participants.name
 *      (Mr, Mrs, Ms, Miss, Dr, Prof, Capt, Adv, CA, Er, Sk — with or without a
 *      trailing period).
 *   2. Strips the Indian country code from participants.phone and
 *      participants.whatsapp, but ONLY when doing so leaves exactly 10 digits.
 *
 * The 10-digit guard matters: 9163235870 is a real 10-digit Indian mobile that
 * happens to begin "91". Blindly removing the prefix would turn it into the
 * 8-digit 63235870. Foreign numbers (Singapore 65…, UAE 971…, UK 44…) never
 * match the rule and are left exactly as they are.
 *
 * SAFETY
 *   - Dry run by default. Nothing is written unless you pass --apply.
 *   - --apply snapshots every affected row into participants_cleanup_backup
 *     before updating, inside the same transaction.
 *   - Any error rolls the whole thing back.
 *
 * USAGE
 *   node server/scripts/clean-delegates.js            # preview every change
 *   node server/scripts/clean-delegates.js --apply    # commit
 *   node server/scripts/clean-delegates.js --revert   # restore from backup
 */

const db = require('../db');

const APPLY = process.argv.includes('--apply');
const REVERT = process.argv.includes('--revert');
const BACKUP_TABLE = 'participants_cleanup_backup';

// ---------------------------------------------------------------------------
// Transforms
// ---------------------------------------------------------------------------

// Longest-first so "Prof" is tried before any shorter prefix could half-match.
const TITLES = [
  'Professor', 'Prof', 'Doctor', 'Dr',
  'Mrs', 'Miss', 'Mr', 'Ms', 'Mx',
  'Capt', 'Captain', 'Adv', 'Advocate',
  'CA', 'CS', 'Er', 'Engr',
  'Shri', 'Smt', 'Sri', 'Sk'
];

// Matches a title at the start of the string, terminated EITHER by a period
// (which may or may not be followed by a space — "Ms.Kavya" is common in the
// import data) OR by whitespace. Requiring one of those two terminators is
// what keeps "Mrinal", "Msakhile" and "Ergun" intact: neither a period nor a
// space follows the apparent title, so no match occurs.
const TITLE_RE = new RegExp(`^\\s*(?:${TITLES.join('|')})(?:\\.\\s*|\\s+)`, 'i');

function cleanName(raw) {
  if (raw == null) return raw;
  let out = String(raw);
  // Loop so "Dr. Mr. Foo" and other stacked titles collapse fully.
  let guard = 0;
  while (TITLE_RE.test(out) && guard++ < 5) {
    out = out.replace(TITLE_RE, '');
  }
  out = out.replace(/\s+/g, ' ').trim();
  // Never blank out a name: if stripping consumed everything, keep the original.
  return out.length ? out : String(raw).trim();
}

function cleanPhone(raw) {
  if (raw == null) return raw;
  const original = String(raw);
  // Keep only digits for analysis; remember whether it had a leading +.
  const digits = original.replace(/\D/g, '');
  if (!digits) return original;

  // 00 91 XXXXXXXXXX  (14) -> strip 0091
  if (/^0091\d{10}$/.test(digits)) return digits.slice(4);
  // 0 91 XXXXXXXXXX   (13) -> strip 091
  if (/^091\d{10}$/.test(digits)) return digits.slice(3);
  // 91 XXXXXXXXXX     (12) -> strip 91   <- the main case
  if (/^91\d{10}$/.test(digits)) return digits.slice(2);
  // 0 XXXXXXXXXX      (11) -> strip the STD 0
  if (/^0\d{10}$/.test(digits)) return digits.slice(1);
  // Already a clean 10-digit number.
  if (/^\d{10}$/.test(digits)) return digits;

  // Anything else — foreign numbers, landlines, malformed entries — untouched.
  return original;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function revert() {
  const exists = await db.get(
    `SELECT to_regclass($1) AS t`, [BACKUP_TABLE]
  );
  if (!exists || !exists.t) {
    console.error(`No ${BACKUP_TABLE} table found — nothing to revert.`);
    process.exit(1);
  }
  const n = await db.transaction(async (tx) => {
    const r = await tx.run(`
      UPDATE participants p
         SET name = b.name, phone = b.phone, whatsapp = b.whatsapp
        FROM ${BACKUP_TABLE} b
       WHERE p.id = b.id
    `);
    return r.rowCount;
  });
  console.log(`Reverted ${n} participant row(s) from ${BACKUP_TABLE}.`);
}

async function main() {
  if (REVERT) return revert();

  const rows = await db.all(
    `SELECT id, name, phone, whatsapp FROM participants ORDER BY id`
  );
  console.log(`Loaded ${rows.length} participants.\n`);

  const changes = [];
  for (const r of rows) {
    const name = cleanName(r.name);
    const phone = cleanPhone(r.phone);
    const whatsapp = cleanPhone(r.whatsapp);
    if (name !== r.name || phone !== r.phone || whatsapp !== r.whatsapp) {
      changes.push({ row: r, name, phone, whatsapp });
    }
  }

  if (!changes.length) {
    console.log('Nothing to change — the table is already clean.');
    return;
  }

  // ---- Report -------------------------------------------------------------
  let nameN = 0, phoneN = 0, waN = 0;
  console.log('id     field     before                          after');
  console.log('-'.repeat(78));
  for (const c of changes) {
    const line = (f, before, after) =>
      `${String(c.row.id).padEnd(6)} ${f.padEnd(9)} ${String(before ?? '').padEnd(31)} ${after ?? ''}`;
    if (c.name !== c.row.name) { console.log(line('name', c.row.name, c.name)); nameN++; }
    if (c.phone !== c.row.phone) { console.log(line('phone', c.row.phone, c.phone)); phoneN++; }
    if (c.whatsapp !== c.row.whatsapp) { console.log(line('whatsapp', c.row.whatsapp, c.whatsapp)); waN++; }
  }
  console.log('-'.repeat(78));
  console.log(`${changes.length} row(s) affected — ${nameN} name, ${phoneN} phone, ${waN} whatsapp.\n`);

  if (!APPLY) {
    console.log('DRY RUN — nothing written. Re-run with --apply to commit.');
    return;
  }

  // ---- Apply --------------------------------------------------------------
  await db.transaction(async (tx) => {
    await tx.run(`DROP TABLE IF EXISTS ${BACKUP_TABLE}`);
    await tx.run(`
      CREATE TABLE ${BACKUP_TABLE} AS
        SELECT id, name, phone, whatsapp, NOW() AS backed_up_at
          FROM participants
         WHERE id = ANY($1::int[])
    `, [changes.map((c) => c.row.id)]);

    for (const c of changes) {
      await tx.run(
        `UPDATE participants SET name = $1, phone = $2, whatsapp = $3 WHERE id = $4`,
        [c.name, c.phone, c.whatsapp, c.row.id]
      );
    }
  });

  console.log(`Applied. Previous values saved in ${BACKUP_TABLE}.`);
  console.log('To undo:  node server/scripts/clean-delegates.js --revert');
}

main()
  .then(() => process.exit(0))
  .catch((e) => { console.error(e); process.exit(1); });

module.exports = { cleanName, cleanPhone };
