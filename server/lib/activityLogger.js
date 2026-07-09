// Shared helper for writing to the activity_log audit trail. Every route
// that creates/updates/deletes a record, plus login, calls this so a super
// admin can see who did what, when, from one place (Activity Log admin tab).
//
// Deliberately fire-and-forget-safe: logging failures are swallowed (logged
// to console only) so a problem writing an audit row never breaks the actual
// user-facing action it's describing.
const db = require('../db');

// user can be a full req.user ({id, username, role}) or null (e.g. a failed
// login attempt with no authenticated user yet — pass username manually via
// opts.username in that case).
async function logActivity(user, { action, entityType = null, entityId = null, label = null, details = null, username = null } = {}) {
  try {
    await db.run(
      `INSERT INTO activity_log (user_id, username, role, action, entity_type, entity_id, label, details)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        user?.id || null,
        user?.username || username || null,
        user?.role || null,
        action,
        entityType,
        entityId || null,
        label,
        details
      ]
    );
  } catch (e) {
    console.error('activity_log write failed (non-fatal):', e.message);
  }
}

module.exports = { logActivity };
