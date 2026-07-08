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
    const congressOnlyRegs = (await db.get("SELECT COUNT(*) AS n FROM registrations WHERE reg_type='congress_only'")).n;
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
      congressOnlyRegs: Number(congressOnlyRegs),
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

// Cross-module "complete picture" rollup for the merged dashboard: host team
// + payments, transport (partners/drivers/vehicles), accommodation, and the
// guest-relation entities (sponsors/speakers/guest visitors), plus a few
// extras (committees, inventory, transport trips, pre-tours) so the whole
// congress operation is visible from one screen.
router.get('/ops-overview', async (req, res) => {
  try {
    const hostTotal = (await db.get('SELECT COUNT(*) AS n FROM host_members')).n;
    const hostPaid = (await db.get("SELECT COUNT(*) AS n FROM host_members WHERE payment_status='paid'")).n;
    const hostPartial = (await db.get("SELECT COUNT(*) AS n FROM host_members WHERE payment_status='partial'")).n;
    const hostPending = (await db.get("SELECT COUNT(*) AS n FROM host_members WHERE payment_status='pending'")).n;
    const hostExpected = (await db.get('SELECT COALESCE(SUM(payment_amount),0) AS n FROM host_members')).n;
    const hostCollected = (await db.get("SELECT COALESCE(SUM(payment_amount),0) AS n FROM host_members WHERE payment_status='paid'")).n;
    const hostPendingAmount = (await db.get("SELECT COALESCE(SUM(payment_amount),0) AS n FROM host_members WHERE payment_status<>'paid'")).n;

    const transporters = (await db.get('SELECT COUNT(*) AS n FROM partners')).n;
    const drivers = (await db.get('SELECT COUNT(*) AS n FROM drivers')).n;
    const vehicles = (await db.get('SELECT COUNT(*) AS n FROM vehicles')).n;

    const hotels = (await db.get('SELECT COUNT(*) AS n FROM hotels')).n;
    const roomsAssigned = (await db.get("SELECT COUNT(DISTINCT hotel_id || '-' || room_number) AS n FROM room_assignments")).n;
    const occupantsAssigned = (await db.get('SELECT COUNT(*) AS n FROM room_assignments')).n;

    const sponsors = (await db.get('SELECT COUNT(*) AS n FROM sponsors')).n;
    const speakers = (await db.get('SELECT COUNT(*) AS n FROM speakers')).n;
    const guestVisitors = (await db.get('SELECT COUNT(*) AS n FROM guest_visitors')).n;
    const committees = (await db.get('SELECT COUNT(*) AS n FROM committees')).n;

    const inventoryItems = (await db.get('SELECT COUNT(*) AS n FROM inventory_items')).n;
    const inventoryProcured = (await db.get('SELECT COALESCE(SUM(quantity_procured),0) AS n FROM inventory_items')).n;
    const inventoryDelivered = (await db.get("SELECT COUNT(*) AS n FROM inventory_distributions WHERE status='delivered'")).n;
    const inventoryPending = (await db.get("SELECT COUNT(*) AS n FROM inventory_distributions WHERE status='pending'")).n;

    const transportTrips = (await db.get('SELECT COUNT(*) AS n FROM transport_trips')).n;
    const preTours = (await db.get('SELECT COUNT(*) AS n FROM pre_tours')).n;

    res.json({
      hostMembers: {
        total: Number(hostTotal), paid: Number(hostPaid), partial: Number(hostPartial), pending: Number(hostPending),
        expectedAmount: Number(hostExpected), collectedAmount: Number(hostCollected), pendingAmount: Number(hostPendingAmount)
      },
      transporters: Number(transporters),
      drivers: Number(drivers),
      vehicles: Number(vehicles),
      hotels: Number(hotels),
      roomsAssigned: Number(roomsAssigned),
      occupantsAssigned: Number(occupantsAssigned),
      sponsors: Number(sponsors),
      speakers: Number(speakers),
      guestVisitors: Number(guestVisitors),
      committees: Number(committees),
      inventory: {
        items: Number(inventoryItems), procured: Number(inventoryProcured),
        delivered: Number(inventoryDelivered), pending: Number(inventoryPending)
      },
      transportTrips: Number(transportTrips),
      preTours: Number(preTours)
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
