// Public tour-interest page (tours.html) — no login.
//
// Delegates look themselves up by mobile number, see the published tours as
// tiles, and register interest for themselves and/or their co-registrant.
// Rows land in pre_tour_participants with source='public', so the office sees
// them in the existing Pre Tours / Day Tours screens alongside anything they
// entered by hand, and can tell the two apart.
//
// Deliberately NOT a booking system: day tours are free and pre-tours are
// pay-later, so nothing here takes money or hard-allocates a seat. Capacity
// is shown as a guide and overbooking is allowed — the office confirms.

const express = require('express');
const db = require('../db');

const router = express.Router();

// --- helpers ---------------------------------------------------------------

function normPhone(p) {
  return String(p || '').replace(/\D/g, '').slice(-10);
}

// Two tours clash when their date ranges overlap at all. The overnight tours
// return on 12 August and every day tour runs on 12 August, so this makes the
// two mutually exclusive — which is the intent: someone driving back from
// Ooty that morning cannot also be at Isha.
function rangesOverlap(aStart, aEnd, bStart, bEnd) {
  const s1 = aStart || aEnd, e1 = aEnd || aStart;
  const s2 = bStart || bEnd, e2 = bEnd || bStart;
  if (!s1 || !s2) return false;   // an undated tour can't clash with anything
  return s1 <= e2 && s2 <= e1;
}

function toISO(d) {
  if (!d) return null;
  return d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10);
}

async function loadPublicTours(runner) {
  const rows = await runner.all(`
    SELECT t.id, t.name, t.tour_type, t.category, t.start_date, t.end_date,
           t.description, t.inclusions, t.price, t.capacity, t.status,
           (SELECT COUNT(*)::int FROM pre_tour_participants p WHERE p.pre_tour_id = t.id) AS signup_count
      FROM pre_tours t
     WHERE t.public_visible = TRUE
       AND t.status <> 'cancelled'
       AND t.tour_type IN ('pre','day')
     ORDER BY t.tour_type DESC, t.category NULLS LAST, t.start_date, t.name
  `);
  return rows.map((r) => ({
    ...r,
    start_date: toISO(r.start_date),
    end_date: toISO(r.end_date),
    inclusions: (r.inclusions || '').split('\n').map((s) => s.trim()).filter(Boolean)
  }));
}

// --- routes ----------------------------------------------------------------

// GET /api/public-tours — every published tour, for the tile grid.
router.get('/', async (req, res) => {
  try {
    res.json({ ok: true, tours: await loadPublicTours(db) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/public-tours/lookup { phone }
// Resolves a mobile to the delegate(s) on that registration. Phone alone is
// enough here (unlike my-profile.html, which also asks for the name) because
// nothing sensitive is exposed — just the names on the booking and which
// tours they already asked about.
router.post('/lookup', async (req, res) => {
  const phone = normPhone(req.body.phone);
  if (phone.length !== 10) {
    return res.status(400).json({ error: 'Please enter a valid 10-digit mobile number.' });
  }
  try {
    const hit = await db.get(`
      SELECT p.id, p.registration_id
        FROM participants p
       WHERE RIGHT(regexp_replace(COALESCE(p.phone,''), '[^0-9]', '', 'g'), 10) = $1
          OR RIGHT(regexp_replace(COALESCE(p.whatsapp,''), '[^0-9]', '', 'g'), 10) = $1
       LIMIT 1
    `, [phone]);

    if (!hit) {
      return res.status(404).json({
        error: 'We could not find a registration against that mobile number. Please check the number, or contact the Registration Desk.'
      });
    }

    // Everyone on the same registration — the delegate plus their
    // co-registrant, so both can be signed up in one go.
    const people = await db.all(`
      SELECT p.id, p.name, p.is_primary, p.company, r.reg_number
        FROM participants p
        LEFT JOIN registrations r ON r.id = p.registration_id
       WHERE ${hit.registration_id ? 'p.registration_id = $1' : 'p.id = $1'}
       ORDER BY p.is_primary DESC, p.id
    `, [hit.registration_id || hit.id]);

    const ids = people.map((p) => p.id);
    const existing = ids.length ? await db.all(`
      SELECT ptp.participant_id, ptp.pre_tour_id
        FROM pre_tour_participants ptp
       WHERE ptp.participant_id = ANY($1::int[])
    `, [ids]) : [];

    res.json({
      ok: true,
      reg_number: people[0] ? people[0].reg_number : null,
      people: people.map((p) => ({
        id: p.id,
        name: p.name,
        is_primary: Number(p.is_primary) === 1,
        company: p.company || null,
        tour_ids: existing.filter((e) => e.participant_id === p.id).map((e) => e.pre_tour_id)
      }))
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/public-tours/register { phone, selections: [{ participant_id, tour_ids: [] }] }
//
// Replaces each named person's public signups wholesale, so the page can be
// re-opened and edited rather than only ever adding. Rows the office created
// by hand (source='admin') are left alone — a delegate editing their own
// choices must not silently undo an office allocation.
router.post('/register', async (req, res) => {
  const phone = normPhone(req.body.phone);
  const selections = Array.isArray(req.body.selections) ? req.body.selections : [];
  if (phone.length !== 10) return res.status(400).json({ error: 'A valid mobile number is required.' });
  if (!selections.length) return res.status(400).json({ error: 'No selections were sent.' });

  try {
    // Re-verify ownership: the caller may only touch people on the
    // registration that mobile number belongs to.
    const hit = await db.get(`
      SELECT p.id, p.registration_id FROM participants p
       WHERE RIGHT(regexp_replace(COALESCE(p.phone,''), '[^0-9]', '', 'g'), 10) = $1
          OR RIGHT(regexp_replace(COALESCE(p.whatsapp,''), '[^0-9]', '', 'g'), 10) = $1
       LIMIT 1
    `, [phone]);
    if (!hit) return res.status(403).json({ error: 'That mobile number does not match a registration.' });

    const allowed = await db.all(`
      SELECT id FROM participants
       WHERE ${hit.registration_id ? 'registration_id = $1' : 'id = $1'}
    `, [hit.registration_id || hit.id]);
    const allowedIds = new Set(allowed.map((r) => r.id));

    const tours = await loadPublicTours(db);
    const tourById = new Map(tours.map((t) => [t.id, t]));

    // Validate before writing anything, so a clash on one person doesn't
    // leave another person half-saved.
    for (const sel of selections) {
      const pid = Number(sel.participant_id);
      if (!allowedIds.has(pid)) {
        return res.status(403).json({ error: 'One of the selected people is not on your registration.' });
      }
      const ids = Array.isArray(sel.tour_ids) ? sel.tour_ids.map(Number) : [];
      for (const id of ids) {
        if (!tourById.has(id)) return res.status(400).json({ error: 'One of the selected tours is no longer available.' });
      }
      // Server-side clash check. The page greys clashing tiles out, but a
      // stale page or a direct API call must not be able to bypass it.
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          const a = tourById.get(ids[i]);
          const b = tourById.get(ids[j]);
          if (rangesOverlap(a.start_date, a.end_date, b.start_date, b.end_date)) {
            return res.status(409).json({
              error: `"${a.name}" and "${b.name}" run on overlapping dates — please pick just one of them.`
            });
          }
        }
      }
    }

    let added = 0;
    let removed = 0;
    await db.transaction(async (tx) => {
      for (const sel of selections) {
        const pid = Number(sel.participant_id);
        const wanted = new Set((sel.tour_ids || []).map(Number));

        const current = await tx.all(
          `SELECT id, pre_tour_id FROM pre_tour_participants WHERE participant_id=$1 AND source='public'`,
          [pid]
        );
        for (const row of current) {
          if (!wanted.has(row.pre_tour_id)) {
            await tx.run('DELETE FROM pre_tour_participants WHERE id=$1', [row.id]);
            removed++;
          }
        }
        const have = new Set(current.map((r) => r.pre_tour_id));
        for (const tid of wanted) {
          if (have.has(tid)) continue;
          // ON CONFLICT covers the case where the office already added this
          // person to this tour by hand — keep theirs, don't duplicate.
          const r = await tx.run(`
            INSERT INTO pre_tour_participants (pre_tour_id, participant_id, payment_status, source, notes)
            VALUES ($1,$2,$3,'public',$4)
            ON CONFLICT (pre_tour_id, participant_id) DO NOTHING
          `, [tid, pid,
              // Day tours are free, so there is nothing to collect; pre-tours
              // are pay-later and start life pending.
              tourById.get(tid).tour_type === 'day' ? 'paid' : 'pending',
              'Registered interest via the public tour page']);
          if (r.rowCount) added++;
        }
      }
    });

    res.json({ ok: true, added, removed });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
module.exports._internals = { rangesOverlap, normPhone };
