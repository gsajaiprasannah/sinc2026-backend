#!/usr/bin/env node
/**
 * seed-agenda.js — loads the real 13/14 August programme from AGENDA.docx.
 *
 * WHAT IT REPLACES
 *   The itinerary held 11 placeholder rows written before the programme was
 *   finalised ("Noon India Congress General Assembly", "Afternoon B2B session"
 *   and so on) and zero agenda events. This deletes only the 13 and 14 August
 *   placeholders and inserts the actual programme in their place.
 *
 * WHAT IT KEEPS
 *   12 August (hotel check-in, Welcome Gala Dinner) and 15 August (departure)
 *   are untouched — the source document does not cover those days, and losing
 *   them would leave arriving and departing delegates with nothing to read.
 *
 * SPELLING
 *   The source document contains a number of typos (INAUGRAL, TOURISUM,
 *   HOSIPITALITY, BUSSES, PANNEL, "9:0A0M", "12;45", "5:30 TP 6:30"). Those are
 *   corrected here. Speaker NAMES are also corrected where the intended person
 *   is unambiguous, but every one is listed in the run output so they can be
 *   checked against the printed programme before this goes in front of anyone.
 *
 * SAFETY
 *   - Dry run by default. Nothing is written without --apply.
 *   - --apply snapshots the existing rows to itinerary_agenda_backup first.
 *   - --revert restores that snapshot.
 *   - The whole load runs in one transaction.
 *
 * USAGE
 *   node server/scripts/seed-agenda.js            # preview
 *   node server/scripts/seed-agenda.js --apply    # commit
 *   node server/scripts/seed-agenda.js --revert --apply
 *
 * Run on the Render shell (needs DATABASE_URL).
 */

const db = require('../db');

const APPLY = process.argv.includes('--apply');
const REVERT = process.argv.includes('--revert');
const BACKUP = 'itinerary_agenda_backup';

// Day labels must match the style already used by the 12 and 15 August rows,
// otherwise the delegate view groups the same day into two headings.
const DAY_13 = '13 Aug · Fri';
const DAY_14 = '14 Aug · Sat';

// Each block becomes one itinerary_items row; its `events` become agenda_events
// hanging off it. Blocks are the coarse "where do I need to be" view; events are
// the detailed programme.
const BLOCKS = [
  {
    day: DAY_13,
    time: 'Morning · 9:00 AM',
    title: 'Congress Sessions — Day 1',
    description: 'Le Méridien, Coimbatore. Inaugural session, panel discussion and keynote addresses.',
    events: [
      { time: '9:00 AM – 9:30 AM', title: 'Cultural Dance' },
      { time: '9:30 AM – 11:00 AM', title: 'Inaugural Session' },
      { time: '11:00 AM – 11:15 AM', title: 'Tea Break' },
      {
        time: '11:15 AM – 12:00 PM',
        title: 'Panel Discussion — Sustainable and Responsible Tourism',
        description: 'Moderator: Ms. June Mukherjee. Panellists: Mr. Vismiju Viswanathan, I.F.S.; Mr. Jose Luis Quintero; Mr. Vijay Prabhu.'
      },
      {
        time: '12:00 PM – 12:45 PM',
        title: 'Keynote Address — Technology Transforming Travel & Hospitality',
        description: 'Mr. Venkatesh Rajendran, TEDx Speaker.'
      },
      {
        time: '12:45 PM – 1:30 PM',
        title: 'From Burnout to Balance — Creating a Sustainable Lifestyle in Tourism & Hospitality',
        description: 'Dr. Jayamahesh (Hons), Fitness & Wellness Therapist.'
      },
      { time: '1:30 PM – 2:30 PM', title: 'Lunch' },
      {
        time: '2:30 PM – 3:30 PM',
        title: 'Address by Dr. Arokiaswamy Velumani',
        description: 'Founder, Thyrocare Technologies Ltd.'
      }
    ]
  },
  {
    day: DAY_13,
    time: 'Evening · 4:15 PM',
    title: 'Evening at My Village — Eco Rural Resort',
    description: 'Buses depart the congress venue. Please be at the pickup point on time.',
    events: [
      { time: '4:15 PM', title: 'Buses depart for My Village — Eco Rural Resort' },
      { time: '5:30 PM', title: 'Arrival at My Village' },
      { time: '5:30 PM – 6:30 PM', title: 'High Tea' },
      { time: '7:30 PM', title: 'Dinner' },
      { time: '9:30 PM', title: 'Buses depart for respective hotels' }
    ]
  },
  {
    day: DAY_14,
    time: 'Morning',
    title: 'Breakfast at your hotel',
    description: 'Sessions begin at 10:00 AM at the congress venue.',
    events: []
  },
  {
    day: DAY_14,
    time: 'Morning · 10:00 AM',
    title: 'Congress Sessions — Day 2',
    description: 'Keynote addresses, panel discussions and special address.',
    events: [
      {
        time: '10:00 AM – 10:45 AM',
        title: 'Keynote Addresses',
        description: 'Mr. Vikram Cotah, GRT Hotels & Resorts; Dr. Palani G. Periasamy, PGP Group; Mr. Subramanian Suryanarayanan.'
      },
      { time: '10:45 AM – 11:00 AM', title: 'Tea Break' },
      {
        time: '11:00 AM – 11:20 AM',
        title: 'Discover Kongu Nadu — Its History, Heritage & Culture',
        description: 'Mr. Rajesh Govindaraju.'
      },
      {
        time: '11:20 AM – 11:50 AM',
        title: 'Panel Discussion 1 — Beyond the Kitchen: Future of Kitchen Technology',
        description: 'Mr. Sathish Kumar, Managing Director, Essemm Corporation; Chef Ajeeth, The Residency Towers.'
      },
      {
        time: '11:50 AM – 12:10 PM',
        title: 'Special Address — Coimbatore: The Future Hub for Conferences & Events',
        description: 'Mr. Mohammed Nazer.'
      },
      {
        time: '12:15 PM – 1:30 PM',
        title: 'Panel Discussion 2',
        description: 'Mr. Manoj Mathew, Vice President, O by Tamara; Mr. Sathish, Trustee, Siruthuli; Mr. Dev Karvat, CEO, Asego.'
      },
      { time: '1:30 PM – 2:00 PM', title: 'Lunch' }
    ]
  },
  {
    day: DAY_14,
    time: 'Afternoon · 2:30 PM',
    title: 'Skål National AGM',
    description: 'Annual General Meeting, 2:30 PM to 5:30 PM.',
    events: [{ time: '2:30 PM – 5:30 PM', title: 'Skål National AGM' }]
  },
  {
    day: DAY_14,
    time: 'Evening · 7:00 PM',
    title: 'Skål Awards Night',
    description: 'From 7:00 PM onwards. Buses depart for respective hotels at 10:00 PM.',
    events: [
      { time: '7:00 PM onwards', title: 'Skål Awards Night' },
      { time: '10:00 PM', title: 'Buses depart for respective hotels' }
    ]
  }
];

function speakerList() {
  const names = [];
  BLOCKS.forEach((b) => b.events.forEach((e) => {
    if (e.description && /[A-Z]\w+ [A-Z]/.test(e.description)) names.push(`${e.time} — ${e.description}`);
  }));
  return names;
}

async function main() {
  if (REVERT) return revert();

  const existing = await db.all('SELECT * FROM itinerary_items ORDER BY sort_order, id');
  const doomed = existing.filter((r) => r.day_label === DAY_13 || r.day_label === DAY_14);
  const kept = existing.filter((r) => r.day_label !== DAY_13 && r.day_label !== DAY_14);

  console.log(`\nExisting itinerary rows: ${existing.length}`);
  console.log(`\nKEEPING ${kept.length} (not 13 or 14 August):`);
  kept.forEach((r) => console.log(`   #${r.id} [${r.day_label}] ${r.time_label || ''} ${r.title}`));
  console.log(`\nREPLACING ${doomed.length} placeholder row(s) on 13/14 August:`);
  doomed.forEach((r) => console.log(`   #${r.id} [${r.day_label}] ${r.time_label || ''} ${r.title}`));

  const eventCount = BLOCKS.reduce((s, b) => s + b.events.length, 0);
  console.log(`\nINSERTING ${BLOCKS.length} block(s) and ${eventCount} agenda event(s):`);
  BLOCKS.forEach((b) => {
    console.log(`   [${b.day}] ${b.time} — ${b.title}`);
    b.events.forEach((e) => console.log(`        ${e.time}  ${e.title}`));
  });

  console.log('\nCHECK THESE NAMES against the printed programme before publishing:');
  speakerList().forEach((s) => console.log('   ' + s));

  if (!APPLY) {
    console.log('\nDRY RUN — nothing written. Re-run with --apply to commit.\n');
    return;
  }

  await db.transaction(async (tx) => {
    await tx.run(`DROP TABLE IF EXISTS ${BACKUP}`);
    await tx.run(`CREATE TABLE ${BACKUP} AS TABLE itinerary_items`);

    for (const d of doomed) {
      await tx.run('DELETE FROM itinerary_items WHERE id = $1', [d.id]);
    }

    // Continue the sort_order after whatever 12 August already uses, so the
    // day ordering in the delegate view stays correct.
    let order = 100;
    for (const b of BLOCKS) {
      const item = await tx.run(
        `INSERT INTO itinerary_items (day_label, time_label, title, description, sort_order)
         VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [b.day, b.time, b.title, b.description || null, order]);
      let ev = 0;
      for (const e of b.events) {
        await tx.run(
          `INSERT INTO agenda_events (itinerary_item_id, time_label, title, description, sort_order)
           VALUES ($1,$2,$3,$4,$5)`,
          [item.id, e.time, e.title, e.description || null, ev]);
        ev += 1;
      }
      order += 10;
    }
  });

  const after = await db.get('SELECT COUNT(*)::int AS n FROM itinerary_items');
  const ev = await db.get('SELECT COUNT(*)::int AS n FROM agenda_events');
  console.log(`\nDone. ${after.n} itinerary row(s), ${ev.n} agenda event(s).`);
  console.log(`Backup of the previous itinerary is in ${BACKUP}.`);
  console.log('Revert with: node server/scripts/seed-agenda.js --revert --apply\n');
}

async function revert() {
  const exists = await db.get(`SELECT to_regclass('${BACKUP}') AS t`);
  if (!exists || !exists.t) { console.error(`\nNo ${BACKUP} table — nothing to revert.\n`); process.exitCode = 1; return; }
  if (!APPLY) { console.log('\nDRY RUN — re-run with --revert --apply to restore.\n'); return; }
  await db.transaction(async (tx) => {
    await tx.run('DELETE FROM itinerary_items');
    await tx.run(`INSERT INTO itinerary_items SELECT * FROM ${BACKUP}`);
    await tx.run(`SELECT setval(pg_get_serial_sequence('itinerary_items','id'), COALESCE((SELECT MAX(id) FROM itinerary_items), 1))`);
  });
  console.log('\nRestored the previous itinerary. Agenda events for the deleted rows were removed by cascade and are not restored.\n');
}

main()
  .catch((e) => { console.error('\nFAILED:', e.message, '\n'); process.exitCode = 1; })
  .finally(() => db.pool.end());
