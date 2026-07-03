// One-time (but safe to re-run) loader for the real SINC2026 congress data
// bundled in server/seed-data/{clubs,registrations,participants}.csv.
//
// Run it once against your production database after the backend is deployed:
//   DATABASE_URL=<your Render Postgres URL> node server/scripts/seed-real-data.js
//
// It's idempotent — clubs are upserted by name, registrations by reg_number —
// so re-running it just refreshes those rows rather than duplicating them.
// Participants are only inserted if the table is currently empty, since they
// don't have a natural unique key to upsert on.

const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const db = require('../db');

const SEED_DIR = path.join(__dirname, '..', 'seed-data');

function readCsv(filename) {
  const raw = fs.readFileSync(path.join(SEED_DIR, filename), 'utf8');
  return parse(raw, { columns: true, skip_empty_lines: true, trim: true });
}

async function main() {
  await db.initSchema();

  const clubs = readCsv('clubs.csv');
  const registrations = readCsv('registrations.csv');
  const participants = readCsv('participants.csv');

  console.log(`Loaded from CSV: ${clubs.length} clubs, ${registrations.length} registrations, ${participants.length} participants`);

  await db.transaction(async (tx) => {
    for (const c of clubs) {
      await tx.run(
        `INSERT INTO clubs (name, city, state, zone, members_count)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (name) DO UPDATE SET
           city=excluded.city, state=excluded.state, zone=excluded.zone,
           members_count=excluded.members_count, updated_at=NOW()`,
        [c.name, c.city || '', c.state || '', c.zone || '', Number(c.members_count || 0)]
      );
    }
    console.log(`Upserted ${clubs.length} clubs.`);

    for (const r of registrations) {
      const club = r.club_name ? await tx.get('SELECT id FROM clubs WHERE name = $1', [r.club_name]) : null;
      await tx.run(
        `INSERT INTO registrations (reg_number, reg_type, club_id, amount_paid, amount_due, payment_mode, payment_status, payment_ref)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (reg_number) DO UPDATE SET
           reg_type=excluded.reg_type, club_id=excluded.club_id, amount_paid=excluded.amount_paid,
           amount_due=excluded.amount_due, payment_mode=excluded.payment_mode,
           payment_status=excluded.payment_status, payment_ref=excluded.payment_ref`,
        [
          r.reg_number,
          (r.reg_type || 'single').toLowerCase(),
          club ? club.id : null,
          Number(r.amount_paid || 0),
          Number(r.amount_due || 0),
          r.payment_mode || '',
          r.payment_status || 'pending',
          r.payment_ref || ''
        ]
      );
    }
    console.log(`Upserted ${registrations.length} registrations.`);

    const existingParticipants = await tx.get('SELECT COUNT(*) AS n FROM participants');
    if (Number(existingParticipants.n) > 0) {
      console.log(`Participants table already has ${existingParticipants.n} rows — skipping participant import to avoid duplicates. Delete existing rows first if you want to reload from CSV.`);
    } else {
      for (const p of participants) {
        const club = p.club_name ? await tx.get('SELECT id FROM clubs WHERE name = $1', [p.club_name]) : null;
        const reg = p.reg_number ? await tx.get('SELECT id FROM registrations WHERE reg_number = $1', [p.reg_number]) : null;
        await tx.run(
          `INSERT INTO participants
             (registration_id, is_primary, name, phone, whatsapp, email, address, club_id, designation, dietary_preference,
              travel_mode, travel_number, travel_datetime, arrival_point,
              departure_mode, departure_number, departure_datetime,
              pickup_by, pickup_vehicle, pickup_phone, spoc_name, spoc_phone, notes)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)`,
          [
            reg ? reg.id : null,
            p.is_primary !== undefined ? Number(p.is_primary) : 1,
            p.name || '',
            p.phone || '',
            p.whatsapp || p.phone || '',
            p.email || '',
            p.address || '',
            club ? club.id : null,
            p.designation || '',
            p.dietary_preference || null,
            p.travel_mode || null,
            p.travel_number || '',
            p.travel_datetime || '',
            p.arrival_point || '',
            p.departure_mode || null,
            p.departure_number || '',
            p.departure_datetime || '',
            p.pickup_by || '',
            p.pickup_vehicle || '',
            p.pickup_phone || '',
            p.spoc_name || '',
            p.spoc_phone || '',
            p.notes || ''
          ]
        );
      }
      console.log(`Inserted ${participants.length} participants.`);
    }
  });

  console.log('Seed complete.');
  process.exit(0);
}

main().catch((e) => {
  console.error('Seed failed:', e);
  process.exit(1);
});
