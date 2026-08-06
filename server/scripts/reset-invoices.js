#!/usr/bin/env node
/**
 * reset-invoices.js — wipe the GST invoice ledger back to a clean slate.
 *
 * Deletes every row from `invoices` and resets every per-series counter in
 * `invoice_counters` to 0, so the next invoice raised starts again at
 * SINC/<FY>/<SERIES>/0001.
 *
 * WHEN THIS IS THE RIGHT TOOL
 *   Only while the invoicing feature is still being tested and no invoice has
 *   been given to a delegate, sponsor or exhibitor, or included in any GST
 *   return. Once an invoice has left the building, the correct action is to
 *   CANCEL it (POST /api/invoices/:id/cancel), not delete it — a tax invoice
 *   ledger is expected to be gapless and auditable, and deleting a number that
 *   somebody already holds a copy of leaves you unable to explain it later.
 *   This script deliberately refuses to run past a small ledger for that
 *   reason; see MAX_SAFE_ROWS below.
 *
 *   I am not a tax adviser — if in doubt, check with whoever files the club's
 *   returns before running this with --apply.
 *
 * SAFETY
 *   - Dry run by default. Nothing is written unless you pass --apply.
 *   - --apply copies every invoice row into invoices_reset_backup first,
 *     inside the same transaction, so --revert can put them back.
 *   - Refuses to delete more than MAX_SAFE_ROWS invoices unless you also pass
 *     --force. Three test invoices is a reset; forty is an accident.
 *   - Any error rolls the whole thing back.
 *
 * USAGE
 *   node server/scripts/reset-invoices.js            # preview
 *   node server/scripts/reset-invoices.js --apply    # commit
 *   node server/scripts/reset-invoices.js --revert   # restore from backup
 *
 * Run this on the Render shell (it needs DATABASE_URL), never on a laptop.
 */

const db = require('../db');

const APPLY = process.argv.includes('--apply');
const REVERT = process.argv.includes('--revert');
const FORCE = process.argv.includes('--force');
const BACKUP_TABLE = 'invoices_reset_backup';

// A guard against running this against a real ledger by mistake. Wiping three
// test invoices is housekeeping; wiping a live book is a compliance problem.
const MAX_SAFE_ROWS = 10;

function money(n) {
  return Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function printLedger(rows) {
  if (!rows.length) {
    console.log('  (none)');
    return;
  }
  rows.forEach((r) => {
    console.log(
      `  ${String(r.invoice_number).padEnd(24)} ${String(r.status).padEnd(9)} ` +
      `${String(r.module).padEnd(13)} entity#${String(r.entity_id).padEnd(6)} ` +
      `Rs. ${money(r.total).padStart(12)}  ${r.party_name || ''}`
    );
  });
}

async function main() {
  if (REVERT) return revert();

  const invoices = await db.all(`SELECT * FROM invoices ORDER BY id`);
  const counters = await db.all(`SELECT * FROM invoice_counters ORDER BY series`);

  console.log(`\nInvoices currently in the ledger: ${invoices.length}`);
  printLedger(invoices);

  console.log(`\nSeries counters: ${counters.length}`);
  counters.forEach((c) => console.log(`  ${String(c.series).padEnd(10)} last_number = ${c.last_number}`));

  if (!invoices.length && !counters.some((c) => c.last_number > 0)) {
    console.log('\nNothing to do — the ledger is already empty and all counters are at 0.\n');
    return;
  }

  if (invoices.length > MAX_SAFE_ROWS && !FORCE) {
    console.error(
      `\nREFUSING TO RUN: ${invoices.length} invoices is more than the ${MAX_SAFE_ROWS}-row safety limit.\n` +
      'That is too many to be a test batch. If some of these were issued to real\n' +
      'parties, cancel them individually instead of deleting them. If you are\n' +
      'certain, re-run with --force.\n'
    );
    process.exitCode = 1;
    return;
  }

  if (!APPLY) {
    console.log(
      `\nDRY RUN — nothing written.\n` +
      `--apply would delete all ${invoices.length} invoice(s), reset ${counters.length} counter(s) to 0,\n` +
      `and back the rows up to ${BACKUP_TABLE} first.\n` +
      `The next invoice raised would then be numbered ...0001 again.\n`
    );
    return;
  }

  await db.transaction(async (tx) => {
    // Backup is a full structural copy so --revert can restore rows verbatim,
    // including their original ids and invoice numbers.
    await tx.run(`DROP TABLE IF EXISTS ${BACKUP_TABLE}`);
    await tx.run(`CREATE TABLE ${BACKUP_TABLE} AS TABLE invoices`);
    const backed = await tx.get(`SELECT COUNT(*)::int AS n FROM ${BACKUP_TABLE}`);
    if (backed.n !== invoices.length) {
      throw new Error(`Backup mismatch: expected ${invoices.length} rows, backed up ${backed.n}. Rolling back.`);
    }

    await tx.run(`DELETE FROM invoices`);
    // Counters are reset rather than deleted: nextInvoiceNumber() locks an
    // existing row, so keeping the rows at 0 preserves that path exactly.
    await tx.run(`UPDATE invoice_counters SET last_number = 0`);
  });

  const left = await db.get(`SELECT COUNT(*)::int AS n FROM invoices`);
  console.log(
    `\nDone. ${invoices.length} invoice(s) deleted, counters reset to 0, ${left.n} row(s) remaining.\n` +
    `Backup kept in ${BACKUP_TABLE} — run with --revert to undo.\n` +
    `The next invoice raised will be numbered ...0001.\n`
  );
}

async function revert() {
  const exists = await db.get(`SELECT to_regclass('${BACKUP_TABLE}') AS t`);
  if (!exists || !exists.t) {
    console.error(`\nNo ${BACKUP_TABLE} table found — nothing to revert.\n`);
    process.exitCode = 1;
    return;
  }
  const rows = await db.all(`SELECT * FROM ${BACKUP_TABLE} ORDER BY id`);
  console.log(`\nRestoring ${rows.length} invoice(s) from ${BACKUP_TABLE}:`);
  printLedger(rows);

  if (!APPLY) {
    console.log('\nDRY RUN — nothing written. Re-run with --revert --apply to restore.\n');
    return;
  }

  await db.transaction(async (tx) => {
    await tx.run(`DELETE FROM invoices`);
    await tx.run(`INSERT INTO invoices SELECT * FROM ${BACKUP_TABLE}`);
    // Put each series counter back to the highest number it had handed out,
    // so restored invoices can never have their numbers reissued.
    await tx.run(`
      UPDATE invoice_counters c
         SET last_number = COALESCE(sub.mx, 0)
        FROM (
          SELECT series,
                 MAX(NULLIF(regexp_replace(invoice_number, '^.*/', ''), '')::int) AS mx
            FROM invoices GROUP BY series
        ) sub
       WHERE sub.series = c.series
    `);
    // Keep the sequence ahead of the restored ids so new inserts don't collide.
    await tx.run(`SELECT setval(pg_get_serial_sequence('invoices','id'), COALESCE((SELECT MAX(id) FROM invoices), 1))`);
  });

  console.log(`\nRestored ${rows.length} invoice(s) and re-synced the series counters.\n`);
}

main()
  .catch((e) => { console.error('\nFAILED:', e.message, '\n'); process.exitCode = 1; })
  .finally(() => db.pool.end());
