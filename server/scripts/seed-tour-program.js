#!/usr/bin/env node
/**
 * seed-tour-program.js — loads the SINC2026 Tour Program into pre_tours.
 *
 * Source: "SKÅL India National Congress 2026 - Tour Program.pdf"
 *   p2  10-12 Aug, 2N/3D  -> 2 pre-tours
 *   p3  11-12 Aug, 1N/2D  -> 4 pre-tours
 *   p4-7 12 Aug day visits -> 14 day tours in 5 categories
 *
 * Idempotent: matches on (name, tour_type) and updates rather than
 * duplicating, so it can be re-run after the programme changes. Signups are
 * never touched — only the tour definitions.
 *
 * Prices are deliberately left NULL. The programme sheet quotes none, and
 * guessing one would put a wrong figure in front of delegates. Day tours are
 * free (price 0); pre-tours are pay-later, so the office sets the price in
 * the admin panel once it is agreed.
 *
 * USAGE
 *   node server/scripts/seed-tour-program.js           # preview
 *   node server/scripts/seed-tour-program.js --apply   # write
 */

const db = require('../db');

const APPLY = process.argv.includes('--apply');

const OVERNIGHT_INCLUSIONS = [
  'Transportation from Coimbatore – Destination – Coimbatore',
  "%NIGHTS% nights' accommodation on a twin-sharing basis in carefully selected star-category hotels",
  'All meals during the travel',
  'All sightseeing entrance fees',
  'Professional tour coordinator',
  'Complimentary mineral water and refreshments during travel'
].join('\n');

const DAY_INCLUSIONS = [
  'Transportation from Coimbatore – Destination – Coimbatore',
  'All meals during the travel',
  'All entrance tickets for visiting sites',
  'Travel co-ordinator',
  'Mineral water bottle & snacks'
].join('\n');

function overnight(name, start, end, nights, days) {
  return {
    name,
    tour_type: 'pre',
    category: `${nights} Night${nights > 1 ? 's' : ''} / ${days} Days`,
    start_date: start,
    end_date: end,
    description: `${nights} night${nights > 1 ? 's' : ''} / ${days} days. Departs Coimbatore and returns to Coimbatore.`,
    inclusions: OVERNIGHT_INCLUSIONS.replace('%NIGHTS%', String(nights)),
    price: null,          // pay later — office sets this
    attractions: name
  };
}

function dayTour(name, category, timing) {
  return {
    name,
    tour_type: 'day',
    category,
    start_date: '2026-08-12',
    end_date: '2026-08-12',
    description: timing ? `Day visit on 12 August 2026 (${timing}).` : 'Day visit on 12 August 2026.',
    inclusions: DAY_INCLUSIONS,
    price: 0,             // day tours are free
    attractions: name
  };
}

const TOURS = [
  // --- p2: 10–12 August 2026, 2 Nights / 3 Days ---------------------------
  overnight('Ooty • Mudumalai • Coonoor (2N/3D)', '2026-08-10', '2026-08-12', 2, 3),
  overnight('Valparai (2N/3D)', '2026-08-10', '2026-08-12', 2, 3),

  // --- p3: 11–12 August 2026, 1 Night / 2 Days ----------------------------
  overnight('Kodaikanal (1N/2D)', '2026-08-11', '2026-08-12', 1, 2),
  overnight('Ooty • Coonoor (1N/2D)', '2026-08-11', '2026-08-12', 1, 2),
  overnight('Pollachi • Topslip (1N/2D)', '2026-08-11', '2026-08-12', 1, 2),
  overnight('Valparai (1N/2D)', '2026-08-11', '2026-08-12', 1, 2),

  // --- p4: Temple & Spiritual Tours ---------------------------------------
  dayTour('Temple Heritage Trail – Perur Patteeswarar Temple & Koniamman Temple', 'Temple & Spiritual Tours'),
  dayTour('Temple Heritage Trail – Koniamman Temple & Sri Thandu Mariamman Temple', 'Temple & Spiritual Tours'),
  dayTour('Marudhamalai Temple', 'Temple & Spiritual Tours'),
  dayTour('Isha Yoga Centre – Dhyanalinga & Siruvani Waterfalls', 'Temple & Spiritual Tours', '10:00 AM – 3:00 PM'),
  dayTour('Masaniamman Temple & Topslip', 'Temple & Spiritual Tours', '10:00 AM – 3:00 PM'),

  // --- p5: Nature & Hill Experiences --------------------------------------
  dayTour('Coonoor', 'Nature & Hill Experiences'),
  dayTour('Kothagiri', 'Nature & Hill Experiences'),
  dayTour('Anaikatti', 'Nature & Hill Experiences'),
  dayTour('Baralikadu Eco-Tourism', 'Nature & Hill Experiences'),

  // --- p6: Heritage & Museums / Industrial & Technical --------------------
  dayTour('G.D. Naidu Museum', 'Heritage & Museums'),
  dayTour('Gass Forest Museum', 'Heritage & Museums'),
  dayTour('Coir Manufacturing Unit', 'Industrial & Technical Visits'),
  dayTour('T-Shirt Manufacturing Unit', 'Industrial & Technical Visits'),
  dayTour('Saree Manufacturing Unit', 'Industrial & Technical Visits'),

  // --- p7: Members' Property, Hotel & Resort Visits -----------------------
  {
    ...dayTour("Members' Property, Hotel & Resort Visits", "Members' Property, Hotel & Resort Visits"),
    description: 'Visit selected member-owned hotels, resorts and landmark properties across the Coimbatore region to experience their unique offerings and connect with fellow Skål members.'
  }
];

async function main() {
  const existing = await db.all('SELECT id, name, tour_type FROM pre_tours');
  const byKey = new Map(existing.map((r) => [`${r.tour_type}|${r.name.trim().toLowerCase()}`, r]));

  const toInsert = [];
  const toUpdate = [];
  for (const t of TOURS) {
    const hit = byKey.get(`${t.tour_type}|${t.name.trim().toLowerCase()}`);
    (hit ? toUpdate : toInsert).push(hit ? { ...t, id: hit.id } : t);
  }

  console.log(`${TOURS.length} tours in the programme:`);
  console.log(`  ${toInsert.length} new, ${toUpdate.length} already present (would be updated).\n`);
  const byType = {};
  for (const t of TOURS) byType[t.tour_type] = (byType[t.tour_type] || 0) + 1;
  console.log('  by type:', JSON.stringify(byType));
  console.log('  pre-tour dates:', [...new Set(TOURS.filter((t) => t.tour_type === 'pre').map((t) => `${t.start_date}..${t.end_date}`))].join(', '));
  console.log('  day-tour date :', [...new Set(TOURS.filter((t) => t.tour_type === 'day').map((t) => t.start_date))].join(', '));
  console.log();

  if (!APPLY) {
    for (const t of TOURS) console.log(`  [${t.tour_type}] ${t.category ? t.category.padEnd(38) : ''.padEnd(38)} ${t.name}`);
    console.log('\nDRY RUN — nothing written. Re-run with --apply.');
    return;
  }

  await db.transaction(async (tx) => {
    for (const t of toInsert) {
      await tx.run(`
        INSERT INTO pre_tours
          (name, tour_type, category, start_date, end_date, description, inclusions, price, attractions, status, public_visible)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'planned',TRUE)
      `, [t.name, t.tour_type, t.category, t.start_date, t.end_date, t.description, t.inclusions, t.price, t.attractions]);
    }
    for (const t of toUpdate) {
      // Deliberately does NOT touch status, capacity or price — those are the
      // office's to manage once a tour exists.
      await tx.run(`
        UPDATE pre_tours SET
          category=$1, start_date=$2, end_date=$3, description=$4, inclusions=$5, public_visible=TRUE
        WHERE id=$6
      `, [t.category, t.start_date, t.end_date, t.description, t.inclusions, t.id]);
    }
  });

  console.log(`Applied. ${toInsert.length} inserted, ${toUpdate.length} updated. All are published to the public page.`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });

module.exports = { TOURS };
