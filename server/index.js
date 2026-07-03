const express = require('express');
const cors = require('cors');
const path = require('path');
const db = require('./db');
const { runBackup } = require('./backup');
const { hashPassword, requireAuth, requireSuperAdmin } = require('./auth');

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
// admin.html itself is served openly — its own JS shows a login screen and
// refuses to load any data until a valid token is obtained from /api/auth/login.
app.use(express.static(path.join(__dirname, '..', 'public')));

// --- Auth routes (signup/login are public; user-management is self-gated inside) ---
app.use('/api/auth', require('./routes/auth'));

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
// --- payment data never leave the server without a valid login.          ---
app.use('/api/participants', requireAuth, require('./routes/participants'));
app.use('/api/registrations', requireAuth, require('./routes/registrations'));
app.use('/api/export', requireAuth, require('./routes/export'));

// --- Host club module — host member directory, committees, delegate ---
// --- assistance assignments, and their checklist/milestones. All internal ---
// --- staff data, so fully protected like participants/registrations.     ---
app.use('/api/hostmembers', requireAuth, require('./routes/hostmembers'));
app.use('/api/committees', requireAuth, require('./routes/committees'));
app.use('/api/assignments', requireAuth, require('./routes/assignments'));
app.use('/api/tasks', requireAuth, require('./routes/tasks'));
app.use('/api/partners', requireAuth, require('./routes/partners'));
app.use('/api/drivers', requireAuth, require('./routes/drivers'));
// Self-service host-member portal — does its own auth + ownership checks.
app.use('/api/host', require('./routes/host'));

// --- Public reads (needed by the public dashboard), protected writes ---
app.use('/api', (req, res, next) => {
  if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method)) {
    return requireAuth(req, res, next);
  }
  next();
});
app.use('/api/clubs', require('./routes/clubs'));
app.use('/api/media', require('./routes/media'));
app.use('/api/itinerary', require('./routes/itinerary'));
app.use('/api/happenings', require('./routes/happenings'));
app.use('/api/stats', require('./routes/stats'));

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
  } catch (e) {
    console.error('Failed to start server — could not initialize database schema:', e);
    process.exit(1);
  }
}

start();
