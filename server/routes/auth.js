const express = require('express');
const db = require('../db');
const { hashPassword, verifyPassword, signToken, requireAuth, requireSuperAdmin } = require('../auth');
const { logActivity } = require('../lib/activityLogger');

const router = express.Router();

function publicUser(u) {
  return {
    id: u.id, username: u.username, email: u.email, role: u.role, status: u.status,
    created_at: u.created_at, approved_at: u.approved_at,
    host_member_id: u.host_member_id, driver_id: u.driver_id, partner_id: u.partner_id, volunteer_id: u.volunteer_id
  };
}

// Roles that need a linked profile record, and which column/table each uses.
// 'media' has no linked record — it's a scope, not a specific person.
const LINKED_ROLE_FIELDS = {
  host_member: { column: 'host_member_id', table: 'host_members', label: 'host member' },
  driver: { column: 'driver_id', table: 'drivers', label: 'driver' },
  transporter: { column: 'partner_id', table: 'partners', label: 'transport partner' },
  volunteer: { column: 'volunteer_id', table: 'volunteers', label: 'volunteer' }
};
const ALL_ROLES = ['super_admin', 'admin', 'host_member', 'media', 'transporter', 'driver', 'volunteer'];

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
    SELECT u.*, hm.name AS host_member_name, dr.name AS driver_name, pt.name AS partner_name, vo.name AS volunteer_name
    FROM users u
    LEFT JOIN host_members hm ON hm.id = u.host_member_id
    LEFT JOIN drivers dr ON dr.id = u.driver_id
    LEFT JOIN partners pt ON pt.id = u.partner_id
    LEFT JOIN volunteers vo ON vo.id = u.volunteer_id
    ORDER BY (u.status='pending') DESC, u.created_at DESC
  `);
  res.json(rows.map((u) => ({ ...publicUser(u), host_member_name: u.host_member_name, driver_name: u.driver_name, partner_name: u.partner_name, volunteer_name: u.volunteer_name })));
});

// "Generate a login" — directly create an already-approved account.
// role can be 'admin', 'super_admin', 'host_member', 'media', 'transporter',
// 'driver', or 'volunteer'. host_member/driver/transporter/volunteer logins
// must also supply the matching linked-record id (LINKED_ROLE_FIELDS above)
// so the account is scoped to that specific person/company — 'media' has no
// linked record, it's just a restricted-scope role.
router.post('/users', requireSuperAdmin, async (req, res) => {
  const { username, email, password, role, host_member_id, driver_id, partner_id, volunteer_id } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password are required.' });
  if (String(password).length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  const finalRole = ALL_ROLES.includes(role) ? role : 'admin';
  const linked = LINKED_ROLE_FIELDS[finalRole];
  const linkedValues = { host_member_id: host_member_id || null, driver_id: driver_id || null, partner_id: partner_id || null, volunteer_id: volunteer_id || null };
  if (linked && !linkedValues[linked.column]) {
    return res.status(400).json({ error: `Choose which ${linked.label} this login belongs to.` });
  }
  try {
    const existing = await db.get('SELECT id FROM users WHERE lower(username)=lower($1)', [username.trim()]);
    if (existing) return res.status(409).json({ error: 'That username already exists.' });
    const hash = await hashPassword(password);
    const result = await db.run(
      `INSERT INTO users (username, email, password_hash, role, status, approved_at, approved_by, host_member_id, driver_id, partner_id, volunteer_id)
       VALUES ($1,$2,$3,$4,'approved',NOW(),$5,$6,$7,$8,$9) RETURNING id`,
      [username.trim(), (email || '').trim(), hash, finalRole, req.user.id,
        linked?.column === 'host_member_id' ? linkedValues.host_member_id : null,
        linked?.column === 'driver_id' ? linkedValues.driver_id : null,
        linked?.column === 'partner_id' ? linkedValues.partner_id : null,
        linked?.column === 'volunteer_id' ? linkedValues.volunteer_id : null]
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
  const { role, status, host_member_id, driver_id, partner_id } = req.body;
  try {
    await db.run(
      `UPDATE users SET role=COALESCE($1,role), status=COALESCE($2,status),
        host_member_id=COALESCE($3,host_member_id), driver_id=COALESCE($4,driver_id), partner_id=COALESCE($5,partner_id)
       WHERE id=$6`,
      [role || null, status || null, host_member_id || null, driver_id || null, partner_id || null, req.params.id]
    );
    logActivity(req.user, { action: 'update', entityType: 'user', entityId: Number(req.params.id), details: `role: ${role || '—'}, status: ${status || '—'}` });
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
