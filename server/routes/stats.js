const express = require('express');
const db = require('../db');

const router = express.Router();

router.get('/overview', async (req, res) => {
  try {
    const totalMembers = (await db.get('SELECT COALESCE(SUM(members_count),0) AS n FROM clubs')).n;
    const totalClubs = (await db.get('SELECT COUNT(*) AS n FROM clubs')).n;
    const totalRegistrations = (await db.get('SELECT COUNT(*) AS n FROM registrations')).n;
    const singleRegs = (await db.get("SELECT COUNT(*) AS n FROM registrations WHERE reg_type='single'")).n;
    const doubleRegs = (await db.get("SELECT COUNT(*) AS n FROM registrations WHERE reg_type='double'")).n;
    const totalParticipants = (await db.get('SELECT COUNT(*) AS n FROM participants')).n;
    const totalCollected = (await db.get('SELECT COALESCE(SUM(amount_paid),0) AS n FROM registrations')).n;
    const totalDue = (await db.get('SELECT COALESCE(SUM(amount_due),0) AS n FROM registrations')).n;
    const paidCount = (await db.get("SELECT COUNT(*) AS n FROM registrations WHERE payment_status='paid'")).n;
    const partialCount = (await db.get("SELECT COUNT(*) AS n FROM registrations WHERE payment_status='partial'")).n;
    const pendingCount = (await db.get("SELECT COUNT(*) AS n FROM registrations WHERE payment_status='pending'")).n;

    res.json({
      totalMembers: Number(totalMembers),
      totalClubs: Number(totalClubs),
      totalRegistrations: Number(totalRegistrations),
      singleRegs: Number(singleRegs),
      doubleRegs: Number(doubleRegs),
      totalParticipants: Number(totalParticipants),
      totalCollected: Number(totalCollected),
      totalDue: Number(totalDue),
      paymentStatus: { paid: Number(paidCount), partial: Number(partialCount), pending: Number(pendingCount) }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Nation-wise (state-wise) member rollup
router.get('/nationwide', async (req, res) => {
  try {
    const rows = await db.all(`
      SELECT state, SUM(members_count) AS members, COUNT(*) AS clubs
      FROM clubs GROUP BY state ORDER BY members DESC
    `);
    res.json(rows.map((r) => ({ state: r.state, members: Number(r.members), clubs: Number(r.clubs) })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Club-wise members vs registrations vs participants comparison
router.get('/club-comparison', async (req, res) => {
  try {
    const rows = await db.all(`
      SELECT c.id, c.name, c.state, c.members_count,
        COUNT(DISTINCT r.id) AS registrations,
        COALESCE(SUM(r.amount_paid),0) AS collected,
        (SELECT COUNT(*) FROM participants p WHERE p.club_id = c.id) AS participants
      FROM clubs c
      LEFT JOIN registrations r ON r.club_id = c.id
      GROUP BY c.id
      ORDER BY c.members_count DESC
    `);
    res.json(rows.map((r) => ({
      id: r.id,
      name: r.name,
      state: r.state,
      members_count: Number(r.members_count),
      registrations: Number(r.registrations),
      collected: Number(r.collected),
      participants: Number(r.participants)
    })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Dietary preference breakdown, headcount-based (double registrations count as 2 people).
// Normalizes into the 3 canonical buckets the dashboard displays.
router.get('/dietary', async (req, res) => {
  try {
    const rows = await db.all(`
      SELECT COALESCE(dietary_preference, 'No preference') AS label, COUNT(*) AS n
      FROM participants
      GROUP BY COALESCE(dietary_preference, 'No preference')
    `);
    const buckets = { Vegetarian: 0, 'Non-vegetarian': 0, 'No preference': 0 };
    for (const r of rows) {
      const key = Object.prototype.hasOwnProperty.call(buckets, r.label) ? r.label : 'No preference';
      buckets[key] += Number(r.n);
    }
    res.json([
      { label: 'Vegetarian', count: buckets.Vegetarian },
      { label: 'Non-vegetarian', count: buckets['Non-vegetarian'] },
      { label: 'No preference', count: buckets['No preference'] }
    ]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
