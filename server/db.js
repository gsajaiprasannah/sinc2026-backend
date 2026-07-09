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
      departure_point TEXT,
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
      role TEXT NOT NULL DEFAULT 'admin' CHECK (role IN ('super_admin','admin','host_member','media','transporter','driver','volunteer')),
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
      sort_order INTEGER NOT NULL DEFAULT 0,
      description TEXT
    );

    -- A checklist item or milestone for a whole committee. Because a
    -- committee has multiple members, "done" isn't a single flag on this row
    -- — it's derived from committee_task_completions below, one row per
    -- member, and the task only counts as accomplished once every member of
    -- the committee has completed their own row.
    CREATE TABLE IF NOT EXISTS committee_tasks (
      id SERIAL PRIMARY KEY,
      committee_id INTEGER NOT NULL REFERENCES committees(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      description TEXT,
      is_milestone INTEGER NOT NULL DEFAULT 0,
      due_date DATE,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );

    -- Per-member completion of a committee task — seeded for every current
    -- committee member when the task is created (and for every existing task
    -- when a new member joins), so admins can see exactly who has and hasn't
    -- completed it.
    CREATE TABLE IF NOT EXISTS committee_task_completions (
      id SERIAL PRIMARY KEY,
      committee_task_id INTEGER NOT NULL REFERENCES committee_tasks(id) ON DELETE CASCADE,
      host_member_id INTEGER NOT NULL REFERENCES host_members(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done')),
      completed_at TIMESTAMP,
      UNIQUE(committee_task_id, host_member_id)
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

    -- --- Sponsors, Guest Speakers, Guest Visitors + a shared customizable ---
    -- --- checklist system (deliberately generic: labels are free text, ---
    -- --- added/edited/removed per-owner, since the exact benefit/task list ---
    -- --- keeps growing — see checklist_items below). Sponsorship rates are ---
    -- --- intentionally NOT modeled anywhere in this schema.               ---
    CREATE TABLE IF NOT EXISTS sponsors (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      tier TEXT NOT NULL DEFAULT '',
      contact_person TEXT,
      phone TEXT,
      email TEXT,
      sponsor_pass_code TEXT UNIQUE,
      guest_relation_host_member_id INTEGER REFERENCES host_members(id) ON DELETE SET NULL,
      status TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('lead','confirmed','cancelled')),
      notes TEXT,
      logo_url TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );

    -- Guest / celebrity speaker register — what they'll speak on or moderate.
    CREATE TABLE IF NOT EXISTS speakers (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      designation TEXT,
      organization TEXT,
      phone TEXT,
      email TEXT,
      topic TEXT,
      session_type TEXT NOT NULL DEFAULT 'Speaker',
      guest_relation_host_member_id INTEGER REFERENCES host_members(id) ON DELETE SET NULL,
      status TEXT NOT NULL DEFAULT 'invited' CHECK (status IN ('invited','confirmed','cancelled')),
      notes TEXT,
      photo_url TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );

    -- VIP / dignitary guest visitors (distinct from delegates, sponsors, and
    -- speakers) — what we owe/offer each of them lives in checklist_items.
    CREATE TABLE IF NOT EXISTS guest_visitors (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      designation TEXT,
      organization TEXT,
      phone TEXT,
      email TEXT,
      category TEXT,
      visit_date DATE,
      guest_relation_host_member_id INTEGER REFERENCES host_members(id) ON DELETE SET NULL,
      status TEXT NOT NULL DEFAULT 'invited' CHECK (status IN ('invited','confirmed','cancelled')),
      notes TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );

    -- One generic, fully customizable checklist system shared by sponsors
    -- (benefit checklist), speakers (what must reach them / be done for
    -- them), guest visitors (offerings), and — for the goodies/kit handover
    -- tracker — participants and host_members. owner_type+owner_id is a
    -- lightweight polymorphic reference (no DB-level FK, since it spans
    -- multiple tables); each route module deletes its own rows on owner
    -- delete. Labels are free text so new checklist items can always be
    -- added later without a schema change.
    CREATE TABLE IF NOT EXISTS checklist_items (
      id SERIAL PRIMARY KEY,
      owner_type TEXT NOT NULL CHECK (owner_type IN ('sponsor','speaker','guest_visitor','participant','host_member')),
      owner_id INTEGER NOT NULL,
      category TEXT NOT NULL DEFAULT '',
      label TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','in_progress','done')),
      sort_order INTEGER NOT NULL DEFAULT 0,
      notes TEXT,
      -- Delivery accountability: which committee is responsible for actually
      -- handing this item over (e.g. Welcome Kit -> Welcome & Registration
      -- Committee), when it's due, and who closed it out + when — so
      -- "monitoring delivery" means more than just a status flip.
      responsible_committee_id INTEGER REFERENCES committees(id) ON DELETE SET NULL,
      due_date DATE,
      completed_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      completed_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS checklist_items_owner_idx ON checklist_items(owner_type, owner_id);
    -- checklist_items_committee_idx is created later, after the
    -- responsible_committee_id backfill below — on a database where this
    -- table already existed pre-migration, CREATE TABLE IF NOT EXISTS above
    -- is a no-op and the column wouldn't exist yet at this point.

    -- --- Master checklist templates: the predefined set of checklist items ---
    -- --- that SHOULD be completed for each category (Delegates, Host        ---
    -- --- Members, Sponsors, Guest Speakers, Guest Visitors). Managed from    ---
    -- --- the Checklists & Milestones admin tab. These are just the master    ---
    -- --- "menu" of suggestions — they get copied into an individual's own   ---
    -- --- checklist_items row (above) when quick-added, so editing/deleting  ---
    -- --- a template afterwards never touches checklists already handed out. ---
    -- --- responsible_committee_id is the DEFAULT committee for every item   ---
    -- --- quick-added from this template; each resulting checklist_items row ---
    -- --- can still have its own responsible_committee_id overridden later. ---
    CREATE TABLE IF NOT EXISTS checklist_templates (
      id SERIAL PRIMARY KEY,
      owner_type TEXT NOT NULL CHECK (owner_type IN ('sponsor','speaker','guest_visitor','participant','host_member')),
      category TEXT NOT NULL DEFAULT '',
      label TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      responsible_committee_id INTEGER REFERENCES committees(id) ON DELETE SET NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS checklist_templates_owner_idx ON checklist_templates(owner_type);

    -- --- Accommodation: hotel master + per-person room assignment (delegates ---
    -- --- and host members), so we know exactly who is in which room where.  ---
    CREATE TABLE IF NOT EXISTS hotels (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      address TEXT,
      contact_person TEXT,
      phone TEXT,
      notes TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS room_assignments (
      id SERIAL PRIMARY KEY,
      hotel_id INTEGER NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
      room_number TEXT NOT NULL,
      room_type TEXT,
      participant_id INTEGER UNIQUE REFERENCES participants(id) ON DELETE CASCADE,
      host_member_id INTEGER UNIQUE REFERENCES host_members(id) ON DELETE CASCADE,
      check_in DATE,
      check_out DATE,
      notes TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      CHECK ((participant_id IS NOT NULL AND host_member_id IS NULL) OR (participant_id IS NULL AND host_member_id IS NOT NULL))
    );

    -- --- Goodies & Inventory: procurement + per-recipient delivery         ---
    -- --- tracking for physical items (kits, badges, souvenirs, merch,      ---
    -- --- etc.). Deliberately separate from checklist_items above — this    ---
    -- --- needs actual QUANTITIES in stock (procured vs. distributed vs.    ---
    -- --- remaining), which a pending/in_progress/done flag can't express.  ---
    CREATE TABLE IF NOT EXISTS inventory_items (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT '',
      unit TEXT NOT NULL DEFAULT 'pcs',
      quantity_procured INTEGER NOT NULL DEFAULT 0,
      reorder_threshold INTEGER,
      vendor_name TEXT,
      unit_cost NUMERIC,
      procurement_status TEXT NOT NULL DEFAULT 'planned' CHECK (procurement_status IN ('planned','ordered','received','distributing','completed')),
      responsible_committee_id INTEGER REFERENCES committees(id) ON DELETE SET NULL,
      notes TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS inventory_items_committee_idx ON inventory_items(responsible_committee_id);

    -- One row per recipient who should receive a given item — "who it was
    -- delivered to". assigned_host_member_id is who's SUPPOSED to hand it
    -- over (pre-assigned, e.g. "Bindu will personally deliver this");
    -- delivered_by_host_member_id + delivered_at are stamped with who
    -- ACTUALLY delivered it once marked delivered — may be a stand-in for
    -- whoever was assigned.
    CREATE TABLE IF NOT EXISTS inventory_distributions (
      id SERIAL PRIMARY KEY,
      inventory_item_id INTEGER NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
      recipient_type TEXT NOT NULL CHECK (recipient_type IN ('sponsor','speaker','guest_visitor','participant','host_member')),
      recipient_id INTEGER NOT NULL,
      quantity INTEGER NOT NULL DEFAULT 1,
      assigned_host_member_id INTEGER REFERENCES host_members(id) ON DELETE SET NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','delivered','cancelled')),
      delivered_by_host_member_id INTEGER REFERENCES host_members(id) ON DELETE SET NULL,
      delivered_at TIMESTAMP,
      notes TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(inventory_item_id, recipient_type, recipient_id)
    );
    CREATE INDEX IF NOT EXISTS inventory_distributions_item_idx ON inventory_distributions(inventory_item_id);
    CREATE INDEX IF NOT EXISTS inventory_distributions_recipient_idx ON inventory_distributions(recipient_type, recipient_id);
    CREATE INDEX IF NOT EXISTS inventory_distributions_assigned_idx ON inventory_distributions(assigned_host_member_id);

    -- Web Push subscriptions (PWA push notifications) — one row per
    -- browser/device a logged-in user has "enabled notifications" on. A
    -- person can have more than one (phone + laptop), so this is keyed by
    -- the push endpoint URL itself (unique per browser subscription), not
    -- by user alone. Deleted automatically if the push service reports the
    -- endpoint as gone (see server/pushHelper.js).
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      endpoint TEXT NOT NULL UNIQUE,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      user_agent TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS push_subscriptions_user_idx ON push_subscriptions(user_id);
  `);

  // Safe to run repeatedly — links a 'users' login to a host_members profile
  // once a host member is given their own account.
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS host_member_id INTEGER REFERENCES host_members(id);`);

  // "Other Logins": restricted-scope accounts for people who aren't congress
  // staff — a designer (media), a transport vendor's coordinator
  // (transporter, linked to their partner record), or an individual driver
  // (linked to their own drivers record). Each gets its own tiny self-service
  // portal (media.html/transporter.html/driver.html) that only shows what's
  // relevant to them — see server/routes/driverPortal.js and
  // transporterPortal.js, same self-scoping pattern as host.js.
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS driver_id INTEGER REFERENCES drivers(id) ON DELETE SET NULL;`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS partner_id INTEGER REFERENCES partners(id) ON DELETE SET NULL;`);

  // --- Volunteers: external / non-club-member helpers brought in for data ---
  // entry (e.g. hired temp staff processing delegate registrations), as
  // distinct from 'host_member' (an actual Skål Coimbatore club member who
  // pays the ₹5000 host contribution and sits on committees). A volunteer
  // has none of that — just a name/contact and whichever modules an admin
  // grants them DIRECTLY (no committee membership required, unlike
  // host_member's committee-based committee_module_access). See
  // server/routes/volunteers.js and committeeModuleAccess.js.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS volunteers (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      phone TEXT,
      email TEXT,
      organization TEXT,
      notes TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS volunteer_module_access (
      id SERIAL PRIMARY KEY,
      volunteer_id INTEGER NOT NULL REFERENCES volunteers(id) ON DELETE CASCADE,
      module_key TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE (volunteer_id, module_key)
    );
  `);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS volunteer_id INTEGER REFERENCES volunteers(id) ON DELETE SET NULL;`);

  // Older databases created before 'host_member' (and now 'media'/
  // 'transporter'/'driver'/'volunteer') were added to the CHECK constraint
  // need it relaxed, since Postgres won't alter CHECK constraints in place —
  // drop and recreate.
  await pool.query(`ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;`);
  await pool.query(`ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('super_admin','admin','host_member','media','transporter','driver','volunteer'));`);

  // Older databases created before 'congress_only' was added to reg_type need
  // the CHECK constraint relaxed (Postgres won't alter CHECK constraints in
  // place — drop and recreate, same pattern as users_role_check above).
  await pool.query(`ALTER TABLE registrations DROP CONSTRAINT IF EXISTS registrations_reg_type_check;`);
  await pool.query(`ALTER TABLE registrations ADD CONSTRAINT registrations_reg_type_check CHECK (reg_type IN ('single','double','congress_only'));`);

  // Safe to run repeatedly — adds the column only if an older schema is missing it.
  await pool.query(`ALTER TABLE participants ADD COLUMN IF NOT EXISTS dietary_preference TEXT;`);
  await pool.query(`ALTER TABLE participants ADD COLUMN IF NOT EXISTS departure_point TEXT;`);

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

  // Older databases created before "roles & responsibilities" was added to
  // committees need the column backfilled (Postgres CREATE TABLE IF NOT
  // EXISTS above is a no-op once the table already exists).
  await pool.query(`ALTER TABLE committees ADD COLUMN IF NOT EXISTS description TEXT;`);

  // Guest Relation (host-member liaison) — originally sponsor-only, now also
  // available for speakers and guest visitors. Backfill for databases where
  // these tables were created before this column existed.
  await pool.query(`ALTER TABLE speakers ADD COLUMN IF NOT EXISTS guest_relation_host_member_id INTEGER REFERENCES host_members(id) ON DELETE SET NULL;`);
  await pool.query(`ALTER TABLE guest_visitors ADD COLUMN IF NOT EXISTS guest_relation_host_member_id INTEGER REFERENCES host_members(id) ON DELETE SET NULL;`);

  // Delivery accountability: committee ownership + due dates + completion
  // audit trail on checklist items, and a default committee per template.
  // Backfill for databases where these tables were created before these
  // columns existed.
  await pool.query(`ALTER TABLE checklist_items ADD COLUMN IF NOT EXISTS responsible_committee_id INTEGER REFERENCES committees(id) ON DELETE SET NULL;`);
  await pool.query(`ALTER TABLE checklist_items ADD COLUMN IF NOT EXISTS due_date DATE;`);
  await pool.query(`ALTER TABLE checklist_items ADD COLUMN IF NOT EXISTS completed_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;`);
  await pool.query(`ALTER TABLE checklist_items ADD COLUMN IF NOT EXISTS completed_at TIMESTAMP;`);
  await pool.query(`ALTER TABLE checklist_templates ADD COLUMN IF NOT EXISTS responsible_committee_id INTEGER REFERENCES committees(id) ON DELETE SET NULL;`);
  // Safe now — responsible_committee_id is guaranteed to exist on every
  // database by this point (freshly created with it, or just backfilled above).
  await pool.query(`CREATE INDEX IF NOT EXISTS checklist_items_committee_idx ON checklist_items(responsible_committee_id);`);

  // Sponsor logo + speaker photo, shown on the public homepage. Backfill for
  // databases created before these columns existed. Stored the same way as
  // media.filename (R2 https:// URL, or a relative /uploads/... path).
  await pool.query(`ALTER TABLE sponsors ADD COLUMN IF NOT EXISTS logo_url TEXT;`);
  await pool.query(`ALTER TABLE speakers ADD COLUMN IF NOT EXISTS photo_url TEXT;`);

  // --- Committee leads, individual task delegation, and verification ---
  // A committee has one designated lead (enforced app-side in committees.js —
  // setting a new lead clears the flag on any other member of that committee)
  // who can assign a checklist item to one specific member instead of the
  // whole committee, and who verifies a member's self-marked "done" before it
  // counts as truly accomplished. assigned_to_host_member_id NULL preserves
  // the original broadcast-to-everyone behavior for existing/older tasks.
  await pool.query(`ALTER TABLE committee_members ADD COLUMN IF NOT EXISTS is_lead BOOLEAN NOT NULL DEFAULT false;`);
  await pool.query(`ALTER TABLE committee_tasks ADD COLUMN IF NOT EXISTS assigned_to_host_member_id INTEGER REFERENCES host_members(id) ON DELETE SET NULL;`);
  await pool.query(`ALTER TABLE committee_task_completions ADD COLUMN IF NOT EXISTS verified_at TIMESTAMP;`);
  await pool.query(`ALTER TABLE committee_task_completions ADD COLUMN IF NOT EXISTS verified_by_host_member_id INTEGER REFERENCES host_members(id) ON DELETE SET NULL;`);
  // 'verified' is new (a member marks 'done', the committee lead then
  // verifies it) — Postgres won't alter a CHECK constraint in place, so drop
  // and recreate, same pattern as users_role_check above.
  await pool.query(`ALTER TABLE committee_task_completions DROP CONSTRAINT IF EXISTS committee_task_completions_status_check;`);
  await pool.query(`ALTER TABLE committee_task_completions ADD CONSTRAINT committee_task_completions_status_check CHECK (status IN ('pending','done','verified'));`);

  // --- Per-committee module access grants ---
  // Which admin modules (Sponsors, Vehicles, Hotels, etc.) a committee's own
  // members can manage directly from their host portal, without going
  // through an admin. Granted per committee by an admin (Committees tab);
  // module_key values are validated against MODULE_KEYS in
  // server/routes/committeeModuleAccess.js, not constrained at the DB level
  // so new modules can be added without a migration.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS committee_module_access (
      id SERIAL PRIMARY KEY,
      committee_id INTEGER NOT NULL REFERENCES committees(id) ON DELETE CASCADE,
      module_key TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(committee_id, module_key)
    );
  `);

  // --- A committee's own checklist ---
  // 'committee' is a new valid owner_type — a committee's own shared to-do
  // list (owner_id = the committee itself), separate from checklist items
  // owned by a Sponsor/Speaker/Guest Visitor/Delegate/Host Member that this
  // committee is merely responsible for delivering (responsible_committee_id
  // on those rows, unrelated to this). Postgres won't alter a CHECK
  // constraint in place, so drop and recreate, same pattern as
  // users_role_check above.
  await pool.query(`ALTER TABLE checklist_items DROP CONSTRAINT IF EXISTS checklist_items_owner_type_check;`);
  await pool.query(`ALTER TABLE checklist_items ADD CONSTRAINT checklist_items_owner_type_check CHECK (owner_type IN ('sponsor','speaker','guest_visitor','participant','host_member','committee'));`);

  // --- Arrival/departure trip grouping ---
  // 'general' preserves today's behavior for every existing trip (ad hoc
  // congress transport, pre-tour transport). 'arrival'/'departure' mark
  // trips created from the new "club delegates on the same flight/train"
  // flow (server/routes/transport.js's /arrivals-queue, /departures-queue,
  // /group-trip), so those queues know which delegates are already covered
  // and don't suggest them again.
  await pool.query(`ALTER TABLE transport_trips ADD COLUMN IF NOT EXISTS trip_type TEXT NOT NULL DEFAULT 'general';`);
  await pool.query(`ALTER TABLE transport_trips DROP CONSTRAINT IF EXISTS transport_trips_trip_type_check;`);
  await pool.query(`ALTER TABLE transport_trips ADD CONSTRAINT transport_trips_trip_type_check CHECK (trip_type IN ('arrival','departure','general'));`);

  // One-time seed of the master checklist templates — only runs while the
  // table is still empty, so it never overwrites anything an admin has since
  // added, edited, or deleted from the Checklists & Milestones tab. These
  // are just a sensible starting point per category.
  const templateCount = await pool.query(`SELECT COUNT(*)::int AS n FROM checklist_templates`);
  if (templateCount.rows[0].n === 0) {
    const DEFAULT_TEMPLATES = {
      sponsor: [
        'Sponsor Branding on Main LED Screen', 'Branding in LED at Hall Entrance', 'Branding in Main Arch',
        'Advertisement in Program Booklet', 'Advertisement/Hoardings at Event Evening', 'Banner Inside Dining Area',
        'Banner Near Hall Entrance', 'Bunting on Driveway', 'Certificate with SKAL India Recognition',
        'Advertisement in Newspaper', 'Complimentary Exhibition Stall (6x6 ft)', 'Cinema Hall Advertisement',
        'Standees at Mall', 'Airport Advertisement', 'FM & Radio Promotion', 'Social Media Promotion',
        'YouTube Campaign', 'Instagram Promotion', 'Google/Meta Ads', 'Bus Back Ads', 'Road Show',
        'Auto Advertisement', 'T-Shirt Branding', 'Event Passes Issued', 'Complimentary Room'
      ],
      speaker: [
        'Formal Invitation Letter Sent', 'Travel Tickets Booked', 'Hotel Booking Confirmed', 'Session Briefing Note Shared',
        'Airport Pickup Arranged', 'Green Room Arranged', 'Presentation/AV Received', 'Bio & Photo for Program Booklet',
        'Honorarium/Reimbursement Processed', 'Thank-you Note & Certificate Sent'
      ],
      guest_visitor: [
        'Invitation Sent', 'Welcome Kit Prepared', 'Reserved Seating Arranged', 'Photo-op Arranged',
        'Escort/Host Assigned', 'Memento/Certificate Prepared'
      ],
      participant: ['Congress Kit / Delegate Bag', 'ID Badge', 'Souvenir', 'Welcome Letter', 'Gala Dinner Pass'],
      host_member: ['Host Committee T-Shirt/Uniform', 'ID Badge', 'Souvenir', 'Volunteer Kit']
    };
    for (const [ownerType, labels] of Object.entries(DEFAULT_TEMPLATES)) {
      for (let i = 0; i < labels.length; i++) {
        await pool.query(
          `INSERT INTO checklist_templates (owner_type, category, label, sort_order) VALUES ($1,'',$2,$3)`,
          [ownerType, labels[i], i]
        );
      }
    }
    console.log('Seeded default master checklist templates (Sponsors, Speakers, Guest Visitors, Delegates, Host Members).');
  }

  // --- Transport pickup/drop points ---
  // A small, shared master list of common pickup/drop locations (Airport,
  // Railway Station, Bus Stand, plus anything an admin/committee types into
  // a delegate's arrival point or a trip's From/To) — offered as autocomplete
  // suggestions everywhere a location is typed (server/routes/transportPoints.js),
  // instead of everyone retyping "Coimbatore Airport" from scratch every
  // time. Case-insensitive uniqueness so "Coimbatore Airport" and
  // "coimbatore airport" don't end up as two separate suggestions.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS transport_points (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS transport_points_name_lower_idx ON transport_points (LOWER(name));`);

  const pointCount = await pool.query(`SELECT COUNT(*)::int AS n FROM transport_points`);
  if (pointCount.rows[0].n === 0) {
    const DEFAULT_POINTS = ['Coimbatore Airport', 'Coimbatore Railway Station', 'Coimbatore Bus Stand'];
    for (const name of DEFAULT_POINTS) {
      await pool.query(`INSERT INTO transport_points (name) VALUES ($1) ON CONFLICT (LOWER(name)) DO NOTHING`, [name]);
    }
    console.log('Seeded default transport pickup/drop points (Airport, Railway Station, Bus Stand).');
  }

  // --- Communications: one-way announcements with optional per-recipient ---
  // action tracking. target_type says how recipients were chosen (kept for
  // display/audit on the sent-history list); message_recipients is the
  // resolved, concrete list actually used for delivery + the self-service
  // inbox, so a later membership change (e.g. someone leaving a committee)
  // never rewrites who already received a past message.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      sender_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      target_type TEXT NOT NULL CHECK (target_type IN ('role','committee','individual')),
      target_roles TEXT[],
      target_committee_id INTEGER REFERENCES committees(id) ON DELETE SET NULL,
      action_label TEXT,
      action_due_date DATE,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
  // Per-recipient row: drives the inbox, read tracking, and (if the message
  // carried an action_label) per-person completion of that action. Separate
  // from checklist_items — this covers every role (drivers/transporters/
  // volunteers/media have no checklist_items owner_type), while host_member
  // recipients ALSO get a mirrored checklist_items row so the action shows
  // up in the checklist tab they already use daily (see messages.js).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS message_recipients (
      id SERIAL PRIMARY KEY,
      message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      read_at TIMESTAMP,
      action_done_at TIMESTAMP,
      mirrored_checklist_item_id INTEGER REFERENCES checklist_items(id) ON DELETE SET NULL,
      UNIQUE(message_id, user_id)
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS message_recipients_user_idx ON message_recipients(user_id);`);

  // --- Activity log: a system-wide audit trail. Every login and every ---
  // create/update/delete across every module writes one row here, so a
  // super admin can answer "who did what, when" as the user base grows.
  // user_id is nullable + ON DELETE SET NULL so a deleted account's history
  // survives (username/role are captured as plain text at write time too,
  // so the trail still reads sensibly even after the user_id link is gone).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS activity_log (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      username TEXT,
      role TEXT,
      action TEXT NOT NULL,
      entity_type TEXT,
      entity_id INTEGER,
      label TEXT,
      details TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS activity_log_created_idx ON activity_log(created_at DESC);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS activity_log_user_idx ON activity_log(user_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS activity_log_entity_idx ON activity_log(entity_type);`);
}

module.exports = { pool, all, get, run, transaction, initSchema };
