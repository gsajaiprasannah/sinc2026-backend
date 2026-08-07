#!/usr/bin/env node
/**
 * fix-sinc-0073.js — one-off repair for a mis-linked delegate.
 *
 * SINC-0073 is a SINGLE registration (Zahoor Qari, paid ₹22,000 on 3 July) but
 * has a second delegate attached: NASIR SHAH, added 31 July by the bulk CSV
 * upload back when it did not enforce registration capacity. He is a different
 * person entirely — different company, phone and email — and appears nowhere
 * else in the database, so he is not a duplicate of an existing delegate.
 *
 * This moves him onto a registration of his own, marked pending / ₹0, so that:
 *   - SINC-0073 goes back to holding only Zahoor Qari, as paid for;
 *   - NASIR SHAH is not lost (he has real contact details and may be coming);
 *   - he surfaces in the pending-payment list so somebody chases whether he
 *     actually paid, rather than silently travelling as someone else's guest.
 *
 * SAFETY
 *   - Dry run by default. Nothing is written unless you pass --apply.
 *   - Refuses to run if the data does not look exactly as described above, so
 *     it cannot do something unexpected if it is run twice or run late.
 *   - --revert puts him back on SINC-0073 and removes the created registration.
 *
 * USAGE
 *   node server/scripts/fix-sinc-0073.js           # preview
 *   node server/scripts/fix-sinc-0073.js --apply   # commit
 *   node server/scripts/fix-sinc-0073.js --revert --apply
 *
 * Run on the Render shell (needs DATABASE_URL).
 */

const db = require('../db');

const APPLY = process.argv.includes('--apply');
const REVERT = process.argv.includes('--revert');

const HOST_REG = 'SINC-0073';
const MOVE_NAME = 'NASIR SHAH';
const KEEP_NAME = 'Zahoor Qari';
const REG_PREFIX = 'SINC-';

async function nextRegNumber(runner) {
  const r = await runner.get(`
    SELECT COALESCE(MAX((regexp_match(reg_number, '(\\d+)$'))[1]::int), 0) AS max_num
      FROM registrations WHERE reg_number LIKE $1
  `, [`${REG_PREFIX}%`]);
  return `${REG_PREFIX}${String(Number(r.max_num) + 1).padStart(4, '0')}`;
}

async function main() {
  if (REVERT) return revert();

  const reg = await db.get('SELECT * FROM registrations WHERE reg_number = $1', [HOST_REG]);
  if (!reg) throw new Error(`${HOST_REG} not found.`);
  const people = await db.all(
    'SELECT id, name, is_primary, phone, email, company FROM participants WHERE registration_id = $1 ORDER BY is_primary DESC, id',
    [reg.id]);

  console.log(`\n${HOST_REG} — ${reg.reg_type}, Rs. ${reg.amount_paid}, ${reg.payment_status}`);
  people.forEach((p) => console.log(`   #${p.id} ${p.name}${p.is_primary ? ' (primary)' : ''} — ${p.company || 'no company'}`));

  const mover = people.find((p) => p.name === MOVE_NAME);
  const keeper = people.find((p) => p.name === KEEP_NAME);

  // Guard: only proceed if the situation is exactly what this script was
  // written for. If it has already been run, or the data has since been edited
  // by hand, doing nothing is the right outcome.
  if (!mover || !keeper || people.length !== 2) {
    console.log(`\nNothing to do — expected exactly ${KEEP_NAME} + ${MOVE_NAME} on ${HOST_REG}.`);
    console.log('Either this has already been fixed, or the data has changed. No action taken.\n');
    return;
  }

  const newNumber = await nextRegNumber(db);
  if (!APPLY) {
    console.log(`\nDRY RUN — nothing written.\n--apply would:`);
    console.log(`  1. create registration ${newNumber} (single, Rs. 0, pending)`);
    console.log(`  2. move #${mover.id} ${mover.name} onto it as the primary registrant`);
    console.log(`  3. leave ${HOST_REG} holding only #${keeper.id} ${keeper.name}\n`);
    return;
  }

  const out = await db.transaction(async (tx) => {
    const created = await tx.run(`
      INSERT INTO registrations (reg_number, reg_type, amount_paid, amount_due, payment_status)
      VALUES ($1, 'single', 0, 0, 'pending') RETURNING id
    `, [newNumber]);
    await tx.run('UPDATE participants SET registration_id = $1, is_primary = 1 WHERE id = $2',
      [created.id, mover.id]);
    return { newRegId: created.id, newNumber };
  });

  console.log(`\nDone. ${mover.name} moved to ${out.newNumber} (pending, Rs. 0).`);
  console.log(`${HOST_REG} now holds only ${keeper.name}.`);
  console.log(`Revert with: node server/scripts/fix-sinc-0073.js --revert --apply\n`);
}

async function revert() {
  const host = await db.get('SELECT id FROM registrations WHERE reg_number = $1', [HOST_REG]);
  const mover = await db.get('SELECT id, registration_id FROM participants WHERE name = $1', [MOVE_NAME]);
  if (!host || !mover) throw new Error('Could not find the records to revert.');
  if (mover.registration_id === host.id) { console.log('\nAlready on ' + HOST_REG + ' — nothing to revert.\n'); return; }

  if (!APPLY) { console.log('\nDRY RUN — re-run with --revert --apply to move him back.\n'); return; }

  const orphan = mover.registration_id;
  await db.transaction(async (tx) => {
    await tx.run('UPDATE participants SET registration_id = $1, is_primary = 0 WHERE id = $2', [host.id, mover.id]);
    // Only remove the registration created by this script, and only if the
    // move left it with nobody on it.
    const left = await tx.get('SELECT COUNT(*)::int AS n FROM participants WHERE registration_id = $1', [orphan]);
    if (left.n === 0) await tx.run('DELETE FROM registrations WHERE id = $1', [orphan]);
  });
  console.log(`\nReverted — ${MOVE_NAME} is back on ${HOST_REG}.\n`);
}

main()
  .catch((e) => { console.error('\nFAILED:', e.message, '\n'); process.exitCode = 1; })
  .finally(() => db.pool.end());
