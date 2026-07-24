const express = require('express');
const db = require('../db');
const { requireAdminRole } = require('../auth');

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const limit = Number(req.query.limit) || 100;
    const rows = await db.all('SELECT * FROM happenings ORDER BY happened_at DESC LIMIT $1', [limit]);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// This router is mounted at /api/happenings with only a blanket "any
// logged-in user" gate in server/index.js (GET stays public for the
// homepage's Live Happenings feed; the global mutating-methods gate just
// requires *a* valid token, not a specific role) — meaning any otherwise-
// valid login (scanner, driver, transporter, vendor, stall_owner, etc, none
// of which have any legitimate reason to post a public announcement) could
// post to the public feed. No self-service role posts happenings by design,
// so this stays admin/super_admin only.
router.post('/', requireAdminRole, async (req, res) => {
  const { title, description, category, posted_by } = req.body;
  if (!title) return res.status(400).json({ error: 'title is required' });
  try {
    const result = await db.run(
      'INSERT INTO happenings (title, description, category, posted_by) VALUES ($1,$2,$3,$4) RETURNING id',
      [title, description || '', category || 'general', posted_by || 'Admin']
    );
    res.json({ id: result.id });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.delete('/:id', async (req, res) => {
  await db.run('DELETE FROM happenings WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

module.exports = router;