const express = require('express');
const cors = require('cors');
const path = require('path');
const db = require('./db');
const { runBackup } = require('./backup');
const { hashPassword, requireAuth, requireSuperAdmin, requireAdminRole } = require('./auth');

const app = express();
const PORT = process.env.PORT || 3000;

// --- Bootstrap admin login (used once, on first boot, to create the initial ---
// --- super-admin account — see bootstrapSuperAdmin() below). Everyone else  ---
// --- logs in with a real username/password via /api/auth, managed from the ---
// --- Settings tab (generate logins, approve signup requests).              ---
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'sinc2026admin';

// --- CORS ---
// When the frontend is hosted separately (e.g. on Netlify) while this server
// runs elsewhere (Render), set ALLOWED_ORIGIN to the exact frontend URL
// (e.g. https://sinc2026.com).
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || true;
app.use(cors({ origin: ALLOWED_ORIGIN, credentials: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Static frontend + locally-stored media (when R2 isn't configured).
// admin.html and index.html are both served openly as static HTML — each
// page's own JS shows a login screen and refuses to load any data until a
// valid token is obtained from /api/auth/login. The real protection is
// server-side: every dashboard data route below requires that token.
app.use(express.static(path.join(__dirname, '..', 'public')));

// --- Auth routes (signup/login are public; user-management is self-gated inside) ---
app.use('/api/auth', require('./routes/auth'));

// --- Push notification subscriptions — self-gated inside (any logged-in
// role can subscribe/unsubscribe their own browser; only admin/super_admin
// can broadcast). Mounted early/unwrapped, same pattern as /api/host. ---
app.use('/api/push', require('./routes/push'));

// --- Communications: one-way announcements (role/committee/individual) with
// an optional attached action — self-gated inside (composing is admin-only;
// the inbox + read/action-done endpoints are requireAuth for any role).
// Mounted unwrapped, same pattern as /api/push and /api/host.
app.use('/api/messages', require('./routes/messages'));

// --- Email Campaigns: bulk personalized email blasts (via Resend) to any
// audience that carries an email column — Delegates, Host Members,
// Volunteers, Sponsors, Guest Speakers, Guest Visitors. Admin-only, same
// protection level as Communications above. See emailCampaigns.js file
// header for the send-in-background design.
app.use('/api/email-campaigns', requireAdminRole, require('./routes/emailCampaigns'));

// Public, no-login "update my own details" route — lets any delegate, host
// member, or volunteer fill in their own Shirt Size / T-Shirt Size / Photo /
// Business Card via a shared link (public/my-profile.html), without needing
// an account. Every mutating call re-verifies name+phone server-side (see
// the file header in publicProfile.js) so this can't be used to view or
// change anyone else's data. Mounted early/unwrapped (like /api/push and
// /api/host above) so it runs before the global mutating-methods auth gate
// further down — that gate would otherwise block this route's POST/PUT
// calls with "Login required.", defeating the whole point of a no-login page.
app.use('/api/public-profile', require('./routes/publicProfile'));

// Public, no-login QR badge lookup — the "anyone scans it, gets a digital
// visiting card" half of the badge feature (see server/routes/badge.js file
// header). Mounted early/unwrapped for the same reason as publicProfile
// above: it must run before the global mutating-methods auth gate further
// down, and it's a GET anyway so there's nothing to protect from that gate.
app.use('/api/badge', require('./routes/badge').publicRouter);

// --- Only a super admin may delete anything, across every resource (clubs, ---
// --- registrations, participants, media, happenings, logins). A regular   ---
// --- admin can still create/edit records, just not permanently remove     ---
// --- them. Checked once here, globally, so no individual route can be     ---
// --- accidentally left unprotected.                                      ---
app.use('/api', (req, res, next) => {
  if (req.method === 'DELETE') return requireSuperAdmin(req, res, next);
  next();
});

// --- Fully protected — personal data (names/phones/emails/addresses) and ---
// --- payment data never leave the server without a valid ADMIN login.    ---
// requireAdminRole (not just requireAuth) so that the restricted-scope
// logins below (host_member, media, transporter, driver) — which are all
// otherwise-valid tokens — can't reach this internal staff data even by
// calling the API directly; each of those gets its own narrow self-service
// route instead (/api/host, /api/driver-portal, /api/transporter-portal).
app.use('/api/participants', requireAdminRole, require('./routes/participants'));
app.use('/api/registrations', requireAdminRole, require('./routes/registrations'));
app.use('/api/export', requireAdminRole, require('./routes/export'));
// Staff half of the QR badge feature — any logged-in login can reach these
// routes (requireAuth, not requireAdminRole), because scan duties are now
// assignable to non-admin logins too (host_member/volunteer/driver/
// transporter deputised for a scan_point, or a stall_owner login). Each
// route inside badge.js still computes and enforces that specific login's
// own caps before returning anything sensitive or performing a scan — see
// computeCaps() in server/routes/badge.js.
app.use('/api/badge', requireAuth, require('./routes/badge').staffRouter);

// --- Host club module — host member directory, committees, delegate ---
// --- assistance assignments, and their checklist/milestones. All internal ---
// --- staff data, so fully protected like participants/registrations.     ---
app.use('/api/hostmembers', requireAdminRole, require('./routes/hostmembers'));
app.use('/api/committees', requireAdminRole, require('./routes/committees'));
app.use('/api/assignments', requireAdminRole, require('./routes/assignments'));
app.use('/api/tasks', requireAdminRole, require('./routes/tasks'));
app.use('/api/partners', requireAdminRole, require('./routes/partners'));
app.use('/api/drivers', requireAdminRole, require('./routes/drivers'));
// Volunteers: external/non-club-member helpers granted direct access to
// specific modules (no committee needed) — see server/routes/volunteers.js.
app.use('/api/volunteers', requireAdminRole, require('./routes/volunteers'));
// Self-service portals — each does its own auth + ownership scoping rather
// than a blanket admin gate, so the linked person only ever sees their own
// data (their assignments, their trips, their partner's fleet, their granted modules).
app.use('/api/host', require('./routes/host'));
app.use('/api/driver-portal', require('./routes/driverPortal'));
app.use('/api/transporter-portal', require('./routes/transporterPortal'));
app.use('/api/volunteer', require('./routes/volunteerSelf'));

// --- Committee-granted module access ---
// Same route handlers as the admin-only mounts below, exposed a second time
// under /api/portal-modules/<name> so a host member whose committee has been
// granted that module (server/routes/committeeModuleAccess.js) can manage it
// directly from their own portal — without going through an admin. Deletes
// stay blocked regardless: the global "DELETE requires super_admin"
// middleware above already runs in front of every /api route, this one
// included.
{
  const { requireModuleAccess } = require('./routes/committeeModuleAccess');
  app.use('/api/portal-modules/partners', requireModuleAccess('transport_partners'), require('./routes/partners'));
  app.use('/api/portal-modules/drivers', requireModuleAccess('transport_partners'), require('./routes/drivers'));
  app.use('/api/portal-modules/vehicles', requireModuleAccess('vehicles'), require('./routes/vehicles'));
  app.use('/api/portal-modules/transport', requireModuleAccess('transport_planning'), require('./routes/transport'));
  app.use('/api/portal-modules/transport-points', requireModuleAccess('transport_planning'), require('./routes/transportPoints'));
  app.use('/api/portal-modules/pretours', requireModuleAccess('pretours'), require('./routes/pretours'));
  app.use('/api/portal-modules/hotels', requireModuleAccess('accommodation'), require('./routes/hotels'));
  app.use('/api/portal-modules/rooms', requireModuleAccess('accommodation'), require('./routes/rooms'));
  app.use('/api/portal-modules/inventory', requireModuleAccess('inventory'), require('./routes/inventory'));
  app.use('/api/portal-modules/sponsors', requireModuleAccess('sponsors'), require('./routes/sponsors'));
  app.use('/api/portal-modules/speakers', requireModuleAccess('speakers'), require('./routes/speakers'));
  app.use('/api/portal-modules/guestvisitors', requireModuleAccess('guestvisitors'), require('./routes/guestvisitors'));
  app.use('/api/portal-modules/media', requireModuleAccess('media'), require('./routes/media'));
  app.use('/api/portal-modules/happenings', requireModuleAccess('happenings'), require('./routes/happenings'));
  app.use('/api/portal-modules/itinerary', requireModuleAccess('itinerary'), require('./routes/itinerary'));
  // Agenda Builder (per-itinerary-slot event flow) + Performer/Vendor Groups
  // master — both admin-only routers (mounted below under /api/agenda and
  // /api/performer-groups) reused here so a committee granted the Itinerary
  // module can build out the detailed run-of-show and manage hired
  // performer groups from their own portal, same "one checkbox, several
  // routers" pattern as transport_partners/accommodation above.
  app.use('/api/portal-modules/agenda', requireModuleAccess('itinerary'), require('./routes/agenda'));
  app.use('/api/portal-modules/performer-groups', requireModuleAccess('itinerary'), require('./routes/performerGroups'));
  // Attendance report (who was scanned present at each itinerary slot) —
  // same one-checkbox-several-routers reuse of the Itinerary module grant.
  app.use('/api/portal-modules/attendance', requireModuleAccess('itinerary'), require('./routes/attendance'));
  // Delegate registration data entry (for volunteers doing on-site/onboarding
  // data entry) — clubs (so a club dropdown/quick-add is available), the
  // registrations they belong to, and the delegates themselves. One module
  // key ('participants') covers all three, same one-checkbox-many-routers
  // pattern as transport_partners and accommodation above.
  app.use('/api/portal-modules/clubs', requireModuleAccess('participants'), require('./routes/clubs'));
  app.use('/api/portal-modules/registrations', requireModuleAccess('participants'), require('./routes/registrations'));
  app.use('/api/portal-modules/participants', requireModuleAccess('participants'), require('./routes/participants'));
}

// --- Operations module: Transport Planning + Pre Tours. Same protection ---
// level as the host club module above (internal logistics/personal data). ---
app.use('/api/vehicles', requireAdminRole, require('./routes/vehicles'));
app.use('/api/transport', requireAdminRole, require('./routes/transport'));
app.use('/api/transport-points', requireAdminRole, require('./routes/transportPoints'));
app.use('/api/pretours', requireAdminRole, require('./routes/pretours'));
app.use('/api/hotels', requireAdminRole, require('./routes/hotels'));
app.use('/api/rooms', requireAdminRole, require('./routes/rooms'));

// Goodies & Inventory: procurement stock list + per-recipient delivery
// tracking (who it went to, who was assigned to deliver it, who actually
// did + when), tagged to a responsible committee per item.
app.use('/api/inventory', requireAdminRole, require('./routes/inventory'));

// --- Vendor Management: the outside suppliers Purchase Requests (Finance)
// and Inventory Items both procure from — what each vendor supplies, and the
// order/delivery status of everything ordered from them. /api/vendor-portal
// is the vendor's own self-scoped login (see server/routes/vendorPortal.js),
// same self-service pattern as /api/driver-portal / /api/transporter-portal.
app.use('/api/vendors', requireAdminRole, require('./routes/vendors'));
app.use('/api/vendor-portal', require('./routes/vendorPortal'));

// --- Stalls: exhibition stall enquiry -> billing -> allocation. Halls and
// stalls are admin-managed masters (the venue's final hall/stall count
// isn't fixed yet); stall_bookings.js carries the enquiry through billed
// and allocated, tracking which company holds which stall and their
// payment, with a receipt PDF built the same way as the other receipts.
app.use('/api/stall-halls', requireAdminRole, require('./routes/stallHalls'));
app.use('/api/stalls', requireAdminRole, require('./routes/stalls'));
app.use('/api/stall-bookings', requireAdminRole, require('./routes/stallBookings'));

// --- Agenda (event management under Itinerary): the detailed run-of-show ---
// within a congress itinerary slot (Prayer Song, National Anthem, dance
// performances, etc.), each with a description, organizer, and performer —
// plus a performer_groups master for hired performing groups/vendors and
// their payment. Admin-only for now (not surfaced on the public itinerary).
app.use('/api/agenda', requireAdminRole, require('./routes/agenda'));
app.use('/api/performer-groups', requireAdminRole, require('./routes/performerGroups'));

// --- Attendance (registration desk QR scanning, under Itinerary) ---------
// Who actually showed up to each itinerary slot — the report/management
// side (list + per-event attendee list + manual correction); the actual
// marking happens via the badge scanner (server/routes/badge.js's
// /attendance-scan). Reuses requireModuleAccess('itinerary') for the
// committee portal, same as Agenda/Performer Groups above — attendance is a
// sub-feature of Itinerary, not a separately grantable module.
app.use('/api/attendance', requireAdminRole, require('./routes/attendance'));

// --- Finance: inward/outward money tracking + payment approvals ---
// Inward is mostly a read-only rollup of payments already recorded by other
// modules (registrations, host member fees, stall bookings, pre-tours) plus
// manual entries. Outward payments and goodies purchase requests both need
// sign-off from specific office-bearer roles before they're actioned — the
// actual approve/reject action happens from the approver's own self-service
// portal login (see /api/host/finance/approvals in host.js), not here; this
// admin-only router is for creating requests, viewing progress, and
// marking a fully-approved one as paid.
app.use('/api/finance', requireAdminRole, require('./routes/finance'));

// --- Sponsors, Guest Speakers, Guest Visitors — each with their own ---
// customizable checklist (benefits / what-must-reach-them / offerings). ---
// /api/checklist-items is the single shared edit/delete-by-id endpoint used ---
// by every owner type (sponsor, speaker, guest_visitor, participant, ---
// host_member) — see server/routes/checklistHelper.js. ---
app.use('/api/sponsors', requireAdminRole, require('./routes/sponsors'));
app.use('/api/speakers', requireAdminRole, require('./routes/speakers'));
app.use('/api/guestvisitors', requireAdminRole, require('./routes/guestvisitors'));
app.use('/api/checklist-items', requireAdminRole, require('./routes/checklistHelper').buildChecklistItemsRouter());
// Master checklist templates (per category) — managed from the Checklists &
// Milestones admin tab; this is what "quick add" suggestions are drawn from.
app.use('/api/checklist-templates', requireAdminRole, require('./routes/checklistTemplates'));

// --- Activity Log: super_admin only, read-only audit trail ---
app.use('/api/activity-log', requireSuperAdmin, require('./routes/activityLog'));

// --- Congress registration stats: admin/super_admin only ---
// The stats dashboard now lives at dashboard.html with its own login gate.
// clubs (raw club list, used by admin.html's Clubs tab) and stats (overview/
// club-comparison/nationwide/dietary) are the registration-derived data that
// stays gated — every method, GET included, requires an admin session.
app.use('/api/clubs', requireAdminRole, require('./routes/clubs'));
app.use('/api/stats', requireAdminRole, require('./routes/stats'));

// --- Public promotional content (used by the public homepage, index.html) ---
// media (video reel/posters), itinerary, and happenings are public reads —
// anyone can view them without logging in — but still require an admin
// session to create/edit/delete, same as before the dashboard was split up.
app.use('/api', (req, res, next) => {
  if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method)) {
    return requireAuth(req, res, next);
  }
  next();
});
app.use('/api/media', require('./routes/media'));
// GET stays public (the congress homepage renders the agenda from here). The
// global mutating-methods gate above only requires ANY logged-in user, not a
// specific role — so previously any host_member/driver/volunteer/etc, even
// one with no Itinerary module grant, could bypass requireModuleAccess by
// calling this direct mount instead of /api/portal-modules/itinerary. This
// router is reused (properly gated) at that portal-modules mount, so only
// this direct admin-facing mount needed the extra admin-role check below.
app.use('/api/itinerary', (req, res, next) => {
  if (req.method === 'GET') return next();
  return requireAdminRole(req, res, next);
}, require('./routes/itinerary'));
app.use('/api/happenings', require('./routes/happenings'));
// Narrow, public-safe views of sponsors/speakers (name + logo/photo + tier/
// topic only — no phone/email/notes) for the homepage's Sponsors/Speakers
// sections. The full /api/sponsors and /api/speakers routes below (with
// contact details, checklists, etc.) stay admin-only.
app.use('/api/public', require('./routes/publicDirectory'));

app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// Manual trigger for an on-demand backup (logged-in admins only) in addition
// to the automatic weekly one below — handy right before a risky bulk edit.
app.post('/api/admin/backup-now', requireAuth, async (req, res) => {
  try {
    const result = await runBackup();
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// One-click import of the real host-member / committee / payment data (from
// the SINC2026 "Host members Record Sheet" Excel file) plus the congress
// itinerary — same logic as server/scripts/seed-host-data.js, exposed here so
// a super admin can (re-)run it from the Settings tab instead of needing
// shell access to the server. Safe to run more than once — matches existing
// host_members rows by phone number and updates rather than duplicates.
app.post('/api/admin/seed-host-data', requireSuperAdmin, async (req, res) => {
  try {
    const { runSeed } = require('./seedHostData');
    const summary = await runSeed();
    res.json(summary);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Creates the very first login (super_admin) from ADMIN_USER/ADMIN_PASSWORD
// the first time the server ever boots against a fresh database. A no-op on
// every later boot once at least one user row exists. From then on, all
// account creation/approval happens from the Settings tab in the admin panel.
async function bootstrapSuperAdmin() {
  const existing = await db.get('SELECT COUNT(*)::int AS n FROM users');
  if (existing && existing.n > 0) return;
  const hash = await hashPassword(ADMIN_PASSWORD);
  await db.run(
    `INSERT INTO users (username, password_hash, role, status, approved_at) VALUES ($1,$2,'super_admin','approved',NOW())`,
    [ADMIN_USER, hash]
  );
  console.log(`Bootstrapped initial super-admin login "${ADMIN_USER}" from ADMIN_USER/ADMIN_PASSWORD env vars. Log in at /admin.html, then create/approve additional logins from Settings.`);
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

async function start() {
  try {
    await db.initSchema();
    await bootstrapSuperAdmin();
    app.listen(PORT, () => {
      console.log(`SINC2026 dashboard server running at http://localhost:${PORT}`);
      console.log(`Admin panel: http://localhost:${PORT}/admin.html`);
    });

    // Secondary backup layer on top of Render's automatic Postgres backups:
    // a full JSON export of every table, uploaded to R2 weekly. Only runs if
    // R2 env vars are set (see server/backup.js) — otherwise this is a no-op.
    setTimeout(() => {
      runBackup().catch((e) => console.error('Startup backup failed', e.message));
      setInterval(() => {
        runBackup().catch((e) => console.error('Scheduled backup failed', e.message));
      }, WEEK_MS);
    }, 60 * 1000); // wait a minute after boot before the first run

    // Daily push reminder sweep for checklist/committee-task due dates — a
    // no-op until VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY are configured (see
    // server/pushHelper.js).
    const { runDueDateReminders } = require('./pushScheduler');
    setTimeout(() => {
      runDueDateReminders().catch((e) => console.error('Startup push reminder sweep failed', e.message));
      setInterval(() => {
        runDueDateReminders().catch((e) => console.error('Scheduled push reminder sweep failed', e.message));
      }, DAY_MS);
    }, 90 * 1000); // stagger slightly after the backup timer above
  } catch (e) {
    console.error('Failed to start server — could not initialize database schema:', e);
    process.exit(1);
  }
}

start();