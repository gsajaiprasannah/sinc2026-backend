// Self-service endpoint for a logged-in volunteer — deliberately tiny.
// Unlike host.js (which covers committees, delegate assignments, guest
// relations, goodies checklists, etc.), a volunteer has none of that: just
// their own basic profile and whichever modules they've been directly
// granted (see committeeModuleAccess.js's grantedModulesForVolunteer()).
// Mounted at /api/volunteer (singular) with plain requireAuth — the role
// check happens here, same split as /api/host vs /api/hostmembers.
const express = require('express');
const db = require('../db');
const { requireAuth } = require('../auth');
const { grantedModulesForVolunteer } = require('./committeeModuleAccess');

const router = express.Router();

router.get('/me', requireAuth, async (req, res) => {
  if (req.user.role !== 'volunteer') {
    return res.status(403).json({ error: 'This login is not a volunteer account.' });
  }
  try {
    const row = await db.get('SELECT volunteer_id FROM users WHERE id=$1', [req.user.id]);
    const volunteerId = row ? row.volunteer_id : null;
    if (!volunteerId) {
      return res.status(404).json({ error: 'This login is not yet linked to a volunteer profile. Ask an admin to link it from the Volunteers tab.' });
    }
    const profile = await db.get('SELECT * FROM volunteers WHERE id=$1', [volunteerId]);
    const moduleAccess = await grantedModulesForVolunteer(volunteerId);
    res.json({ profile, moduleAccess });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
