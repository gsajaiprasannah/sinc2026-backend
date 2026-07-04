// Multi-user admin authentication: password hashing + JWT sessions.
//
// Set JWT_SECRET in your environment before going live — a long random
// string (e.g. `openssl rand -hex 32`). Without it, a weak default is used
// and a warning is logged, so it's obvious this must be changed.
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'sinc2026-insecure-dev-secret-change-me';
if (!process.env.JWT_SECRET) {
  console.warn('JWT_SECRET is not set — using an insecure default. Set JWT_SECRET in your environment before going live.');
}
const TOKEN_TTL = '30d';

async function hashPassword(password) {
  return bcrypt.hash(password, 10);
}

async function verifyPassword(password, hash) {
  return bcrypt.compare(password, hash);
}

function signToken(user) {
  return jwt.sign({ id: user.id, username: user.username, role: user.role }, JWT_SECRET, { expiresIn: TOKEN_TTL });
}

function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

// Requires a valid Bearer token. Attaches { id, username, role } to req.user.
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ error: 'Login required.' });
  }
  try {
    req.user = verifyToken(token);
    return next();
  } catch (e) {
    return res.status(401).json({ error: 'Session expired or invalid — please log in again.' });
  }
}

// Requires a valid Bearer token AND role === 'super_admin'.
function requireSuperAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role !== 'super_admin') {
      return res.status(403).json({ error: 'Only a super admin can do this.' });
    }
    next();
  });
}

// Requires a valid Bearer token AND role in ('admin','super_admin') — used to
// lock the congress dashboard (clubs/stats/media/happenings/itinerary) down
// to admin accounts only, rejecting host_member (and any future restricted
// role) even though their token is otherwise valid.
function requireAdminRole(req, res, next) {
  requireAuth(req, res, () => {
    if (!['admin', 'super_admin'].includes(req.user.role)) {
      return res.status(403).json({ error: 'This dashboard is for admin accounts only.' });
    }
    next();
  });
}

module.exports = { hashPassword, verifyPassword, signToken, verifyToken, requireAuth, requireSuperAdmin, requireAdminRole };
