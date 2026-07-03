const express = require('express');
const cors = require('cors');
const path = require('path');
const db = require('./db');
const { runBackup } = require('./backup');

const app = express();
const PORT = process.env.PORT || 3000;

// --- Admin authentication (protects the admin UI and any data-changing request) ---
// Set a real password via the ADMIN_PASSWORD environment variable before going live.
// Default is intentionally weak so it's obvious this must be changed.
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'sinc2026admin';

function requireAdminAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, encoded] = header.split(' ');
  if (scheme === 'Basic' && encoded) {
    const [user, pass] = Buffer.from(encoded, 'base64').toString('utf8').split(':');
    if (user === ADMIN_USER && pass === ADMIN_PASSWORD) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="SINC2026 Admin"');
  return res.status(401).send('Authentication required.');
}

// --- CORS ---
// When the frontend is hosted separately (e.g. on Netlify) while this server
// runs elsewhere (Render), set ALLOWED_ORIGIN to the exact frontend URL
// (e.g. https://sinc2026.com). credentials:true is required so the browser
// will send/cache the admin Basic Auth login across origins.
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || true;
app.use(cors({ origin: ALLOWED_ORIGIN, credentials: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Gate the admin page itself
app.get('/admin.html', requireAdminAuth, (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'admin.html'));
});

// Gate every data-changing API request (public dashboard only ever does GET)
app.use('/api', (req, res, next) => {
  if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method)) {
    return requireAdminAuth(req, res, next);
  }
  next();
});

// Static frontend + locally-stored media (when R2 isn't configured)
app.use(express.static(path.join(__dirname, '..', 'public')));

// API routes
app.use('/api/clubs', require('./routes/clubs'));
app.use('/api/registrations', require('./routes/registrations'));
app.use('/api/participants', require('./routes/participants'));
app.use('/api/media', require('./routes/media'));
app.use('/api/happenings', require('./routes/happenings'));
app.use('/api/stats', require('./routes/stats'));
app.use('/api/export', require('./routes/export'));

app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// Manual trigger for an on-demand backup (admin-only) in addition to the
// automatic weekly one below — handy right before a risky bulk edit.
app.post('/api/admin/backup-now', requireAdminAuth, async (req, res) => {
  try {
    const result = await runBackup();
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

async function start() {
  try {
    await db.initSchema();
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
