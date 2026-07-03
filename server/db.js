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
      role TEXT NOT NULL DEFAULT 'admin' CHECK (role IN ('super_admin','admin')),
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','disabled')),
      created_at TIMESTAMP DEFAULT NOW(),
      approved_at TIMESTAMP,
      approved_by INTEGER REFERENCES users(id)
    );
  `);

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
}

module.exports = { pool, all, get, run, transaction, initSchema };
