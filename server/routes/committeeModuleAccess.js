// Per-committee module access — lets an admin grant a committee's own
// members direct access to specific operational modules (Vehicles, Sponsors,
// Hotels & Rooms, etc.) from their own host portal, instead of relaying
// every change through an admin. Each module is exposed a second time under
// /api/portal-modules/<mount>, reusing the exact same route handlers as the
// admin panel (server/routes/vehicles.js, sponsors.js, ...) — only the guard
// in front of them differs. Deletes stay blocked regardless: the global
// "DELETE requires super_admin" middleware in server/index.js runs before
// these mounts are ever reached, same as everywhere else in the app.
const db = require('../db');
const { requireAuth } = require('../auth');

// module_key -> { label, mounts: [{ path, router }] }. Two module_keys
// (transport_partners, accommodation) gate two separate admin routers each,
// since Partners & Drivers / Hotels & Rooms are one admin tab covering two
// underlying tables/routers.
const MODULE_KEYS = [
  { key: 'transport_partners', label: 'Partners & Drivers' },
  { key: 'vehicles', label: 'Vehicles' },
  { key: 'transport_planning', label: 'Transport Planning' },
  { key: 'pretours', label: 'Pre Tours' },
  { key: 'accommodation', label: 'Accommodation & Rooms' },
  { key: 'inventory', label: 'Goodies & Inventory' },
  { key: 'sponsors', label: 'Sponsors' },
  { key: 'speakers', label: 'Guest Speakers' },
  { key: 'guestvisitors', label: 'Guest Visitors' },
  { key: 'media', label: 'Media (Video/Poster)' },
  { key: 'happenings', label: 'Live Happenings' },
  { key: 'itinerary', label: 'Itinerary' },
  { key: 'participants', label: 'Delegate Registrations' }
];
const MODULE_KEY_SET = new Set(MODULE_KEYS.map((m) => m.key));

function isValidModuleKey(key) {
  return MODULE_KEY_SET.has(key);
}

// Express middleware factory — gates a mounted router on whether the
// logged-in host member belongs to a committee that's been granted
// moduleKey. Admins/super_admins pass straight through (they already have
// full access via the regular admin-only mount of the same router).
function requireModuleAccess(moduleKey) {
  return function (req, res, next) {
    requireAuth(req, res, async () => {
      if (['admin', 'super_admin'].includes(req.user.role)) return next();
      if (req.user.role !== 'host_member') {
        return res.status(403).json({ error: 'This module is only available to host members via their committee.' });
      }
      try {
        const row = await db.get(
          `SELECT 1 AS ok FROM users u
           JOIN committee_members cm ON cm.host_member_id = u.host_member_id
           JOIN committee_module_access cma ON cma.committee_id = cm.committee_id AND cma.module_key = $2
           WHERE u.id = $1 LIMIT 1`,
          [req.user.id, moduleKey]
        );
        if (!row) return res.status(403).json({ error: 'Your committee does not have access to this module.' });
        next();
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });
  };
}

// All module_keys granted to any committee a given host member belongs to —
// used by the host portal to know which "My Modules" nav items to show.
async function grantedModulesForHostMember(hostMemberId) {
  const rows = await db.all(
    `SELECT DISTINCT cma.module_key
     FROM committee_members cm
     JOIN committee_module_access cma ON cma.committee_id = cm.committee_id
     WHERE cm.host_member_id = $1`,
    [hostMemberId]
  );
  return rows.map((r) => r.module_key);
}

module.exports = { MODULE_KEYS, isValidModuleKey, requireModuleAccess, grantedModulesForHostMember };
