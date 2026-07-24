const express = require('express');
const db = require('../db');
const { hashPassword, verifyPassword, signToken, requireAuth, requireSuperAdmin } = require('../auth');
const { logActivity } = require('../lib/activityLogger');

const router = express.Router();

const SCAN_POINTS = ['hotel_desk', 'transport', 'food_counter', 'inventory', 'registration'];

function publicUser(u) {
  return {
    id: u.id, username: u.username, email: u.email, role: u.role, status: u.status,
    created_at: u.created_at, approved_at: u.approved_at,
    host_member_id: u.host_member_id, driver_id: u.driver_id, partner_id: u.partner_id, volunteer_id: u.volunteer_id,
    vendor_id: u.vendor_id, stall_id: u.stall_id,
    // scan_point: an extra QR-badge-scanning duty grant independent of role
    // (see db.js's "QR badge multi-point scanning" migration comment).
    // vehicle_id: which vehicle this login scans boarding passengers for
    // today — set via PUT /users/:id/vehicle below, same idea as scan_point.
    scan_point: u.scan_point || null, vehicle_id: u.vehicle_id || null
  };
}

// Roles that need a linked profile record, and which column/table each uses.
// 'media' has no linked record — it's a scope, not a specific person.
const LINKED_ROLE_FIELDS = {
  host_member: { column: 'host_member_id', table: 'host_members', label: 'host member' },
  driver: { column: 'driver_id', table: 'drivers', label: 'driver' },
  transporter: { column: 'partner_id', table: 'partners', label: 'transport partner' },
  volunteer: { column: 'volunteer_id', table: 'volunteers', label: 'volunteer' },
  vendor: { column: 'vendor_id', table: 'vendors', label: 'vendor' },
  // A stall_owner's login represents one exhibitor booking (stall_bookings
  // row) — scanning a visitor's badge at their stall logs that visitor
  // against this stall_id (see /staff/:token/stall-visit in badge.js).
  stall_owner: { column: 'stall_id', table: 'stall_bookings', label: 'stall' }
};
// 'scanner': a dedicated scan-duty-only login (Hotel Desk/Transport/Food
// Counter/Goodies/Registration) with no linked profile record — same
// no-linked-record pattern as 'media', just for badge-scanning staff instead
// of the design team. Which station it covers lives entirely in scan_point.
const ALL_ROLES = ['super_admin', 'admin', 'host_member', 'media', 'transporter', 'driver', 'volunteer', 'vendor', 'stall_owner', 'scanner'];

// --- Self-service signup: creates a PENDING account. Cannot log in until a ---
// --- super admin approves it from the Settings panel.                     ---
router.post('/signup', async (req, res) => {
  const { username, email, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password are required.' });
  if (String(password).length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  try {
    const existing = await db.get('SELECT id FROM users WHERE lower(username)=lower($1)', [username.trim()]);
    if (existing) return res.status(409).json({ error: 'That username is already taken or already pending approval.' });
    const hash = await hashPassword(password);
    await db.run(
      `INSERT INTO users (username, email, password_hash, role, status) VALUES ($1,$2,$3,'admin','pending')`,
      [username.trim(), (email || '').trim(), hash]
    );
    logActivity(null, { action: 'signup_requested', entityType: 'user', label: username.trim(), username: username.trim() });
    res.json({ ok: true, message: 'Signup request submitted. An admin needs to approve your account before you can log in.' });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password are required.' });
  try {
    const user = await db.get('SELECT * FROM users WHERE lower(username)=lower($1)', [username.trim()]);
    if (!user) {
      logActivity(null, { action: 'login_failed', entityType: 'user', label: username.trim(), details: 'Unknown username', username: username.trim() });
      return res.status(401).json({ error: 'Invalid username or password.' });
    }
    if (user.status === 'pending') return res.status(403).json({ error: 'Your account is awaiting admin approval.' });
    if (user.status !== 'approved') return res.status(403).json({ error: 'This account is not active. Contact a super admin.' });
    const ok = await verifyPassword(password, user.password_hash);
    if (!ok) {
      logActivity(user, { action: 'login_failed', entityType: 'user', entityId: user.id, label: user.username, details: 'Wrong password' });
      return res.status(401).json({ error: 'Invalid username or password.' });
    }
    const token = signToken(user);
    logActivity(user, { action: 'login', entityType: 'user', entityId: user.id, label: user.username });
    res.json({ token, user: publicUser(user) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/me', requireAuth, async (req, res) => {
  const user = await db.get('SELECT * FROM users WHERE id=$1', [req.user.id]);
  if (!user) return res.status(404).json({ error: 'Account no longer exists.' });
  res.json(publicUser(user));
});

router.put('/me/password', requireAuth, async (req, res) => {
  const { current_password, new_password } = req.body;
  if (!new_password || String(new_password).length < 6) {
    return res.status(400).json({ error: 'New password must be at least 6 characters.' });
  }
  const user = await db.get('SELECT * FROM users WHERE id=$1', [req.user.id]);
  if (!user) return res.status(404).json({ error: 'Account no longer exists.' });
  const ok = await verifyPassword(current_password || '', user.password_hash);
  if (!ok) return res.status(401).json({ error: 'Current password is incorrect.' });
  const hash = await hashPassword(new_password);
  await db.run('UPDATE users SET password_hash=$1 WHERE id=$2', [hash, user.id]);
  res.json({ ok: true });
});

// --- Settings panel: user management — super_admin only ---
router.get('/users', requireSuperAdmin, async (req, res) => {
  const rows = await db.all(`
    SELECT u.*, hm.name AS host_member_name, dr.name AS driver_name, pt.name AS partner_name, vo.name AS volunteer_name, ve.name AS vendor_name,
      sb.company_name AS stall_company_name, vh.vehicle_code
    FROM users u
    LEFT JOIN host_members hm ON hm.id = u.host_member_id
    LEFT JOIN drivers dr ON dr.id = u.driver_id
    LEFT JOIN partners pt ON pt.id = u.partner_id
    LEFT JOIN volunteers vo ON vo.id = u.volunteer_id
    LEFT JOIN vendors ve ON ve.id = u.vendor_id
    LEFT JOIN stall_bookings sb ON sb.id = u.stall_id
    LEFT JOIN vehicles vh ON vh.id = u.vehicle_id
    ORDER BY (u.status='pending') DESC, u.created_at DESC
  `);
  res.json(rows.map((u) => ({
    ...publicUser(u), host_member_name: u.host_member_name, driver_name: u.driver_name, partner_name: u.partner_name,
    volunteer_name: u.volunteer_name, vendor_name: u.vendor_name, stall_company_name: u.stall_company_name, vehicle_code: u.vehicle_code
  })));
});

// "Generate a login" — directly create an already-approved account.
// role can be 'admin', 'super_admin', 'host_member', 'media', 'transporter',
// 'driver', or 'volunteer'. host_member/driver/transporter/volunteer logins
// must also supply the matching linked-record id (LINKED_ROLE_FIELDS above)
// so the account is scoped to that specific person/company — 'media' has no
// linked record, it's just a restricted-scope role.
router.post('/users', requireSuperAdmin, async (req, res) => {
  const { username, email, password, role, host_member_id, driver_id, partner_id, volunteer_id, vendor_id, stall_id, scan_point } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password are required.' });
  if (String(password).length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  const finalRole = ALL_ROLES.includes(role) ? role : 'admin';
  const linked = LINKED_ROLE_FIELDS[finalRole];
  const linkedValues = { host_member_id: host_member_id || null, driver_id: driver_id || null, partner_id: partner_id || null, volunteer_id: volunteer_id || null, vendor_id: vendor_id || null, stall_id: stall_id || null };
  if (linked && !linkedValues[linked.column]) {
    return res.status(400).json({ error: `Choose which ${linked.label} this login belongs to.` });
  }
  // scan_point is an extra QR-badge-scanning duty grant, settable regardless
  // of role (a host_member or volunteer login can be deputised for hotel
  // desk / transport / food counter / inventory duty without changing their
  // base role) — see db.js's "QR badge multi-point scanning" migration.
  const finalScanPoint = SCAN_POINTS.includes(scan_point) ? scan_point : null;
  try {
    const existing = await db.get('SELECT id FROM users WHERE lower(username)=lower($1)', [username.trim()]);
    if (existing) return res.status(409).json({ error: 'That username already exists.' });
    const hash = await hashPassword(password);
    const result = await db.run(
      `INSERT INTO users (username, email, password_hash, role, status, approved_at, approved_by, host_member_id, driver_id, partner_id, volunteer_id, vendor_id, stall_id, scan_point)
       VALUES ($1,$2,$3,$4,'approved',NOW(),$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
      [username.trim(), (email || '').trim(), hash, finalRole, req.user.id,
        linked?.column === 'host_member_id' ? linkedValues.host_member_id : null,
        linked?.column === 'driver_id' ? linkedValues.driver_id : null,
        linked?.column === 'partner_id' ? linkedValues.partner_id : null,
        linked?.column === 'volunteer_id' ? linkedValues.volunteer_id : null,
        linked?.column === 'vendor_id' ? linkedValues.vendor_id : null,
        linked?.column === 'stall_id' ? linkedValues.stall_id : null,
        finalScanPoint]
    );
    logActivity(req.user, { action: 'create', entityType: 'user', entityId: result.id, label: username.trim(), details: `role: ${finalRole}` });
    res.json({ id: result.id });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Bulk-create host-member logins in one click: username = their 10-digit
// mobile number, password = a common default they can change after their
// first login. Skips anyone with no/invalid phone on file or who already
// has a login, and reports exactly why each one was skipped.
router.post('/users/bulk-create-host-logins', requireSuperAdmin, async (req, res) => {
  const DEFAULT_PASSWORD = 'pass123';
  try {
    const members = await db.all(`
      SELECT hm.id, hm.name, hm.phone,
        (SELECT u.id FROM users u WHERE u.host_member_id = hm.id LIMIT 1) AS existing_user_id
      FROM host_members hm
      ORDER BY hm.name
    `);
    const hash = await hashPassword(DEFAULT_PASSWORD);
    const created = [];
    const skipped = [];
    for (const m of members) {
      if (m.existing_user_id) { skipped.push({ name: m.name, reason: 'already has a login' }); continue; }
      const digits = (m.phone || '').replace(/\D/g, '').slice(-10);
      if (digits.length !== 10) { skipped.push({ name: m.name, reason: 'no valid 10-digit mobile number on file' }); continue; }
      const existingUsername = await db.get('SELECT id FROM users WHERE username=$1', [digits]);
      if (existingUsername) { skipped.push({ name: m.name, reason: `username ${digits} is already taken by another login` }); continue; }
      try {
        await db.run(
          `INSERT INTO users (username, password_hash, role, status, approved_at, approved_by, host_member_id)
           VALUES ($1,$2,'host_member','approved',NOW(),$3,$4)`,
          [digits, hash, req.user.id, m.id]
        );
        created.push({ name: m.name, username: digits });
      } catch (e) {
        skipped.push({ name: m.name, reason: e.message });
      }
    }
    if (created.length) {
      logActivity(req.user, { action: 'bulk_create', entityType: 'user', label: `${created.length} host-member login(s)`, details: created.map((c) => c.username).join(', ') });
    }
    res.json({ created, skipped, default_password: DEFAULT_PASSWORD });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// One-click "make pass123 true for everyone": creates a login for any host
// member who still doesn't have one (same as bulk-create-host-logins above)
// AND resets every EXISTING host-member login's password to the same
// default — including anyone who already changed theirs. This exists
// specifically so a credentials newsletter can promise "your password is
// pass123" and have that be true for the entire audience at send time, not
// just for the members who never logged in yet. Deliberately blunt: it does
// not ask who to skip, so use it right before a credentials blast, not as a
// routine maintenance action.
router.post('/users/bulk-reset-host-passwords', requireSuperAdmin, async (req, res) => {
  const DEFAULT_PASSWORD = 'pass123';
  try {
    const members = await db.all(`
      SELECT hm.id, hm.name, hm.phone,
        (SELECT u.id FROM users u WHERE u.host_member_id = hm.id LIMIT 1) AS existing_user_id
      FROM host_members hm
      ORDER BY hm.name
    `);
    const hash = await hashPassword(DEFAULT_PASSWORD);
    const created = [];
    const reset = [];
    const skipped = [];
    for (const m of members) {
      if (m.existing_user_id) {
        await db.run('UPDATE users SET password_hash=$1 WHERE id=$2', [hash, m.existing_user_id]);
        reset.push({ name: m.name });
        continue;
      }
      const digits = (m.phone || '').replace(/\D/g, '').slice(-10);
      if (digits.length !== 10) { skipped.push({ name: m.name, reason: 'no valid 10-digit mobile number on file' }); continue; }
      const existingUsername = await db.get('SELECT id FROM users WHERE username=$1', [digits]);
      if (existingUsername) { skipped.push({ name: m.name, reason: `username ${digits} is already taken by another login` }); continue; }
      try {
        await db.run(
          `INSERT INTO users (username, password_hash, role, status, approved_at, approved_by, host_member_id)
           VALUES ($1,$2,'host_member','approved',NOW(),$3,$4)`,
          [digits, hash, req.user.id, m.id]
        );
        created.push({ name: m.name, username: digits });
      } catch (e) {
        skipped.push({ name: m.name, reason: e.message });
      }
    }
    if (created.length || reset.length) {
      logActivity(req.user, {
        action: 'bulk_reset_password', entityType: 'user',
        label: `${created.length} new + ${reset.length} reset host-member login(s) to default password`,
        details: [...created.map((c) => `${c.name} (new: ${c.username})`), ...reset.map((r) => `${r.name} (reset)`)].join(', ')
      });
    }
    res.json({ created, reset, skipped, default_password: DEFAULT_PASSWORD });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/users/:id/approve', requireSuperAdmin, async (req, res) => {
  await db.run(`UPDATE users SET status='approved', approved_at=NOW(), approved_by=$1 WHERE id=$2`, [req.user.id, req.params.id]);
  logActivity(req.user, { action: 'approve', entityType: 'user', entityId: Number(req.params.id) });
  res.json({ ok: true });
});

router.put('/users/:id/reject', requireSuperAdmin, async (req, res) => {
  await db.run(`UPDATE users SET status='rejected' WHERE id=$1`, [req.params.id]);
  logActivity(req.user, { action: 'reject', entityType: 'user', entityId: Number(req.params.id) });
  res.json({ ok: true });
});

router.put('/users/:id', requireSuperAdmin, async (req, res) => {
  const { role, status, host_member_id, driver_id, partner_id, volunteer_id, vendor_id, stall_id, scan_point } = req.body;
  // scan_point can be changed independently of (or alongside) a role change —
  // '' clears it back to none. Not part of the role-linked-column reset
  // below since it isn't tied to any one role.
  const scanPointProvided = scan_point !== undefined;
  const finalScanPoint = scanPointProvided ? (SCAN_POINTS.includes(scan_point) ? scan_point : null) : undefined;
  try {
    if (role !== undefined && role !== null && role !== '') {
      if (!ALL_ROLES.includes(role)) return res.status(400).json({ error: 'Not a recognized role.' });
      const linked = LINKED_ROLE_FIELDS[role];
      const linkedValues = { host_member_id: host_member_id || null, driver_id: driver_id || null, partner_id: partner_id || null, volunteer_id: volunteer_id || null, vendor_id: vendor_id || null, stall_id: stall_id || null };
      if (linked && !linkedValues[linked.column]) {
        return res.status(400).json({ error: `Choose which ${linked.label} this login belongs to.` });
      }
      // Switching roles: only the column matching the NEW role keeps a value —
      // every other linked column is explicitly cleared so a stale id from a
      // previous role (e.g. host_member_id lingering after switching to media)
      // can never leak through. COALESCE can't express "clear this", it only
      // ever preserves the old value, so a role change uses plain assignment
      // instead of COALESCE for all linked columns.
      await db.run(
        `UPDATE users SET role=$1, status=COALESCE($2,status),
          host_member_id=$3, driver_id=$4, partner_id=$5, volunteer_id=$6, vendor_id=$7, stall_id=$8,
          scan_point=COALESCE($9, scan_point)
         WHERE id=$10`,
        [role, status || null,
          linked?.column === 'host_member_id' ? linkedValues.host_member_id : null,
          linked?.column === 'driver_id' ? linkedValues.driver_id : null,
          linked?.column === 'partner_id' ? linkedValues.partner_id : null,
          linked?.column === 'volunteer_id' ? linkedValues.volunteer_id : null,
          linked?.column === 'vendor_id' ? linkedValues.vendor_id : null,
          linked?.column === 'stall_id' ? linkedValues.stall_id : null,
          scanPointProvided ? finalScanPoint : null,
          req.params.id]
      );
      // COALESCE($9, scan_point) means an explicit "clear it" (null) can't be
      // distinguished from "not provided" — if scan_point was explicitly sent
      // as '' (clear), run a second pass to actually null it out.
      if (scanPointProvided && finalScanPoint === null) {
        await db.run(`UPDATE users SET scan_point=NULL WHERE id=$1`, [req.params.id]);
      }
    } else {
      // No role change requested (e.g. approving/suspending, or just changing
      // scan_point) — leave every linked column untouched.
      await db.run(`UPDATE users SET status=COALESCE($1,status) WHERE id=$2`, [status || null, req.params.id]);
      if (scanPointProvided) {
        await db.run(`UPDATE users SET scan_point=$1 WHERE id=$2`, [finalScanPoint, req.params.id]);
      }
    }
    logActivity(req.user, { action: 'update', entityType: 'user', entityId: Number(req.params.id), details: `role: ${role || '—'}, status: ${status || '—'}` });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Which vehicle a driver/transporter login is scanning boarding passengers
// for today — independent of the drivers/partners master data, so it can be
// changed day to day without editing the driver's/partner's own profile.
// Used by the transport-scan badge endpoint to flag "wrong vehicle".
router.put('/users/:id/vehicle', requireSuperAdmin, async (req, res) => {
  const { vehicle_id } = req.body;
  try {
    await db.run('UPDATE users SET vehicle_id=$1 WHERE id=$2', [vehicle_id || null, req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Forgot-password recovery: a super admin can set a brand-new password for
// ANY login (regular admin, host member, media, transporter, driver) without
// needing to know the old one — unlike PUT /me/password above, which is
// self-service and always requires the current password. This is the path
// for "I forgot my password" support requests.
router.put('/users/:id/reset-password', requireSuperAdmin, async (req, res) => {
  const { new_password } = req.body;
  if (!new_password || String(new_password).length < 6) {
    return res.status(400).json({ error: 'New password must be at least 6 characters.' });
  }
  try {
    const user = await db.get('SELECT id, username FROM users WHERE id=$1', [req.params.id]);
    if (!user) return res.status(404).json({ error: 'Login not found.' });
    const hash = await hashPassword(new_password);
    await db.run('UPDATE users SET password_hash=$1 WHERE id=$2', [hash, req.params.id]);
    logActivity(req.user, { action: 'reset_password', entityType: 'user', entityId: Number(req.params.id), label: user.username });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.delete('/users/:id', requireSuperAdmin, async (req, res) => {
  if (Number(req.params.id) === Number(req.user.id)) {
    return res.status(400).json({ error: "You can't delete your own account." });
  }
  const target = await db.get('SELECT username FROM users WHERE id=$1', [req.params.id]);
  await db.run('DELETE FROM users WHERE id=$1', [req.params.id]);
  logActivity(req.user, { action: 'delete', entityType: 'user', entityId: Number(req.params.id), label: target?.username });
  res.json({ ok: true });
});

module.exports = router;