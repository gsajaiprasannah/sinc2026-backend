#!/usr/bin/env node
/**
 * backfill-delegate-company.js — lift the company name out of participants.notes
 * into the new participants.company column.
 *
 * The original registration-form import had nowhere to put the company, so it
 * packed everything unmapped into a single pipe-delimited notes string:
 *
 *   Company: Civica Travels Pvt Ltd | Job Title: Managing Director | City: LUCKNOW
 *   | Country: IN | GSTIN: 09AAACC9677L1ZY | Passport/Aadhaar: 216951179060
 *   | [Imported from raw registration form export, ref Non Added #206]
 *
 * `notes` is left untouched on purpose: it is the original import record, and
 * keeping it means this script can be re-run safely (to pick up Job Title or
 * City later, say) without having destroyed the source.
 *
 * Only fills a company that is currently empty — a value typed by the office
 * always beats one parsed out of an import blob, so re-running never clobbers
 * hand-entered data.
 *
 * SAFETY
 *   - Dry run by default; nothing is written without --apply.
 *   - --apply snapshots affected rows into participants_company_backup first,
 *     inside the same transaction.
 *
 * USAGE
 *   node server/scripts/backfill-delegate-company.js            # preview
 *   node server/scripts/backfill-delegate-company.js --apply    # commit
 *   node server/scripts/backfill-delegate-company.js --revert   # undo
 */

const db = require('../db');

const APPLY = process.argv.includes('--apply');
const REVERT = process.argv.includes('--revert');
const BACKUP_TABLE = 'participants_company_backup';

// Everything up to the next pipe or end of string. The value itself may
// contain commas, dots, ampersands and spaces ("Skyworld Tours n Travels",
// "LOUDER DESIGN SOLUTIONS"), so only the pipe is treated as a delimiter.
const COMPANY_RE = /Company:\s*([^|]+)/i;

// Trailing junk seen in the real data: a stray comma or dash left by the
// export, and the occasional "-" or "NA" standing in for "not given".
const NOT_A_COMPANY = new Set(['', '-', '--', 'na', 'n/a', 'nil', 'none', 'nan', 'null', '.']);

function extractCompany(notes) {
  if (!notes) return null;
  const m = COMPANY_RE.exec(String(notes));
  if (!m) return null;
  const value = m[1]
    .replace(/\s+/g, ' ')
    .replace(/[,\-\s]+$/, '')   // trailing comma/dash/space
    .trim();
  if (NOT_A_COMPANY.has(value.toLowerCase())) return null;
  return value;
}

async function revert() {
  const exists = await db.get('SELECT to_regclass($1) AS t', [BACKUP_TABLE]);
  if (!exists || !exists.t) {
    console.error(`No ${BACKUP_TABLE} table found — nothing to revert.`);
    process.exit(1);
  }
  const n = await db.transaction(async (tx) => {
    const r = await tx.run(`
      UPDATE participants p SET company = b.company
        FROM ${BACKUP_TABLE} b WHERE p.id = b.id
    `);
    return r.rowCount;
  });
  console.log(`Reverted company on ${n} delegate(s).`);
}

async function main() {
  if (REVERT) return revert();

  const rows = await db.all(`
    SELECT id, name, company, notes FROM participants ORDER BY id
  `);
  console.log(`Scanned ${rows.length} delegates.\n`);

  const changes = [];
  const alreadySet = [];
  const noCompany = [];

  for (const r of rows) {
    const parsed = extractCompany(r.notes);
    if (!parsed) { if (!r.company) noCompany.push(r); continue; }
    // Never overwrite something a human has already entered.
    if (r.company && r.company.trim()) { alreadySet.push(r); continue; }
    changes.push({ id: r.id, name: r.name, company: parsed });
  }

  if (changes.length) {
    console.log('id     delegate                        company');
    console.log('-'.repeat(88));
    for (const c of changes) {
      console.log(`${String(c.id).padEnd(6)} ${String(c.name).slice(0, 30).padEnd(31)} ${c.company}`);
    }
    console.log('-'.repeat(88));
  }
  console.log(`${changes.length} delegate(s) would get a company.`);
  console.log(`${alreadySet.length} already have one set (left alone).`);
  console.log(`${noCompany.length} have no company anywhere — these need collecting.\n`);

  if (!changes.length) { console.log('Nothing to do.'); return; }
  if (!APPLY) { console.log('DRY RUN — nothing written. Re-run with --apply to commit.'); return; }

  await db.transaction(async (tx) => {
    await tx.run(`DROP TABLE IF EXISTS ${BACKUP_TABLE}`);
    await tx.run(`
      CREATE TABLE ${BACKUP_TABLE} AS
        SELECT id, company, NOW() AS backed_up_at
          FROM participants WHERE id = ANY($1::int[])
    `, [changes.map((c) => c.id)]);
    for (const c of changes) {
      await tx.run('UPDATE participants SET company=$1 WHERE id=$2', [c.company, c.id]);
    }
  });

  console.log(`Applied to ${changes.length} delegate(s). Previous values in ${BACKUP_TABLE}.`);
  console.log('To undo:  node server/scripts/backfill-delegate-company.js --revert');
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });

module.exports = { extractCompany };
