const express = require('express');
const db = require('../db');

const router = express.Router();

// Public, read-only, deliberately narrow views of sponsors/speakers for the
// homepage (index.html). The full /api/sponsors and /api/speakers routes
// stay admin-only — they carry phone/email/notes and other internal fields
// that should never be exposed without a login. This route hand-picks only
// what's safe to show the public: name, logo/photo, tier/topic — nothing
// else. Cancelled entries are excluded; everything else (confirmed, or a
// sponsor still a "lead") is shown so admins don't have to flip a separate
// "publish" flag just to get someone to appear.
router.get('/sponsors', async (req, res) => {
  try {
    const rows = await db.all(`
      SELECT id, name, tier, logo_url
      FROM sponsors
      WHERE status <> 'cancelled'
      ORDER BY
        CASE lower(tier)
          WHEN 'platinum' THEN 0 WHEN 'gold' THEN 1 WHEN 'silver' THEN 2 WHEN 'bronze' THEN 3
          ELSE 4
        END,
        name ASC
    `);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/speakers', async (req, res) => {
  try {
    const rows = await db.all(`
      SELECT id, name, designation, organization, topic, session_type, photo_url
      FROM speakers
      WHERE status <> 'cancelled'
      ORDER BY name ASC
    `);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
