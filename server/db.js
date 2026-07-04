const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.warn('DATABASE_URL is not set — the server will not be able to connect to Postgres.');
}

// Render (and most managed Postgres hosts) require SSL for external connections,
// and use certificates that aren't in Node's default trust store — hence rejectUnauthorized:false.
// Set DATABASE_SSL=false only for a local Postgres instance with no SSL configured.
const pool = new Pool({
  connectionString,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false }
});

pool.on('error', (err) => {
  console.error('Unexpected Postgres pool error', err);
});

async function all(text, params = []) {
  const r = await pool.query(text, params);
  return r.rows;
}

async function get(text, params = []) {
  const r = await pool.query(text, params);
  return r.rows[0] || null;
}

async function run(text, params = []) {
  const r = await pool.query(text, params);
  return { rowCount: r.rowCount, id: r.rows && r.rows[0] ? r.rows[0].id : undefined, rows: r.rows };
}

// Runs fn(scopedClient) inside a single Postgres transaction (BEGIN/COMMIT/ROLLBACK).
// scopedClient exposes the same all/get/run helpers, bound to the transaction's connection.
async function transaction(fn) {
  const client = await pool.connect();
  const scoped = {
    all: async (text, params = []) => (await client.query(text, params)).rows,
    get: async (text, params = []) => (await client.query(text, params)).rows[0] || null,
    run: async (text, params = []) => {
      const r = await client.query(text, params);
      return { rowCount: r.rowCount, id: r.rows && r.rows[0] ? r.rows[0].id : undefined, rows: r.rows };
    }
  };
  try {
    await client.query('BEGIN');
    const result = await fn(scoped);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
    throw e;
  } finally {
    client.release();
  }
}

async function initSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS clubs (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      city TEXT,
      state TEXT,
      zone TEXT,
      members_count INTEGER NOT NULL DEFAULT 0,
      updated_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS registrations (
      id SERIAL PRIMARY KEY,
      reg_number TEXT NOT NULL UNIQUE,
      reg_type TEXT NOT NULL CHECK (reg_type IN ('single','double')),
      club_id INTEGER REFERENCES clubs(id),
      amount_paid NUMERIC NOT NULL DEFAULT 0,
      amount_due NUMERIC NOT NULL DEFAULT 0,
      payment_mode TEXT,
      payment_status TEXT NOT NULL DEFAULT 'pending' CHECK (payment_status IN ('paid','partial','pending','refunded')),
      payment_ref TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS participants (
      id SERIAL PRIMARY KEY,
      registration_id INTEGER REFERENCES registrations(id) ON DELETE CASCADE,
      is_primary INTEGER NOT NULL DEFAULT 1,
      name TEXT NOT NULL,
      phone TEXT,
      whatsapp TEXT,
      email TEXT,
      address TEXT,
      club_id INTEGER REFERENCES clubs(id),
      designation TEXT,
      dietary_preference TEXT,
      travel_mode TEXT CHECK (travel_mode IN ('flight','train','road','other') OR travel_mode IS NULL),
      travel_number TEXT,
      travel_datetime TEXT,
      arrival_point TEXT,
      departure_mode TEXT CHECK (departure_mode IN ('flight','train','road','other') OR departure_mode IS NULL),
      departure_number TEXT,
      departure_datetime TEXT,
      pickup_by TEXT,
      pickup_vehicle TEXT,
      pickup_phone TEXT,
      spoc_name TEXT,
      spoc_phone TEXT,
      notes TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS media (
      id SERIAL PRIMARY KEY,
      type TEXT NOT NULL CHECK (type IN ('video','poster')),
      filename TEXT NOT NULL,
      original_name TEXT,
      title TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0,
      uploaded_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS happenings (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      category TEXT DEFAULT 'general',
      posted_by TEXT,
      happened_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      email TEXT,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'admin' CHECK (role IN ('super_admin','admin','host_member')),
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','disabled')),
      created_at TIMESTAMP DEFAULT NOW(),
      approved_at TIMESTAMP,
      approved_by INTEGER REFERENCES users(id)
    );

    -- --- Host club module (Skål Coimbatore members organizing/hosting the congress) ---
    -- These are distinct from 'participants' (the delegates attending). Host members
    -- volunteer to assist delegates, sit on committees, and pay their own ₹5000
    -- host-club contribution, tracked separately from delegate registration payments.
    CREATE TABLE IF NOT EXISTS host_members (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT,
      phone TEXT,
      company TEXT,
      designation TEXT,
      category TEXT,
      payment_status TEXT NOT NULL DEFAULT 'pending' CHECK (payment_status IN ('paid','pending')),
      payment_amount NUMERIC NOT NULL DEFAULT 5000,
      payment_date DATE,
      payment_mode TEXT,
      notes TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS committees (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      sort_order INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS committee_members (
      id SERIAL PRIMARY KEY,
      committee_id INTEGER NOT NULL REFERENCES committees(id) ON DELETE CASCADE,
      host_member_id INTEGER NOT NULL REFERENCES host_members(id) ON DELETE CASCADE,
      UNIQUE(committee_id, host_member_id)
    );

    -- Who is responsible for assisting which delegate — the "who's responsible
    -- for whom" tracking the congress team asked for, with a status so progress
    -- on that assistance can be followed over time.
    CREATE TABLE IF NOT EXISTS delegate_assignments (
      id SERIAL PRIMARY KEY,
      host_member_id INTEGER NOT NULL REFERENCES host_members(id) ON DELETE CASCADE,
      participant_id INTEGER NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
      role TEXT NOT NULL DEFAULT 'assistance',
      status TEXT NOT NULL DEFAULT 'not_started' CHECK (status IN ('not_started','in_progress','completed')),
      notes TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(host_member_id, participant_id)
    );

    -- Checklist / milestone items for each host member — their individual
    -- roles-and-responsibilities tracker. is_milestone just flags the bigger
    -- checkpoints so they can be visually distinguished from routine to-dos.
    CREATE TABLE IF NOT EXISTS host_tasks (
      id SERIAL PRIMARY KEY,
      host_member_id INTEGER NOT NULL REFERENCES host_members(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      description TEXT,
      is_milestone INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','in_progress','done')),
      due_date DATE,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );

    -- Masters: partner organizations (transport providers, caterers, hotels, etc.)
    CREATE TABLE IF NOT EXISTS partners (
      id SERIAL PRIMARY KEY,
      category TEXT NOT NULL DEFAULT 'other',
      name TEXT NOT NULL,
      contact_person TEXT,
      phone TEXT,
      email TEXT,
      notes TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );

    -- Masters: individual drivers, optionally linked to a transport partner
    CREATE TABLE IF NOT EXISTS drivers (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      phone TEXT,
      vehicle_number TEXT,
      vehicle_type TEXT,
      partner_id INTEGER REFERENCES partners(id) ON DELETE SET NULL,
      notes TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );

    -- Congress agenda/itinerary, editable from the admin panel instead of
    -- being hardcoded on the public site.
    CREATE TABLE IF NOT EXISTS itinerary_items (
      id SERIAL PRIMARY KEY,
      day_label TEXT NOT NULL,
      time_label TEXT,
      title TEXT NOT NULL,
      description TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0
    );

    -- --- Operations: Transport Planning + Pre Tours ---
    -- Masters: vehicles, identified by an auto-generated code so anyone on
    -- the ground can radio/WhatsApp "S001" instead of a full number plate.
    -- Prefix carries the type: S = van (Shuttle van), C = car, A = bus (coACH).
    CREATE TABLE IF NOT EXISTS vehicles (
      id SERIAL PRIMARY KEY,
      vehicle_code TEXT NOT NULL UNIQUE,
      vehicle_type TEXT NOT NULL CHECK (vehicle_type IN ('van','car','bus')),
      model TEXT,
      seating_capacity INTEGER NOT NULL DEFAULT 0,
      registration_number TEXT,
      partner_id INTEGER REFERENCES partners(id) ON DELETE SET NULL,
      notes TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );

    -- Shuttle/trip planning: mobilising delegates + host members between
    -- venues, hotels, and attractions. pre_tour_id is set only when this trip
    -- belongs to a Pre Tour's own transport plan; NULL means general congress
    -- transport planning. Reusing one table for both keeps vehicle/driver
    -- assignment and passenger management identical in both modules.
    CREATE TABLE IF NOT EXISTS transport_trips (
      id SERIAL PRIMARY KEY,
      pre_tour_id INTEGER,
      trip_date DATE,
      depart_time TEXT,
      from_location TEXT NOT NULL,
      to_location TEXT NOT NULL,
      purpose TEXT,
      vehicle_id INTEGER REFERENCES vehicles(id) ON DELETE SET NULL,
      driver_id INTEGER REFERENCES drivers(id) ON DELETE SET NULL,
      status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','in_progress','completed','cancelled')),
      notes TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );

    -- Passenger manifest per trip. Exactly one of participant_id (a delegate)
    -- or host_member_id must be set — mobilisation covers both audiences.
    CREATE TABLE IF NOT EXISTS transport_trip_passengers (
      id SERIAL PRIMARY KEY,
      trip_id INTEGER NOT NULL REFERENCES transport_trips(id) ON DELETE CASCADE,
      participant_id INTEGER REFERENCES participants(id) ON DELETE CASCADE,
      host_member_id INTEGER REFERENCES host_members(id) ON DELETE CASCADE,
      pickup_point TEXT,
      notes TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      CHECK ((participant_id IS NOT NULL AND host_member_id IS NULL) OR (participant_id IS NULL AND host_member_id IS NOT NULL)),
      UNIQUE(trip_id, participant_id),
      UNIQUE(trip_id, host_member_id)
    );

    -- Pre Tours: optional pre-congress excursions (hotel + attractions +
    -- itinerary + their own transport plan), each linked to the delegates and
    -- host members who opted in.
    CREATE TABLE IF NOT EXISTS pre_tours (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      start_date DATE,
      end_date DATE,
      hotel TEXT,
      attractions TEXT,
      description TEXT,
      capacity INTEGER,
      price NUMERIC,
      status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','confirmed','cancelled','completed')),
      notes TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS pre_tour_itinerary (
      id SERIAL PRIMARY KEY,
      pre_tour_id INTEGER NOT NULL REFERENCES pre_tours(id) ON DELETE CASCADE,
      day_label TEXT NOT NULL,
      time_label TEXT,
      title TEXT NOT NULL,
      description TEXT,
      location TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS pre_tour_participants (
      id SERIAL PRIMARY KEY,
      pre_tour_id INTEGER NOT NULL REFERENCES pre_tours(id) ON DELETE CASCADE,
      participant_id INTEGER REFERENCES participants(id) ON DELETE CASCADE,
      host_member_id INTEGER REFERENCES host_members(id) ON DELETE CASCADE,
      payment_status TEXT NOT NULL DEFAULT 'pending' CHECK (payment_status IN ('paid','pending')),
      notes TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      CHECK ((participant_id IS NOT NULL AND host_member_id IS NULL) OR (participant_id IS NULL AND host_member_id IS NOT NULL)),
      UNIQUE(pre_tour_id, participant_id),
      UNIQUE(pre_tour_id, host_member_id)
    );
  `);

  // Safe to run repeatedly — links a 'users' login to a host_members profile
  // once a host member is given their own account.
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS host_member_id INTEGER REFERENCES host_members(id);`);
  // Older databases created before 'host_member' was added to the CHECK
  // constraint need it relaxed, since Postgres won't alter CHECK constraints
  // in place — drop and recreate.
  await pool.query(`ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;`);
  await pool.query(`ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('super_admin','admin','host_member'));`);

  // Older databases created before 'congress_only' was added to reg_type need
  // the CHECK constraint relaxed (Postgres won't alter CHECK constraints in
  // place — drop and recreate, same pattern as users_role_check above).
  await pool.query(`ALTER TABLE registrations DROP CONSTRAINT IF EXISTS registrations_reg_type_check;`);
  await pool.query(`ALTER TABLE registrations ADD CONSTRAINT registrations_reg_type_check CHECK (reg_type IN ('single','double','congress_only'));`);

  // Safe to run repeatedly — adds the column only if an older schema is missing it.
  await pool.query(`ALTER TABLE participants ADD COLUMN IF NOT EXISTS dietary_preference TEXT;`);

  // --- Per-participant Registration ID (e.g. SINC2026-0001) ---
  // One code per participant row, assigned automatically on insert via a DB
  // trigger + sequence — so a single registration yields one code and a
  // double registration yields two (one per person), with no app-level
  // race condition even under concurrent CSV imports.
  await pool.query(`ALTER TABLE participants ADD COLUMN IF NOT EXISTS participant_code TEXT;`);
  await pool.query(`CREATE SEQUENCE IF NOT EXISTS participant_code_seq START 1;`);
  await pool.query(`
    CREATE OR REPLACE FUNCTION set_participant_code() RETURNS TRIGGER AS $$
    BEGIN
      IF NEW.participant_code IS NULL THEN
        NEW.participant_code := 'SINC2026-' || LPAD(nextval('participant_code_seq')::text, 4, '0');
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `);
  await pool.query(`DROP TRIGGER IF EXISTS trg_set_participant_code ON participants;`);
  await pool.query(`
    CREATE TRIGGER trg_set_participant_code BEFORE INSERT ON participants
    FOR EACH ROW EXECUTE FUNCTION set_participant_code();
  `);
  // Backfill any rows that predate this column (e.g. the original real-data
  // seed), in creation order, then fast-forward the sequence past them.
  await pool.query(`
    WITH ordered AS (
      SELECT id, ROW_NUMBER() OVER (ORDER BY created_at, id) AS rn
      FROM participants WHERE participant_code IS NULL
    )
    UPDATE participants p SET participant_code = 'SINC2026-' || LPAD(o.rn::text, 4, '0')
    FROM ordered o WHERE p.id = o.id;
  `);
  await pool.query(`SELECT setval('participant_code_seq', GREATEST((SELECT COUNT(*) FROM participants), 1));`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS participants_code_uidx ON participants(participant_code);`);

  // --- Operations module follow-up migrations ---
  // A driver's usual/default vehicle, linked to the new vehicles master
  // instead of the old freetext vehicle_number/vehicle_type columns (kept
  // in place, unused by the new UI, so no historical data is lost).
  await pool.query(`ALTER TABLE drivers ADD COLUMN IF NOT EXISTS vehicle_id INTEGER REFERENCES vehicles(id) ON DELETE SET NULL;`);

  // transport_trips.pre_tour_id is declared without a FK above (pre_tours is
  // created later in the same script) — add the FK now that both tables
  // definitely exist. Guarded so this only runs once.
  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'transport_trips_pre_tour_id_fkey'
      ) THEN
        ALTER TABLE transport_trips
          ADD CONSTRAINT transport_trips_pre_tour_id_fkey
          FOREIGN KEY (pre_tour_id) REFERENCES pre_tours(id) ON DELETE SET NULL;
      END IF;
    END $$;
  `);
}

module.exports = { pool, all, get, run, transaction, initSchema };
