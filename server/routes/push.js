// Web Push subscription management + admin broadcast tool. Any logged-in
// role (host_member, media, transporter, driver, admin, super_admin) can
// subscribe/unsubscribe their own browser; only admin/super_admin can send a
// manual broadcast (the "event announcements" use case).
const express = require('express');
const db = require('../db');
const { requireAuth, requireAdminRole } = require('../auth');
const push = require('../pushHelper');

const router = express.Router();

// Public — the frontend needs this to call pushManager.subscribe(). Not a
// secret; the VAPID public key is meant to be visible to browsers.
router.get('/public-key', (req, res) => {
  res.json({ publicKey: push.VAPID_PUBLIC_KEY, enabled: push.PUSH_ENABLED });
});

// Save (or refresh) this browser's subscription for the logged-in user.
router.post('/subscribe', requireAuth, async (req, res) => {
  const { endpoint, keys } = req.body || {};
  if (!endpoint || !keys || !keys.p256dh || !keys.auth) {
    return res.status(400).json({ error: 'A valid push subscription (endpoint + keys) is required.' });
  }
  try {
    await db.run(`
      INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent)
      VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth, user_agent = EXCLUDED.user_agent
    `, [req.user.id, endpoint, keys.p256dh, keys.auth, (req.headers['user-agent'] || '').slice(0, 255)]);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Remove this browser's subscription (e.g. user clicked "disable notifications").
router.delete('/subscribe', requireAuth, async (req, res) => {
  const { endpoint } = req.body || {};
  if (!endpoint) return res.status(400).json({ error: 'endpoint is required' });
  await db.run('DELETE FROM push_subscriptions WHERE endpoint=$1 AND user_id=$2', [endpoint, req.user.id]);
  res.json({ ok: true });
});

const BROADCAST_ROLES = ['all', 'admin', 'super_admin', 'host_member', 'media', 'transporter', 'driver'];

// Admin/super_admin only — send a manual notification to everyone, or to one
// or more specific roles. This is the "event announcements" tool.
router.post('/broadcast', requireAdminRole, async (req, res) => {
  const { title, body, url, roles } = req.body || {};
  if (!title || !title.trim()) return res.status(400).json({ error: 'title is required' });
  if (!push.PUSH_ENABLED) {
    return res.status(400).json({ error: 'Push notifications are not configured yet on the server (VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY env vars are missing). Nothing was sent.' });
  }
  const targetRoles = Array.isArray(roles) && roles.length ? roles : ['all'];
  for (const r of targetRoles) {
    if (!BROADCAST_ROLES.includes(r)) return res.status(400).json({ error: `Unknown role "${r}"` });
  }
  try {
    const result = await push.sendToRoles(
      targetRoles.includes('all') ? 'all' : targetRoles,
      { title: title.trim(), body: (body || '').trim(), url: url || 'login.html' }
    );
    res.json({ ok: true, sent: result.sent });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
