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

    -- A "requirement" is a need raised for something to be procured — either
    -- typed in manually (any goodie/inventory item) or auto-generated from
    -- the Delegate/Host Member shirt & T-shirt size totals (the Merchandise
    -- Requirement sync). The Purchase team reviews open requirements and, when
    -- ready, raises an actual Purchase Request from one, which links back via
    -- purchase_request_id and flows through the normal Finance approval
    -- process. purchase_request_id's REFERENCES finance_transactions is added
    -- later via ALTER TABLE once that table exists further down this file.
    CREATE TABLE IF NOT EXISTS inventory_requirements (
      id SERIAL PRIMARY KEY,
      item_name TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'General',
      size TEXT,
      quantity_needed INTEGER NOT NULL DEFAULT 0,
      unit TEXT NOT NULL DEFAULT 'pcs',
      source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','auto-merchandise')),
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','requested','fulfilled','cancelled')),
      notes TEXT,
      raised_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS inventory_requirements_status_idx ON inventory_requirements(status);
    -- One auto-generated row per (category, size) pair, so re-syncing
    -- merchandise totals updates the existing row instead of piling up
    -- duplicates every time the counts change.
    CREATE UNIQUE INDEX IF NOT EXISTS inventory_requirements_automerch_uidx
      ON inventory_requirements(category, size) WHERE source = 'auto-merchandise';

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
  // NOTE: intermediate migrations below re-narrow this same constraint as
  // each role was added historically. That's fine on a fresh database, but
  // on THIS already-running database rows with 'stall_owner'/'scanner' roles
  // already exist (added by later migrations further down this file) — so
  // every one of these intermediate DROP+ADD steps must already include the
  // FULL current role list, or Postgres refuses to add the narrower
  // constraint against existing rows and initSchema() throws, crashing
  // startup. Keep every occurrence of this constraint in sync with the final
  // one at the bottom of this file.
  await pool.query(`ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;`);
  await pool.query(`ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('super_admin','admin','host_member','media','transporter','driver','volunteer','vendor','stall_owner','scanner'));`);

  // Older databases created before 'congress_only' was added to reg_type need
  // the CHECK constraint relaxed (Postgres won't alter CHECK constraints in
  // place — drop and recreate, same pattern as users_role_check above).
  await pool.query(`ALTER TABLE registrations DROP CONSTRAINT IF EXISTS registrations_reg_type_check;`);
  // 'double' is kept in the allowed set alongside the two new bed-type
  // variants so existing double registrations stay valid — adding a stricter
  // CHECK validates every existing row and would crash the migration (and app
  // boot) if any violated it. Both double_king and double_twin count as two
  // delegates: see isDoubleOccupancy() in server/lib/regType.js, which every
  // capacity check and headcount goes through.
  await pool.query(`ALTER TABLE registrations ADD CONSTRAINT registrations_reg_type_check CHECK (reg_type IN ('single','double','double_king','double_twin','congress_only'));`);

  // Safe to run repeatedly — adds the column only if an older schema is missing it.
  await pool.query(`ALTER TABLE participants ADD COLUMN IF NOT EXISTS dietary_preference TEXT;`);
  await pool.query(`ALTER TABLE participants ADD COLUMN IF NOT EXISTS departure_point TEXT;`);
  // Drink preference (comma-separated e.g. "Wine, Beer" or "No Alcohol") and
  // free-text special requests — collected from the Delegate self-fill page
  // (my-travel.html) and mirrored into the admin Delegates form. Pre-tour
  // interest deliberately isn't a column here — it reuses the existing
  // pre_tour_participants join table (see server/routes/pretours.js) so a
  // self-registered signup shows up in the same "who's signed up for this
  // tour" admin view as one entered manually.
  await pool.query(`ALTER TABLE participants ADD COLUMN IF NOT EXISTS drink_preference TEXT;`);
  await pool.query(`ALTER TABLE participants ADD COLUMN IF NOT EXISTS special_requests TEXT;`);
  // Which industry/business a delegate is in — Skål International is a
  // tourism-industry membership org, so this classifies the delegate's own
  // professional background (Hotelier, Travel Business, Vendor, Institution,
  // Others). Same self-fill/admin-parity treatment as the fields above.
  await pool.query(`ALTER TABLE participants ADD COLUMN IF NOT EXISTS business_profile TEXT;`);

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

  // Sponsorship payment tracking — sponsorship RATES are still deliberately
  // not modeled anywhere (see the sponsors table comment above), but once a
  // tier/amount has actually been agreed and received, an admin can record it
  // here so it shows up in the Finance module's Inward Ledger (with its own
  // downloadable receipt) the same way registrations/host-member fees/stall
  // bookings/pre-tour payments already do.
  await pool.query(`ALTER TABLE sponsors ADD COLUMN IF NOT EXISTS payment_status TEXT NOT NULL DEFAULT 'pending' CHECK (payment_status IN ('pending','paid'));`);
  await pool.query(`ALTER TABLE sponsors ADD COLUMN IF NOT EXISTS payment_amount NUMERIC;`);
  await pool.query(`ALTER TABLE sponsors ADD COLUMN IF NOT EXISTS payment_mode TEXT;`);
  await pool.query(`ALTER TABLE sponsors ADD COLUMN IF NOT EXISTS payment_date DATE;`);

  // --- Congress-wide member data collection: Shirt Size, T-Shirt Size, a
  // photo of the person, and a photo/scan of their business card. Requested
  // for every delegate, host member, and volunteer so goodies/kits can be
  // sized correctly and each person's profile can show a face + business
  // card on file. Two distinct size fields on purpose — Shirt Size (formal)
  // and T-Shirt Size (event tee) are not always the same for a given person.
  // Stored the same way as sponsor logo_url/speaker photo_url (R2 https://
  // URL, or a relative /uploads/... path) via uploadHelper.saveFile.
  await pool.query(`ALTER TABLE participants ADD COLUMN IF NOT EXISTS shirt_size TEXT;`);
  await pool.query(`ALTER TABLE participants ADD COLUMN IF NOT EXISTS tshirt_size TEXT;`);
  await pool.query(`ALTER TABLE participants ADD COLUMN IF NOT EXISTS waist_size TEXT;`);
  await pool.query(`ALTER TABLE participants ADD COLUMN IF NOT EXISTS photo_url TEXT;`);
  await pool.query(`ALTER TABLE participants ADD COLUMN IF NOT EXISTS business_card_url TEXT;`);
  // Aadhaar (Government of India ID) collection for Delegates only, added
  // for on-site identity verification at the registration desk. Aadhaar is
  // sensitive government-ID data (regulated under India's Aadhaar Act) —
  // aadhaar_number/aadhaar_url are stripped out of the admin GET /participants
  // response server-side for anyone who isn't super_admin (see participants.js),
  // not just hidden in the UI, and the upload/remove/view endpoints for it are
  // super_admin-gated the same way. Stored the same way as photo_url/
  // business_card_url (R2 URL or /uploads/... path) via uploadHelper.saveFile.
  await pool.query(`ALTER TABLE participants ADD COLUMN IF NOT EXISTS aadhaar_number TEXT;`);
  await pool.query(`ALTER TABLE participants ADD COLUMN IF NOT EXISTS aadhaar_url TEXT;`);
  // Passport is the alternative identity document for international Delegates
  // who don't hold an Aadhaar — a Delegate only ever needs to provide ONE of
  // Aadhaar or Passport (see publicProfile.js's PUT /participant/:id/travel,
  // which requires at least one complete pair). Same sensitivity/access model
  // as Aadhaar: passport_number/passport_url are stripped from the admin GET
  // response for anyone who isn't super_admin, and its upload/remove
  // endpoints are super_admin-gated the same way.
  await pool.query(`ALTER TABLE participants ADD COLUMN IF NOT EXISTS passport_number TEXT;`);
  await pool.query(`ALTER TABLE participants ADD COLUMN IF NOT EXISTS passport_url TEXT;`);
  await pool.query(`ALTER TABLE host_members ADD COLUMN IF NOT EXISTS shirt_size TEXT;`);
  await pool.query(`ALTER TABLE host_members ADD COLUMN IF NOT EXISTS tshirt_size TEXT;`);
  await pool.query(`ALTER TABLE host_members ADD COLUMN IF NOT EXISTS waist_size TEXT;`);
  await pool.query(`ALTER TABLE host_members ADD COLUMN IF NOT EXISTS photo_url TEXT;`);
  await pool.query(`ALTER TABLE host_members ADD COLUMN IF NOT EXISTS business_card_url TEXT;`);

  // --- Sex (M/F) for Delegates and Host Members ---------------------------
  // Needed for rooming (twin-sharing allocation is gender-segregated) and for
  // headcount reporting. Deliberately NULLable: "we don't know yet" is a real
  // and common state, and is very different from a guess. The admin UI shows
  // NULL as "Not set" and offers a filter for exactly those rows, so the
  // office can work through them deliberately.
  await pool.query(`ALTER TABLE participants ADD COLUMN IF NOT EXISTS sex TEXT;`);
  await pool.query(`ALTER TABLE host_members ADD COLUMN IF NOT EXISTS sex TEXT;`);
  // Constraint added separately from the column so re-running against a table
  // that already has the column (but not the constraint) still gets it.
  for (const tbl of ['participants', 'host_members']) {
    await pool.query(`
      DO $$ BEGIN
        ALTER TABLE ${tbl} ADD CONSTRAINT ${tbl}_sex_chk CHECK (sex IN ('M','F') OR sex IS NULL);
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);
  }
  // One-time backfill from the honorific already carried in the name, e.g.
  // "Mrs Aruna Anand" -> F. Only unambiguous titles are used: "Dr", "Sk" and
  // bare names are left NULL rather than guessed, because a wrong value here
  // would silently propagate into rooming lists and badge counts. Guarded by
  // "sex IS NULL" so it never overwrites a value an admin has since set by
  // hand, and so re-running the migration on restart is a no-op.
  for (const tbl of ['participants', 'host_members']) {
    await pool.query(`
      UPDATE ${tbl} SET sex = 'M'
      WHERE sex IS NULL AND name ~* '^\\s*(mr|shri|sri)\\.?\\s+'
    `);
    await pool.query(`
      UPDATE ${tbl} SET sex = 'F'
      WHERE sex IS NULL AND name ~* '^\\s*(mrs|ms|miss|smt)\\.?\\s+'
    `);
  }
  await pool.query(`ALTER TABLE volunteers ADD COLUMN IF NOT EXISTS shirt_size TEXT;`);
  await pool.query(`ALTER TABLE volunteers ADD COLUMN IF NOT EXISTS tshirt_size TEXT;`);
  await pool.query(`ALTER TABLE volunteers ADD COLUMN IF NOT EXISTS waist_size TEXT;`);
  await pool.query(`ALTER TABLE volunteers ADD COLUMN IF NOT EXISTS photo_url TEXT;`);
  await pool.query(`ALTER TABLE volunteers ADD COLUMN IF NOT EXISTS business_card_url TEXT;`);

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

  // Lets a trip name which transport partner (vendor company) supplied the
  // vehicle/driver, in addition to the specific vehicle_id/driver_id already
  // on the row. Vehicles and Drivers already link to a partner individually,
  // but a committee planning a trip via the self-service portal wants to
  // pick the vendor up front too, so this is tracked directly on the trip.
  await pool.query(`ALTER TABLE transport_trips ADD COLUMN IF NOT EXISTS partner_id INTEGER REFERENCES partners(id) ON DELETE SET NULL;`);

  // Media library gains a third type: uploadable Print materials & more
  // (PDFs, brochures, itinerary sheets, etc.) alongside the existing
  // video/poster loop content — same storage/CRUD machinery, just a new
  // allowed value on the type CHECK.
  await pool.query(`ALTER TABLE media DROP CONSTRAINT IF EXISTS media_type_check;`);
  await pool.query(`ALTER TABLE media ADD CONSTRAINT media_type_check CHECK (type IN ('video','poster','document'));`);

  // Pre Tours are Full Board tours that can span multiple hotels across
  // their duration, and — per the host committee's ask — the hotel a group
  // sleeps at on a given day isn't always the hotel that serves their meals
  // that day. This table tracks that day-by-day, decoupled from
  // pre_tour_itinerary (which stays a free-form activity agenda) so a tour
  // can have activities without a hotel plan yet, or vice versa.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pre_tour_days (
      id SERIAL PRIMARY KEY,
      pre_tour_id INTEGER NOT NULL REFERENCES pre_tours(id) ON DELETE CASCADE,
      day_date DATE,
      day_label TEXT NOT NULL,
      stay_hotel_id INTEGER REFERENCES hotels(id) ON DELETE SET NULL,
      meal_hotel_id INTEGER REFERENCES hotels(id) ON DELETE SET NULL,
      notes TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  // A Full Board day isn't just one "meal hotel" — there are 3 meals
  // (breakfast/lunch/dinner) plus 2 hi-teas, and each of those 5 sittings can
  // be hosted at a different hotel than where the group is sleeping (or than
  // each other). These replace the old single meal_hotel_id concept for new
  // hotel-plan entries; meal_hotel_id is left in place, unused, rather than
  // dropped, so no data is destroyed.
  await pool.query(`ALTER TABLE pre_tour_days ADD COLUMN IF NOT EXISTS breakfast_hotel_id INTEGER REFERENCES hotels(id) ON DELETE SET NULL;`);
  await pool.query(`ALTER TABLE pre_tour_days ADD COLUMN IF NOT EXISTS hitea1_hotel_id INTEGER REFERENCES hotels(id) ON DELETE SET NULL;`);
  await pool.query(`ALTER TABLE pre_tour_days ADD COLUMN IF NOT EXISTS lunch_hotel_id INTEGER REFERENCES hotels(id) ON DELETE SET NULL;`);
  await pool.query(`ALTER TABLE pre_tour_days ADD COLUMN IF NOT EXISTS hitea2_hotel_id INTEGER REFERENCES hotels(id) ON DELETE SET NULL;`);
  await pool.query(`ALTER TABLE pre_tour_days ADD COLUMN IF NOT EXISTS dinner_hotel_id INTEGER REFERENCES hotels(id) ON DELETE SET NULL;`);

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

  // --- Leadership Briefing: office-bearers (President, Secretary, VPs,
  // Congress Chairman/Secretary, Treasurer, Congress Joint Secretary,
  // Congress Sponsor Chairman) are ordinary host_members, just tagged with
  // a leadership_role. NULL means "not a leadership login" — a host_member
  // with this set sees the extra read-only Leadership Briefing tab in the
  // self-service portal (see server/routes/host.js's requireLeadershipHostMember).
  // Free text (not an enum) so admins can add a new office later without a
  // migration; the admin UI dropdown is the source of truth for the standard list.
  await pool.query(`ALTER TABLE host_members ADD COLUMN IF NOT EXISTS leadership_role TEXT;`);

  // --- Delegate company ---
  // host_members has had a `company` column since the table was created;
  // participants never did, because the original registration-form import
  // dumped everything it couldn't map into one `notes` string of the form
  // "Company: X | Job Title: Y | City: Z | Country: IN | ...". That left the
  // company unsortable, unfilterable and unavailable to the badge and the
  // delegate directory. server/scripts/backfill-delegate-company.js lifts it
  // out of notes into this column; `notes` is deliberately left untouched so
  // the original import record survives and the backfill stays re-runnable.
  await pool.query(`ALTER TABLE participants ADD COLUMN IF NOT EXISTS company TEXT;`);

  // --- Spouse dinner attendance + goodies offer (host members only) ---
  // The congress dinners on 12, 13 and 14 August are open to a host member's
  // spouse; children are not admitted at all. Each night is a separate
  // boolean rather than one "brings spouse" flag because catering needs a
  // headcount per night — a spouse joining only the gala on the 13th must not
  // inflate the count for the other two.
  //
  // The dates are columns rather than rows in a join table on purpose: there
  // are exactly three, fixed by the programme, and flat columns keep them in
  // the existing host-member SELECT, the field-picker export and the admin
  // table without a join. If a fourth dinner is ever added this should become
  // host_member_dinners(host_member_id, dinner_date) instead of a fourth column.
  await pool.query(`ALTER TABLE host_members ADD COLUMN IF NOT EXISTS spouse_name TEXT;`);
  await pool.query(`ALTER TABLE host_members ADD COLUMN IF NOT EXISTS spouse_dinner_aug12 BOOLEAN NOT NULL DEFAULT FALSE;`);
  await pool.query(`ALTER TABLE host_members ADD COLUMN IF NOT EXISTS spouse_dinner_aug13 BOOLEAN NOT NULL DEFAULT FALSE;`);
  await pool.query(`ALTER TABLE host_members ADD COLUMN IF NOT EXISTS spouse_dinner_aug14 BOOLEAN NOT NULL DEFAULT FALSE;`);
  // "Would you like to give away goodies to all participants?" — a yes/no plus
  // free text. Deliberately not tied to the Goodies & Inventory module yet:
  // at this stage we're gauging willingness, and forcing a firm item/quantity
  // up front would depress the response rate. The office follows up with
  // whoever says yes and enters the actual stock through Inventory.
  await pool.query(`ALTER TABLE host_members ADD COLUMN IF NOT EXISTS goodies_offer BOOLEAN NOT NULL DEFAULT FALSE;`);
  await pool.query(`ALTER TABLE host_members ADD COLUMN IF NOT EXISTS goodies_details TEXT;`);

  // --- Stalls module: exhibition stall enquiry -> billing -> allocation ---
  // Separate from Sponsors (a stall is a paid physical spot, not a
  // sponsorship tier). The hall count/layout isn't finalized yet, so halls
  // and stalls are both simple admin-managed masters: create a Hall, then
  // bulk-generate its stall numbers (or add them one at a time) once the
  // venue plan firms up — never hardcoded. A stall's price can vary per
  // stall (corner vs. regular, hall-to-hall), so price lives on the stall
  // row itself rather than as one global constant.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS stall_halls (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      capacity INTEGER,
      notes TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  // A single physical stall inside a hall. status is a simple derived flag
  // ('available' | 'allocated') kept in sync by stall_bookings.js whenever a
  // booking is allocated/released/cancelled — so the Halls & Stalls tab can
  // show availability at a glance without joining through bookings.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS stalls (
      id SERIAL PRIMARY KEY,
      hall_id INTEGER NOT NULL REFERENCES stall_halls(id) ON DELETE CASCADE,
      stall_number TEXT NOT NULL,
      size TEXT,
      price NUMERIC NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available','allocated')),
      notes TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(hall_id, stall_number)
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS stalls_hall_idx ON stalls(hall_id);`);

  // The enquiry -> billed -> allocated workflow itself. One stall per
  // booking (a company wanting several stalls submits several enquiries).
  // The buyer is always an outside exhibitor/vendor company — not
  // necessarily a Skål club or host member — so contact details are
  // captured directly here rather than linked to host_members.
  // stall_id is only set once a hall/stall has actually been allocated;
  // it stays on the row even if later cancelled, so "who had this stall"
  // remains visible in history — the partial unique index below is what
  // actually frees the stall back up for a new booking.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS stall_bookings (
      id SERIAL PRIMARY KEY,
      company_name TEXT NOT NULL,
      contact_person TEXT,
      phone TEXT,
      email TEXT,
      gstin TEXT,
      requirement_notes TEXT,
      stall_id INTEGER REFERENCES stalls(id) ON DELETE SET NULL,
      status TEXT NOT NULL DEFAULT 'enquiry' CHECK (status IN ('enquiry','billed','allocated','cancelled')),
      amount NUMERIC NOT NULL DEFAULT 0,
      payment_status TEXT NOT NULL DEFAULT 'pending' CHECK (payment_status IN ('pending','paid')),
      payment_mode TEXT,
      payment_date DATE,
      notes TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);
  // A stall can only be the live (non-cancelled) allocation for ONE
  // booking at a time — this is the actual guarantee against double-booking
  // a stall, enforced at the DB level in addition to the app-level check in
  // stallBookings.js. Cancelled bookings are excluded so the same stall can
  // be re-allocated to someone else afterwards.
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS stall_bookings_active_stall_idx
    ON stall_bookings(stall_id) WHERE stall_id IS NOT NULL AND status <> 'cancelled';
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS stall_bookings_stall_idx ON stall_bookings(stall_id);`);

  // --- Agenda (event management within the Itinerary module) ---
  // A congress itinerary slot (e.g. "Inaugural Ceremony", 7:00 PM) is a
  // container in the public-facing itinerary_items table above. Within that
  // slot there's a detailed run-of-show — the actual flow of individual
  // events (Prayer Song, National Anthem, dance performances, etc.) needed
  // so agenda prep goes flawlessly. Kept admin-only for now (not surfaced on
  // the public site), one level below itinerary_items.
  //
  // performer_groups must exist before agenda_events references it.
  // Hired performing groups/vendors for the program, tracked with a simple
  // pending/paid fee — same payment shape as host_members' contribution,
  // not the partial-payment shape used for delegate registrations.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS performer_groups (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT,
      contact_person TEXT,
      phone TEXT,
      email TEXT,
      fee_amount NUMERIC NOT NULL DEFAULT 0,
      payment_status TEXT NOT NULL DEFAULT 'pending' CHECK (payment_status IN ('pending','paid')),
      payment_mode TEXT,
      payment_date DATE,
      notes TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);

  // One row per event within an itinerary slot's agenda. organizing_committee_id
  // reuses the same "responsible committee" pattern as checklist_items/
  // inventory_items (with organized_by as a free-text supplement/fallback for
  // organizers that aren't a host committee); performer_group_id links to a
  // hired group above (with performed_by as a free-text fallback for
  // individual/ad hoc performers not represented by a formal group).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS agenda_events (
      id SERIAL PRIMARY KEY,
      itinerary_item_id INTEGER NOT NULL REFERENCES itinerary_items(id) ON DELETE CASCADE,
      time_label TEXT,
      title TEXT NOT NULL,
      description TEXT,
      organizing_committee_id INTEGER REFERENCES committees(id) ON DELETE SET NULL,
      organized_by TEXT,
      performer_group_id INTEGER REFERENCES performer_groups(id) ON DELETE SET NULL,
      performed_by TEXT,
      duration_minutes INTEGER,
      sort_order INTEGER NOT NULL DEFAULT 0,
      notes TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS agenda_events_itinerary_idx ON agenda_events(itinerary_item_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS agenda_events_committee_idx ON agenda_events(organizing_committee_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS agenda_events_performer_idx ON agenda_events(performer_group_id);`);

  // --- Finance module: inward/outward money tracking + payment approvals ---
  // A single table covers three kinds of rows via type/subtype:
  //   type='inward'  (subtype NULL)     -> a manual inward entry (donation,
  //                                        grant, etc. not already captured
  //                                        by another module's own payment
  //                                        fields). Status is always 'recorded'.
  //   type='outward', subtype='payment' -> a vendor/expense payment request.
  //                                        Needs unanimous approval from ALL
  //                                        FIVE office-bearers (President,
  //                                        Secretary, Treasurer, Congress
  //                                        Chairman, Congress Treasurer)
  //                                        before it can be marked paid.
  //   type='outward', subtype='purchase'-> a purchase request for a goodies/
  //                                        inventory item. Needs approval
  //                                        from just President + Treasurer
  //                                        (lighter than a plain payment).
  //                                        The moment BOTH approve, the
  //                                        matching inventory_items row is
  //                                        created/incremented automatically
  //                                        (see server/lib/financeHelper.js) —
  //                                        this is deliberately the ONLY path
  //                                        that auto-populates inventory from
  //                                        a real procurement decision; the
  //                                        existing Goodies & Inventory tab's
  //                                        manual add is left in place for
  //                                        already-owned stock / corrections.
  // The big "inward" picture (what money has actually come in) also includes
  // payments already recorded by other modules — registrations, host member
  // fees, stall bookings, pre-tour payments — which is why finance_inward_ledger
  // below UNIONs those in read-only rather than duplicating the data here.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS finance_transactions (
      id SERIAL PRIMARY KEY,
      type TEXT NOT NULL CHECK (type IN ('inward','outward')),
      subtype TEXT CHECK (subtype IS NULL OR subtype IN ('payment','purchase')),
      category TEXT,
      payee_or_payer TEXT,
      amount NUMERIC NOT NULL DEFAULT 0,
      description TEXT,
      transaction_date DATE,
      payment_mode TEXT,
      status TEXT NOT NULL DEFAULT 'recorded',
      purchase_item_name TEXT,
      purchase_category TEXT,
      purchase_unit TEXT,
      purchase_quantity NUMERIC,
      purchase_unit_cost NUMERIC,
      inventory_item_id INTEGER REFERENCES inventory_items(id) ON DELETE SET NULL,
      notes TEXT,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS finance_transactions_type_idx ON finance_transactions(type);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS finance_transactions_subtype_idx ON finance_transactions(subtype);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS finance_transactions_status_idx ON finance_transactions(status);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS finance_transactions_inventory_idx ON finance_transactions(inventory_item_id);`);

  // Deferred FK: inventory_requirements is created earlier in this file
  // (before finance_transactions exists), so the link back to whichever
  // Purchase Request was raised from a requirement is added here instead.
  await pool.query(`ALTER TABLE inventory_requirements ADD COLUMN IF NOT EXISTS purchase_request_id INTEGER REFERENCES finance_transactions(id) ON DELETE SET NULL;`);
  await pool.query(`CREATE INDEX IF NOT EXISTS inventory_requirements_pr_idx ON inventory_requirements(purchase_request_id);`);

  // One row per required approver ROLE (not person) on an outward
  // transaction — e.g. a 'payment' gets 5 rows (one per office-bearer role),
  // a 'purchase' gets 2 (President, Treasurer). Whichever host_member
  // currently holds that leadership_role can act on it. UNIQUE(transaction,role)
  // means re-tagging a role to a different person mid-flight doesn't duplicate
  // the pending approval slot.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS finance_transaction_approvals (
      id SERIAL PRIMARY KEY,
      transaction_id INTEGER NOT NULL REFERENCES finance_transactions(id) ON DELETE CASCADE,
      required_role TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
      approved_by_host_member_id INTEGER REFERENCES host_members(id) ON DELETE SET NULL,
      decided_at TIMESTAMP,
      remarks TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(transaction_id, required_role)
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS finance_approvals_transaction_idx ON finance_transaction_approvals(transaction_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS finance_approvals_role_idx ON finance_transaction_approvals(required_role);`);

  // Read-only consolidated view of every inward rupee across the congress:
  // manual Finance entries UNIONed with payments already recorded by other
  // modules (so this module doesn't need its own duplicate copy of that
  // --- Vendor Management: the master list of outside suppliers (kit/goodies
  // printers, caterers, decor, stationery, etc.) that Purchase Requests
  // (finance_transactions subtype='purchase') and Inventory Items both
  // procure from. A vendor can also get their own portal login (see
  // users.vendor_id + server/routes/vendorPortal.js below) to maintain their
  // own product catalog (vendor_products, with a photo) and update the
  // delivery status of their own orders — without seeing anything else in
  // the system.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS vendors (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT DEFAULT '',
      contact_person TEXT,
      phone TEXT,
      email TEXT,
      address TEXT,
      gst_number TEXT,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
      notes TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);

  // A vendor's own catalog of what they supply — maintained by the vendor
  // themselves from their portal login (or by an admin on their behalf).
  // photo_url lets a vendor snap/upload a picture of the product.
  // processing_time_days is how long the vendor typically needs to fulfil an
  // order for this item once placed — shown alongside price/unit so the
  // congress team can plan expected delivery dates when raising a Purchase
  // Request for it.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS vendor_products (
      id SERIAL PRIMARY KEY,
      vendor_id INTEGER NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      category TEXT DEFAULT '',
      unit TEXT DEFAULT 'pcs',
      unit_price NUMERIC,
      processing_time_days INTEGER,
      description TEXT,
      photo_url TEXT,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);
  await pool.query(`ALTER TABLE vendor_products ADD COLUMN IF NOT EXISTS processing_time_days INTEGER;`);
  await pool.query(`CREATE INDEX IF NOT EXISTS vendor_products_vendor_idx ON vendor_products(vendor_id);`);

  // Link a Purchase Request to the vendor it was ordered from, and track its
  // order/delivery schedule separately from the payment-approval status
  // already on this table (status='pending_approval'/'approved'/'paid' is
  // about MONEY moving; delivery_status here is about the GOODS arriving —
  // the two lifecycles run independently, e.g. a purchase can be delivered
  // before it's been paid, or paid while still in transit).
  await pool.query(`ALTER TABLE finance_transactions ADD COLUMN IF NOT EXISTS vendor_id INTEGER REFERENCES vendors(id) ON DELETE SET NULL;`);
  await pool.query(`ALTER TABLE finance_transactions ADD COLUMN IF NOT EXISTS expected_delivery_date DATE;`);
  await pool.query(`ALTER TABLE finance_transactions ADD COLUMN IF NOT EXISTS actual_delivery_date DATE;`);
  await pool.query(`ALTER TABLE finance_transactions ADD COLUMN IF NOT EXISTS delivery_status TEXT NOT NULL DEFAULT 'ordered' CHECK (delivery_status IN ('ordered','in_transit','delivered','delayed','cancelled'));`);
  await pool.query(`CREATE INDEX IF NOT EXISTS finance_transactions_vendor_idx ON finance_transactions(vendor_id);`);

  // The actual bill/invoice file the vendor or payee gave us for this outward
  // payment or purchase — distinct from the system-generated Payment/
  // Purchase Voucher PDF (which is only an internal record of the
  // disbursement, not evidence of what was billed). Stored the same way as
  // every other upload in this app (R2 URL or local /uploads/... path) via
  // uploadHelper.saveFile, and can be a photo or a PDF scan.
  await pool.query(`ALTER TABLE finance_transactions ADD COLUMN IF NOT EXISTS bill_url TEXT;`);

  // Same linkage + delivery tracking on Inventory Items (the other place
  // goods get procured from a vendor — see server/routes/inventory.js).
  // procurement_status already covers the item's own planned->ordered->
  // received->distributing->completed lifecycle; 'delayed' is added here so
  // it lines up with the purchase-request delivery_status options above.
  await pool.query(`ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS vendor_id INTEGER REFERENCES vendors(id) ON DELETE SET NULL;`);
  await pool.query(`ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS expected_delivery_date DATE;`);
  await pool.query(`ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS actual_delivery_date DATE;`);
  await pool.query(`ALTER TABLE inventory_items DROP CONSTRAINT IF EXISTS inventory_items_procurement_status_check;`);
  await pool.query(`ALTER TABLE inventory_items ADD CONSTRAINT inventory_items_procurement_status_check CHECK (procurement_status IN ('planned','ordered','received','distributing','completed','delayed'));`);
  await pool.query(`CREATE INDEX IF NOT EXISTS inventory_items_vendor_idx ON inventory_items(vendor_id);`);

  // --- Vendor portal login: same pattern as host_member_id/driver_id/
  // partner_id/volunteer_id in users (see server/routes/auth.js's
  // LINKED_ROLE_FIELDS + ALL_ROLES) — 'vendor' just adds one more linked
  // role, scoped to a single vendors row via requireVendorRole in
  // vendorPortal.js (same self-scoping pattern as transporterPortal.js).
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS vendor_id INTEGER REFERENCES vendors(id) ON DELETE SET NULL;`);
  // See the "intermediate migrations" note near the first users_role_check
  // ALTER above — kept in sync with the full current role list for the same
  // reason (existing 'stall_owner'/'scanner' rows must not be rejected here).
  await pool.query(`ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;`);
  await pool.query(`ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('super_admin','admin','host_member','media','transporter','driver','volunteer','vendor','stall_owner','scanner'));`);

  // --- QR badge multi-point scanning ---
  // Every gate/desk that scans a delegate/host-member's QR badge (hotel desk,
  // transport boarding, food counter, an exhibitor's stall, goods delivery)
  // needs to know two things about the person doing the scanning: (1) which
  // duty they're covering, and (2) — for the "correct vehicle?" transport
  // check specifically — which vehicle they themselves are stationed at
  // today. Neither fits the existing per-role linked-record columns
  // (host_member_id/driver_id/partner_id/...) because the SAME login (e.g. a
  // host member or volunteer) might be handed hotel-desk duty one day and
  // food-counter duty the next, and a driver/transporter's vehicle for
  // scanning purposes is a day-to-day assignment, not a fixed attribute of
  // their profile. So both live directly on `users`, settable independently
  // of role from the admin panel's Generate Login / Change Role forms.
  //   scan_point: an ADDITIONAL duty grant on top of whatever the login's
  //     role already implies (admin/super_admin implicitly get every scan
  //     point; driver/transporter implicitly get 'transport' via vehicle_id
  //     below) — lets any host_member/volunteer login be deputised for a
  //     specific gate without changing their base role.
  //   vehicle_id: which vehicle this login is scanning boarding passengers
  //     for today (used by the transport-scan endpoint in badge.js to flag
  //     "wrong vehicle" if the vehicle the entity is actually booked on
  //     differs from this one).
  //   stall_id: which stall_bookings row a 'stall_owner' login represents —
  //     see ALL_ROLES/LINKED_ROLE_FIELDS in server/routes/auth.js.
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS scan_point TEXT;`);
  // Kept in sync with the full scan_point list (including 'registration',
  // added by a later migration further down this file) for the same reason
  // as users_role_check above — existing 'registration'-scan_point rows must
  // not be rejected by this intermediate step.
  await pool.query(`ALTER TABLE users DROP CONSTRAINT IF EXISTS users_scan_point_check;`);
  await pool.query(`ALTER TABLE users ADD CONSTRAINT users_scan_point_check CHECK (scan_point IS NULL OR scan_point IN ('hotel_desk','transport','food_counter','inventory','registration'));`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS vehicle_id INTEGER REFERENCES vehicles(id) ON DELETE SET NULL;`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS stall_id INTEGER REFERENCES stall_bookings(id) ON DELETE SET NULL;`);
  // See the "intermediate migrations" note near the first users_role_check
  // ALTER above — kept in sync with the full current role list (including
  // 'scanner', added by a later migration further down this file) so this
  // step never rejects existing 'scanner'-role rows.
  await pool.query(`ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;`);
  await pool.query(`ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('super_admin','admin','host_member','media','transporter','driver','volunteer','vendor','stall_owner','scanner'));`);

  // attendance_log started life as gate-only "Mark Attendance" (see its
  // original CREATE TABLE below — every row was implicitly a gate check-in).
  // scan_point widens it into the single history for EVERY kind of badge
  // scan (gate/hotel_checkin/hotel_checkout/transport/food_counter/stall/
  // goodies), each still recording checked_in_by_user_id — i.e. who did the
  // scanning — which is what makes "who scanned whom, and when" queryable
  // (see the /api/badge/scan-history and /api/badge/my-scans routes in
  // badge.js). meta carries action-specific detail that doesn't deserve its
  // own column (which meal slot, which trip/vehicle a transport-scan
  // matched or missed, which goodies distribution row a delivery closed).
  await pool.query(`ALTER TABLE attendance_log ADD COLUMN IF NOT EXISTS scan_point TEXT NOT NULL DEFAULT 'gate';`);
  await pool.query(`ALTER TABLE attendance_log DROP CONSTRAINT IF EXISTS attendance_log_scan_point_check;`);
  await pool.query(`ALTER TABLE attendance_log ADD CONSTRAINT attendance_log_scan_point_check CHECK (scan_point IN ('gate','hotel_checkin','hotel_checkout','transport','food_counter','stall','goodies'));`);
  await pool.query(`ALTER TABLE attendance_log ADD COLUMN IF NOT EXISTS meta JSONB;`);
  await pool.query(`CREATE INDEX IF NOT EXISTS attendance_log_scan_point_idx ON attendance_log(scan_point);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS attendance_log_scanner_idx ON attendance_log(checked_in_by_user_id);`);

  // money). Recreated on every boot (CREATE OR REPLACE) so adding a new
  // source later is just one more UNION branch.
  await pool.query(`
    CREATE OR REPLACE VIEW finance_inward_ledger AS
      SELECT 'registration'::text AS source, r.id AS source_id, 'Registration Fee'::text AS category,
             r.reg_number AS reference, r.amount_paid AS amount, r.payment_mode,
             r.created_at::date AS transaction_date, NULL::text AS notes
      FROM registrations r WHERE r.payment_status IN ('paid','partial') AND r.amount_paid > 0

      UNION ALL
      SELECT 'host_member', hm.id, 'Host Member Fee',
             hm.name, hm.payment_amount, hm.payment_mode,
             COALESCE(hm.payment_date, hm.created_at::date), NULL
      FROM host_members hm WHERE hm.payment_status = 'paid'

      UNION ALL
      SELECT 'stall_booking', sb.id, 'Stall Booking',
             sb.company_name, sb.amount, sb.payment_mode,
             COALESCE(sb.payment_date, sb.created_at::date), NULL
      FROM stall_bookings sb WHERE sb.payment_status = 'paid'

      UNION ALL
      SELECT 'pre_tour', ptp.id, 'Pre-Tour Payment',
             pt.name || ' - ' || COALESCE(p.name, hm2.name, 'Unknown'), pt.price, NULL::text,
             ptp.created_at::date, NULL
      FROM pre_tour_participants ptp
      JOIN pre_tours pt ON pt.id = ptp.pre_tour_id
      LEFT JOIN participants p ON p.id = ptp.participant_id
      LEFT JOIN host_members hm2 ON hm2.id = ptp.host_member_id
      WHERE ptp.payment_status = 'paid' AND pt.price IS NOT NULL

      UNION ALL
      SELECT 'sponsor', s.id, 'Sponsorship' || CASE WHEN s.tier <> '' THEN ' - ' || s.tier ELSE '' END,
             s.name, s.payment_amount, s.payment_mode,
             COALESCE(s.payment_date, s.created_at::date), NULL
      FROM sponsors s WHERE s.payment_status = 'paid' AND s.payment_amount IS NOT NULL AND s.payment_amount > 0

      UNION ALL
      SELECT 'manual', ft.id, ft.category, ft.payee_or_payer, ft.amount, ft.payment_mode,
             ft.transaction_date, ft.notes
      FROM finance_transactions ft WHERE ft.type = 'inward';
  `);

  // --- Email Campaigns: bulk, personalized email blasts (via Resend) to any
  // of the audience tables that carry an email column (Delegates, Host
  // Members, Volunteers, Sponsors, Speakers, Guest Visitors). Deliberately
  // separate from `messages` (in-app announcements, requires a login) —
  // this reaches people who have no account at all, straight to their inbox,
  // with per-recipient send tracking so a partial failure is visible instead
  // of silent. See server/routes/emailCampaigns.js.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS email_campaigns (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      subject TEXT NOT NULL,
      body_html TEXT NOT NULL,
      audience_type TEXT NOT NULL CHECK (audience_type IN ('participant','host_member','volunteer','sponsor','speaker','guest_visitor')),
      -- NULL = every row of audience_type that has a valid email on file.
      -- Non-null = only these specific ids (from a "click to pick" grid in
      -- the admin UI) — lets an admin hand-pick individual Delegates/Host
      -- Members instead of always blasting an entire category.
      recipient_ids INTEGER[],
      from_name TEXT NOT NULL DEFAULT 'SINC2026 Congress',
      status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sending','sent','failed')),
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMP DEFAULT NOW(),
      sent_at TIMESTAMP
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS email_campaign_recipients (
      id SERIAL PRIMARY KEY,
      campaign_id INTEGER NOT NULL REFERENCES email_campaigns(id) ON DELETE CASCADE,
      recipient_type TEXT NOT NULL,
      recipient_id INTEGER NOT NULL,
      name TEXT,
      email TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed')),
      resend_id TEXT,
      error TEXT,
      sent_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS email_campaign_recipients_campaign_idx ON email_campaign_recipients(campaign_id);`);

  // --- QR Badges: one scannable QR per Delegate/Host Member, encoding a
  // random opaque badge_token (never the raw sequential id) so a lost/photographed
  // badge can't be used to enumerate everyone else's contact details just by
  // walking the id up or down. The same token/URL serves three audiences from
  // one adaptive page (public/badge.html):
  //   - anyone (no login): a vCard-style contact card (name/phone/email/org)
  //     with a "Save to Contacts" button — see server/routes/badge.js public route.
  //   - logged-in staff (Transport/Pre-Tours/gate): the same link additionally
  //     shows room + vehicle assignment + payment status + a Mark Attendance
  //     button — see the staff route in the same file.
  // Backfilled below for any rows created before this migration ran.
  await pool.query(`ALTER TABLE participants ADD COLUMN IF NOT EXISTS badge_token TEXT;`);
  await pool.query(`ALTER TABLE host_members ADD COLUMN IF NOT EXISTS badge_token TEXT;`);
  // Same "generate on insert if missing" trigger pattern as participant_code
  // above, so every future row (single insert, CSV import, etc.) gets a
  // token automatically without every call site needing to remember to set one.
  await pool.query(`
    CREATE OR REPLACE FUNCTION set_badge_token() RETURNS TRIGGER AS $$
    BEGIN
      IF NEW.badge_token IS NULL THEN
        NEW.badge_token := substr(md5(random()::text || clock_timestamp()::text || COALESCE(NEW.id::text, '')), 1, 20);
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `);
  await pool.query(`DROP TRIGGER IF EXISTS trg_set_badge_token_participants ON participants;`);
  await pool.query(`
    CREATE TRIGGER trg_set_badge_token_participants BEFORE INSERT ON participants
    FOR EACH ROW EXECUTE FUNCTION set_badge_token();
  `);
  await pool.query(`DROP TRIGGER IF EXISTS trg_set_badge_token_host_members ON host_members;`);
  await pool.query(`
    CREATE TRIGGER trg_set_badge_token_host_members BEFORE INSERT ON host_members
    FOR EACH ROW EXECUTE FUNCTION set_badge_token();
  `);
  // Backfill existing rows (created before this migration ran).
  await pool.query(`UPDATE participants SET badge_token = substr(md5(random()::text || clock_timestamp()::text || id::text), 1, 20) WHERE badge_token IS NULL;`);
  await pool.query(`UPDATE host_members SET badge_token = substr(md5(random()::text || clock_timestamp()::text || id::text), 1, 20) WHERE badge_token IS NULL;`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS participants_badge_token_uidx ON participants(badge_token) WHERE badge_token IS NOT NULL;`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS host_members_badge_token_uidx ON host_members(badge_token) WHERE badge_token IS NOT NULL;`);

  // One row per "Mark Attendance" scan at the entrance/gate. No uniqueness
  // constraint — a person can be scanned in more than once (e.g. re-entry
  // after stepping out) and every scan is kept as a full attendance trail;
  // the staff badge view just shows the most recent one as "checked in at ...".
  await pool.query(`
    CREATE TABLE IF NOT EXISTS attendance_log (
      id SERIAL PRIMARY KEY,
      entity_type TEXT NOT NULL CHECK (entity_type IN ('participant','host_member')),
      entity_id INTEGER NOT NULL,
      checked_in_at TIMESTAMP NOT NULL DEFAULT NOW(),
      checked_in_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS attendance_log_entity_idx ON attendance_log(entity_type, entity_id);`);

  // --- Scanner role + Registration Desk scan point ---------------------
  // Dedicated login type for scanning-duty-only staff, instead of always
  // bolting scan_point onto an unrelated role like media/volunteer. 'scanner'
  // has no linked profile record (same pattern as 'media' in
  // LINKED_ROLE_FIELDS/auth.js) — which station it covers (Hotel Desk,
  // Transport, Food Counter, Goodies/Inventory, Registration Desk) is set
  // entirely via scan_point. Stalls scanning duty still uses the existing
  // stall_owner role (tied to one specific stall_id), not 'scanner' — see
  // the admin panel's "Scanner Logins" section, which creates either kind
  // from one unified "Station" picker.
  await pool.query(`ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;`);
  await pool.query(`ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('super_admin','admin','host_member','media','transporter','driver','volunteer','vendor','stall_owner','scanner'));`);
  await pool.query(`ALTER TABLE users DROP CONSTRAINT IF EXISTS users_scan_point_check;`);
  await pool.query(`ALTER TABLE users ADD CONSTRAINT users_scan_point_check CHECK (scan_point IS NULL OR scan_point IN ('hotel_desk','transport','food_counter','inventory','registration'));`);

  // --- Vehicle types expanded beyond van/car/bus ------------------------
  // The Vehicles master now offers 6 specific types instead of 3 generic
  // ones — Sedan effectively replaces "car" as the ground-transport default,
  // so 'car' is kept in the allowed set (not removed) purely so any vehicle
  // rows already saved with that old type don't fail this constraint; the
  // Add/Edit Vehicle form (admin.html) no longer offers 'car' as a choice
  // going forward. See server/routes/vehicles.js's TYPE_PREFIX map for the
  // per-type auto-generated code prefix (C/U/F/A/S/O).
  await pool.query(`ALTER TABLE vehicles DROP CONSTRAINT IF EXISTS vehicles_vehicle_type_check;`);
  await pool.query(`ALTER TABLE vehicles ADD CONSTRAINT vehicles_vehicle_type_check CHECK (vehicle_type IN ('sedan','suv','force_traveller','bus','van','others','car'));`);

  // --- Catering + accommodation for host members and volunteers ---------
  // participants already carried dietary_preference / drink_preference /
  // special_requests; host_members and volunteers now do too, so my-profile.html
  // can collect the same catering headcount from the host team and the
  // Delegates/Host Members reports can be compared like for like.
  //
  // hotel_stay_required is deliberately BOOLEAN NOT NULL DEFAULT false: the
  // host club is local, so a room is the exception rather than the norm and
  // "no" is the safe default for anyone who never opens the form.
  // hotel_stay_notes captures the free-text "which nights / why" that the
  // organisers need to judge an essential-only request.
  for (const t of ['host_members', 'volunteers']) {
    await pool.query(`ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS dietary_preference TEXT;`);
    await pool.query(`ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS drink_preference TEXT;`);
    await pool.query(`ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS special_requests TEXT;`);
    await pool.query(`ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS hotel_stay_required BOOLEAN NOT NULL DEFAULT false;`);
    await pool.query(`ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS hotel_stay_notes TEXT;`);
    // The member's own company logo, uploaded from my-profile.html next to
    // their photo and business card. Stored the same way as sponsors.logo_url
    // (an R2 https:// URL, or a local /uploads path in dev) — see
    // server/uploadHelper.js.
    await pool.query(`ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS logo_url TEXT;`);
  }

  // --- Delegate registration category -----------------------------------
  // What package a booking was sold on, which is a different question from
  // reg_type. reg_type is *occupancy* — single/double decides how many
  // delegates a registration may hold and drives the "Double = 2" headcount
  // everywhere; this is the *product*: early-bird vs regular pricing, and
  // Full (includes hotel accommodation) vs Congress Only (sessions only, no
  // room). Kept as a separate column rather than folded into reg_type so the
  // existing capacity checks and delegate counts are untouched.
  //
  // Nullable with no default: registrations taken before this existed have
  // no recorded category, and guessing one would be worse than showing the
  // office an honest blank to go back and fill in.
  await pool.query(`ALTER TABLE registrations ADD COLUMN IF NOT EXISTS registration_category TEXT;`);
  await pool.query(`ALTER TABLE registrations DROP CONSTRAINT IF EXISTS registrations_category_check;`);
  await pool.query(`ALTER TABLE registrations ADD CONSTRAINT registrations_category_check CHECK (registration_category IS NULL OR registration_category IN ('early_bird_full','early_bird_congress_only','regular_full','regular_congress_only'));`);

  // --- Post-tours ---------------------------------------------------------
  // A post-tour is the same thing as a pre-tour in every respect that the
  // schema cares about — it has dates, a hotel plan, a day-wise itinerary,
  // signups and transport trips. Rather than a parallel set of five tables
  // (and a parallel set of routes, PDFs and UI), pre_tours gains a type
  // discriminator. Everything keyed on pre_tour_id keeps working untouched.
  // Defaults to 'pre' so every existing tour stays exactly what it was.
  await pool.query(`ALTER TABLE pre_tours ADD COLUMN IF NOT EXISTS tour_type TEXT NOT NULL DEFAULT 'pre';`);
  await pool.query(`ALTER TABLE pre_tours DROP CONSTRAINT IF EXISTS pre_tours_tour_type_check;`);
  await pool.query(`ALTER TABLE pre_tours ADD CONSTRAINT pre_tours_tour_type_check CHECK (tour_type IN ('pre','post'));`);
  // Itinerary items gain a free-text duration/notes field so a day can carry
  // real detail ("2 hrs, includes guided walk") beyond a single time stamp.
  await pool.query(`ALTER TABLE pre_tour_itinerary ADD COLUMN IF NOT EXISTS duration TEXT;`);

  // --- One-off / external email recipients --------------------------------
  // Campaigns could only target rows already in the database. The office also
  // needs to mail an address that isn't a delegate, host member or sponsor —
  // a hotel contact, a vendor, one person for a re-send. 'manual' is an
  // audience whose recipients come from this free-text column instead of a
  // table, stored as one "Name <email>" (or bare email) per line.
  await pool.query(`ALTER TABLE email_campaigns ADD COLUMN IF NOT EXISTS manual_recipients TEXT;`);
  await pool.query(`ALTER TABLE email_campaigns DROP CONSTRAINT IF EXISTS email_campaigns_audience_type_check;`);
  await pool.query(`ALTER TABLE email_campaigns ADD CONSTRAINT email_campaigns_audience_type_check CHECK (audience_type IN ('participant','host_member','volunteer','sponsor','speaker','guest_visitor','manual'));`);

  // --- Goodies & Inventory: custodian handoffs -----------------------------
  // "Assigned to" and "delivered by" were host_member-only (assigned_
  // host_member_id / delivered_by_host_member_id above) — a volunteer could
  // never be handed goods to run out and deliver. These generalized
  // type+id pairs are the new source of truth for BOTH roles; the legacy
  // host_member-only columns are left in place (never dropped) so nothing
  // that already reads them breaks, and are kept mirrored whenever the
  // custodian IS a host member, so old and new columns never disagree.
  // assigned_custodian_* is who's currently carrying the stock and who it's
  // meant for ("in charge of" — the courier's own checklist, surfaced via
  // GET /api/badge/my-goodies-checklist); delivered_by_* is stamped once
  // they actually scan the recipient and hand it over.
  await pool.query(`ALTER TABLE inventory_distributions ADD COLUMN IF NOT EXISTS assigned_custodian_type TEXT;`);
  await pool.query(`ALTER TABLE inventory_distributions DROP CONSTRAINT IF EXISTS inventory_distributions_assigned_custodian_type_check;`);
  await pool.query(`ALTER TABLE inventory_distributions ADD CONSTRAINT inventory_distributions_assigned_custodian_type_check CHECK (assigned_custodian_type IS NULL OR assigned_custodian_type IN ('host_member','volunteer'));`);
  await pool.query(`ALTER TABLE inventory_distributions ADD COLUMN IF NOT EXISTS assigned_custodian_id INTEGER;`);
  await pool.query(`ALTER TABLE inventory_distributions ADD COLUMN IF NOT EXISTS delivered_by_type TEXT;`);
  await pool.query(`ALTER TABLE inventory_distributions DROP CONSTRAINT IF EXISTS inventory_distributions_delivered_by_type_check;`);
  await pool.query(`ALTER TABLE inventory_distributions ADD CONSTRAINT inventory_distributions_delivered_by_type_check CHECK (delivered_by_type IS NULL OR delivered_by_type IN ('host_member','volunteer'));`);
  await pool.query(`ALTER TABLE inventory_distributions ADD COLUMN IF NOT EXISTS delivered_by_id INTEGER;`);
  // Backfill from the legacy columns so existing assignments/deliveries show
  // up under the new generalized pair immediately, without waiting for
  // someone to re-save each row.
  await pool.query(`UPDATE inventory_distributions SET assigned_custodian_type='host_member', assigned_custodian_id=assigned_host_member_id WHERE assigned_host_member_id IS NOT NULL AND assigned_custodian_id IS NULL;`);
  await pool.query(`UPDATE inventory_distributions SET delivered_by_type='host_member', delivered_by_id=delivered_by_host_member_id WHERE delivered_by_host_member_id IS NOT NULL AND delivered_by_id IS NULL;`);
  await pool.query(`CREATE INDEX IF NOT EXISTS inventory_distributions_custodian_idx ON inventory_distributions(assigned_custodian_type, assigned_custodian_id);`);

  // --- Transport boarding status -------------------------------------------
  // The QR "Transport Scan" action (server/routes/badge.js) used to only
  // check the scanning login's own assigned vehicle — now the scanner picks
  // the exact trip (route + vehicle + driver) from a dropdown first, and a
  // successful scan against that trip marks THIS passenger row boarded, so
  // the Transport Planning manifest (server/routes/transport.js GET /:id)
  // can show who's actually on the vehicle, not just who was planned onto it.
  await pool.query(`ALTER TABLE transport_trip_passengers ADD COLUMN IF NOT EXISTS boarded_at TIMESTAMP;`);
  await pool.query(`ALTER TABLE transport_trip_passengers ADD COLUMN IF NOT EXISTS boarded_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;`);

  // --- Event attendance (registration desk QR scanning) --------------------
  // One row per person marked present at one itinerary slot (see
  // itinerary_items above — "Day 2, 9:00 AM, Inaugural Ceremony" etc). Tied
  // to itinerary_item_id rather than a separate hardcoded "sessions" list on
  // purpose: the registration desk's scanner dropdown (server/routes/
  // badge.js's GET /itinerary-events) reads the SAME live itinerary_items
  // table the Itinerary module edits, so renaming/retiming/adding a slot
  // there is immediately reflected at the scanner with no separate step —
  // "even after the itinerary is modified, the scanner should work". ON
  // DELETE CASCADE mirrors agenda_events' own FK to itinerary_items: if a
  // slot is deleted outright (not just edited), its attendance goes with it.
  // UNIQUE per (item, entity) makes a re-scan of the same badge at the same
  // event a harmless no-op rather than a duplicate row.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS event_attendance (
      id SERIAL PRIMARY KEY,
      itinerary_item_id INTEGER NOT NULL REFERENCES itinerary_items(id) ON DELETE CASCADE,
      entity_type TEXT NOT NULL CHECK (entity_type IN ('participant','host_member')),
      entity_id INTEGER NOT NULL,
      checked_in_at TIMESTAMP NOT NULL DEFAULT NOW(),
      checked_in_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      UNIQUE(itinerary_item_id, entity_type, entity_id)
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS event_attendance_item_idx ON event_attendance(itinerary_item_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS event_attendance_entity_idx ON event_attendance(entity_type, entity_id);`);
  // Note: no scan_point CHECK change needed here — 'registration' was
  // already a valid value (see the multi-point-scanning migration above),
  // it just had no scan action of its own yet, only piggybacking on the
  // universal gate check-in. It now also grants the /attendance-scan
  // action below (badge.js), same role, no schema change required.

  // --- Transport: "Other / Guest" passengers -------------------------------
  // A trip's passenger manifest used to require exactly one of participant_id
  // or host_member_id — every rider had to already be a registered delegate
  // or host member. Some trips carry people who are neither (vendor staff,
  // a walk-in guest, an extra family member), so guest_name/guest_phone add a
  // third, free-text identity alongside the other two. These rows have NO
  // badge_token anywhere in the system, so they can never be marked boarded
  // via a QR scan — boarding for a guest row is a manual toggle instead (see
  // PUT /transport/:id/passengers/:passengerId/board in transport.js).
  await pool.query(`ALTER TABLE transport_trip_passengers ADD COLUMN IF NOT EXISTS guest_name TEXT;`);
  await pool.query(`ALTER TABLE transport_trip_passengers ADD COLUMN IF NOT EXISTS guest_phone TEXT;`);
  // The original CHECK (added inline and unnamed in the CREATE TABLE above)
  // enforced exactly-one-of participant/host-member with no room for a guest
  // row. Find and drop it dynamically by its definition rather than guessing
  // Postgres's auto-generated constraint name.
  await pool.query(`
    DO $$
    DECLARE cname text;
    BEGIN
      SELECT conname INTO cname FROM pg_constraint
      WHERE conrelid = 'transport_trip_passengers'::regclass AND contype = 'c'
        AND pg_get_constraintdef(oid) LIKE '%host_member_id IS NULL%';
      IF cname IS NOT NULL THEN
        EXECUTE format('ALTER TABLE transport_trip_passengers DROP CONSTRAINT %I', cname);
      END IF;
    END $$;
  `);
  await pool.query(`ALTER TABLE transport_trip_passengers DROP CONSTRAINT IF EXISTS transport_trip_passengers_identity_check;`);
  await pool.query(`
    ALTER TABLE transport_trip_passengers ADD CONSTRAINT transport_trip_passengers_identity_check CHECK (
      (participant_id IS NOT NULL AND host_member_id IS NULL AND guest_name IS NULL) OR
      (participant_id IS NULL AND host_member_id IS NOT NULL AND guest_name IS NULL) OR
      (participant_id IS NULL AND host_member_id IS NULL AND guest_name IS NOT NULL)
    );
  `);

  // --- Transport: transporter's own "approved" acknowledgement -------------
  // A simple confirmation flag the transport vendor sets from their own
  // portal (see PUT /transporter-portal/trips/:id/approve) — separate from
  // the operational status (planned/in_progress/completed/cancelled), purely
  // to tell admin/committee "the vendor has seen and accepted this trip".
  // Nothing else is gated on it; an unapproved trip works exactly as before.
  await pool.query(`ALTER TABLE transport_trips ADD COLUMN IF NOT EXISTS transporter_approved_at TIMESTAMP;`);
  await pool.query(`ALTER TABLE transport_trips ADD COLUMN IF NOT EXISTS transporter_approved_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;`);
}

module.exports = { pool, all, get, run, transaction, initSchema };