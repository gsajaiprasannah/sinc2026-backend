// Event Attendance: who actually showed up to each congress itinerary slot
// ("Day 2, 9:00 AM, Inaugural Ceremony", etc), taken by scanning a delegate/
// host member's QR badge at the registration desk. Deliberately keyed on
// itinerary_item_id (the SAME table the Itinerary module edits) rather than
// a separate hardcoded list of "sessions" — so renaming/retiming a slot, or
// adding a brand-new one, is picked up by the scanner's dropdown immediately
// (see server/routes/badge.js's GET /itinerary-events), with nothing here to
// keep in sync by hand.
//
// The actual marking happens via the badge scanner (badge.js's
// POST /staff/:token/attendance-scan, gated by scan_point='registration');
// this file is the report/management side — the list of events with present
// counts, the per-event attendee list, and a manual mark/unmark for
// corrections (someone whose badge wouldn't scan, a mistaken tap, etc).
const express = require('express');
const db = require('../db');
const { logActivity } = require('../lib/activityLogger');

const router = express.Router();

// Every itinerary slot, with how many delegates/host members have been
// marked present so far, plus the two "out of how many" totals needed to
// show a percentage — computed once here rather than making the client
// fetch /participants and /hostmembers separately just to get a count.
router.get('/', async (req, res) => {
  try {
    const totals = await db.get(`
      SELECT
        (SELECT COUNT(*)::int FROM participants) AS total_delegates,
        (SELECT COUNT(*)::int FROM host_members) AS total_host_members
    `);
    const rows = await db.all(`
      SELECT ii.*,
        COUNT(ea.id) FILTER (WHERE ea.entity_type='participant')::int AS delegate_present,
        COUNT(ea.id) FILTER (WHERE ea.entity_type='host_member')::int AS host_member_present
      FROM itinerary_items ii
      LEFT JOIN event_attendance ea ON ea.itinerary_item_id = ii.id
      GROUP BY ii.id
      ORDER BY ii.sort_order, ii.id
    `);
    res.json(rows.map((r) => ({ ...r, total_delegates: totals.total_delegates, total_host_members: totals.total_host_members })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Minimal Delegate/Host Member lookups for the manual "mark present" form —
// same reasoning as every other module's *-lite endpoints (transport.js,
// inventory.js): a committee only granted Itinerary/Attendance still needs
// real names to search by, not a raw numeric id.
router.get('/participants-lite', async (req, res) => {
  try {
    const rows = await db.all(`
      SELECT p.id, p.name, p.participant_code, c.name AS club_name
      FROM participants p LEFT JOIN clubs c ON c.id = p.club_id
      ORDER BY p.name
    `);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
router.get('/host-members-lite', async (req, res) => {
  try {
    const rows = await db.all(`SELECT id, name, company FROM host_members ORDER BY name`);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Full present-list for one itinerary slot — the actual "who attended"
// report, and what the per-event PDF is built from.
router.get('/:itemId/attendees', async (req, res) => {
  try {
    const item = await db.get('SELECT * FROM itinerary_items WHERE id=$1', [req.params.itemId]);
    if (!item) return res.status(404).json({ error: 'Itinerary item not found' });
    const rows = await db.all(`
      SELECT ea.id, ea.entity_type, ea.entity_id, ea.checked_in_at,
        u.username AS checked_in_by_username,
        COALESCE(p.name, hm.name) AS name,
        COALESCE(p.phone, hm.phone) AS phone,
        COALESCE(c.name, hm.company) AS club_or_company
      FROM event_attendance ea
      LEFT JOIN participants p ON ea.entity_type='participant' AND p.id = ea.entity_id
      LEFT JOIN clubs c ON c.id = p.club_id
      LEFT JOIN host_members hm ON ea.entity_type='host_member' AND hm.id = ea.entity_id
      LEFT JOIN users u ON u.id = ea.checked_in_by_user_id
      WHERE ea.itinerary_item_id = $1
      ORDER BY ea.checked_in_at
    `, [req.params.itemId]);
    res.json({ item, attendees: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Manual mark — same effect as a successful badge scan, for the rare case a
// badge won't scan or someone needs to be added after the fact. Idempotent:
// re-marking someone already present is a harmless no-op (ON CONFLICT DO
// NOTHING), matching the badge-scan endpoint's own "already marked" handling.
router.post('/:itemId/attendees', async (req, res) => {
  const { entity_type, entity_id } = req.body;
  if (!['participant', 'host_member'].includes(entity_type)) {
    return res.status(400).json({ error: "entity_type must be 'participant' or 'host_member'" });
  }
  if (!entity_id) return res.status(400).json({ error: 'entity_id is required' });
  try {
    const item = await db.get('SELECT id FROM itinerary_items WHERE id=$1', [req.params.itemId]);
    if (!item) return res.status(404).json({ error: 'Itinerary item not found' });
    await db.run(`
      INSERT INTO event_attendance (itinerary_item_id, entity_type, entity_id, checked_in_by_user_id)
      VALUES ($1,$2,$3,$4) ON CONFLICT (itinerary_item_id, entity_type, entity_id) DO NOTHING
    `, [req.params.itemId, entity_type, entity_id, req.user?.id || null]);
    logActivity(req.user, { action: 'checkin', entityType: entity_type, entityId: Number(entity_id), details: `event attendance: itinerary item #${req.params.itemId}` });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Unmark — correcting a mistaken scan/manual mark.
router.delete('/:itemId/attendees/:attendanceId', async (req, res) => {
  try {
    await db.run('DELETE FROM event_attendance WHERE id=$1 AND itinerary_item_id=$2', [req.params.attendanceId, req.params.itemId]);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

module.exports = router;
