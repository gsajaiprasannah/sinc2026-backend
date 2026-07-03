const express = require('express');
const db = require('../db');
const { hashPassword, verifyPassword, signToken, requireAuth, requireSuperAdmin } = require('../auth');

const router = express.Router();

function publicUser(u) {
  return { id: u.id, username: u.username, email: u.email, role: u.role, status: u.status, created_at: u.created_at, approved_at: u.approved_at };
}

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
    if (!user) return res.status(401).json({ error: 'Invalid username or password.' });
    if (user.status === 'pending') return res.status(403).json({ error: 'Your account is awaiting admin approval.' });
    if (user.status !== 'approved') return res.status(403).json({ error: 'This account is not active. Contact a super admin.' });
    const ok = await verifyPassword(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Invalid username or password.' });
    const token = signToken(user);
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
  const rows = await db.all(`SELECT * FROM users ORDER BY (status='pending') DESC, created_at DESC`);
  res.json(rows.map(publicUser));
});

// "Generate a login" — directly create an already-approved account.
router.post('/users', requireSuperAdmin, async (req, res) => {
  const { username, email, password, role } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password are required.' });
  if (String(password).length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  try {
    const existing = await db.get('SELECT id FROM users WHERE lower(username)=lower($1)', [username.trim()]);
    if (existing) return res.status(409).json({ error: 'That username already exists.' });
    const hash = await hashPassword(password);
    const result = await db.run(
      `INSERT INTO users (username, email, password_hash, role, status, approved_at, approved_by)
       VALUES ($1,$2,$3,$4,'approved',NOW(),$5) RETURNING id`,
      [username.trim(), (email || '').trim(), hash, role === 'super_admin' ? 'super_admin' : 'admin', req.user.id]
    );
    res.json({ id: result.id });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.put('/users/:id/approve', requireSuperAdmin, async (req, res) => {
  await db.run(`UPDATE users SET status='approved', approved_at=NOW(), approved_by=$1 WHERE id=$2`, [req.user.id, req.params.id]);
  res.json({ ok: true });
});

router.put('/users/:id/reject', requireSuperAdmin, async (req, res) => {
  await db.run(`UPDATE users SET status='rejected' WHERE id=$1`, [req.params.id]);
  res.json({ ok: true });
});

router.put('/users/:id', requireSuperAdmin, async (req, res) => {
  const { role, status } = req.body;
  try {
    await db.run(
      `UPDATE users SET role=COALESCE($1,role), status=COALESCE($2,status) WHERE id=$3`,
      [role || null, status || null, req.params.id]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.delete('/users/:id', requireSuperAdmin, async (req, res) => {
  if (Number(req.params.id) === Number(req.user.id)) {
    return res.status(400).json({ error: "You can't delete your own account." });
  }
  await db.run('DELETE FROM users WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

module.exports = router;
