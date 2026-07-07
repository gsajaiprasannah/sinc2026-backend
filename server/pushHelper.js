// Web Push notifications (the "PWA push" feature) — a thin wrapper around
// the web-push library, entirely self-hosted (no Firebase/Google account
// needed). Requires three env vars to actually send anything:
//   VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY  — generate once with:
//     node -e "console.log(JSON.stringify(require('web-push').generateVAPIDKeys()))"
//   VAPID_SUBJECT — a mailto: address or https:// URL identifying who's sending
// Until those are set, every function below is a silent no-op (logged once)
// rather than crashing the server — so the rest of the app works fine before
// push is configured, and push just quietly does nothing.
const webpush = require('web-push');
const db = require('./db');

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || '';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@sinc2026.com';

const PUSH_ENABLED = Boolean(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY);
if (PUSH_ENABLED) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
} else {
  console.warn('Push notifications are not configured — set VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, and VAPID_SUBJECT to enable them. Everything else works fine without them.');
}

// Sends one payload to one subscription row, deleting it automatically if
// the push service reports it as gone (410/404 — the user uninstalled,
// cleared site data, or the subscription simply expired).
async function sendToSubscription(sub, payload) {
  try {
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      JSON.stringify(payload)
    );
    return true;
  } catch (err) {
    if (err.statusCode === 404 || err.statusCode === 410) {
      await db.run('DELETE FROM push_subscriptions WHERE id=$1', [sub.id]).catch(() => {});
    } else {
      console.error('Push send failed', sub.endpoint, err.statusCode || err.message);
    }
    return false;
  }
}

// payload: { title, body, url } — url is where the notification should take
// the user when clicked (relative path like 'login.html').
async function sendToUser(userId, payload) {
  if (!PUSH_ENABLED || !userId) return { sent: 0 };
  const subs = await db.all('SELECT * FROM push_subscriptions WHERE user_id=$1', [userId]);
  let sent = 0;
  for (const sub of subs) {
    if (await sendToSubscription(sub, payload)) sent++;
  }
  return { sent };
}

async function sendToUsers(userIds, payload) {
  if (!PUSH_ENABLED || !userIds || !userIds.length) return { sent: 0 };
  let sent = 0;
  for (const id of userIds) {
    const r = await sendToUser(id, payload);
    sent += r.sent;
  }
  return { sent };
}

// roles: array of role strings, or 'all' for every subscribed user.
async function sendToRoles(roles, payload) {
  if (!PUSH_ENABLED) return { sent: 0 };
  const rows = roles === 'all'
    ? await db.all('SELECT ps.* FROM push_subscriptions ps')
    : await db.all(
        `SELECT ps.* FROM push_subscriptions ps JOIN users u ON u.id = ps.user_id WHERE u.role = ANY($1::text[])`,
        [roles]
      );
  let sent = 0;
  for (const sub of rows) {
    if (await sendToSubscription(sub, payload)) sent++;
  }
  return { sent };
}

module.exports = { PUSH_ENABLED, VAPID_PUBLIC_KEY, sendToUser, sendToUsers, sendToRoles };
