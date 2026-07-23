// Public, no-login "update my own details" endpoint.
//
// Delegates have no login of their own (only host_member/media/transporter/
// driver/volunteer/vendor accounts exist — see server/db.js users_role_check).
// So collecting Shirt Size / T-Shirt Size / Photo / Business Card from every
// delegate (plus host members and volunteers, who *do* have logins but this
// gives them a quicker link too) needs a route that works without a JWT.
//
// Because it's unauthenticated, every mutating call re-verifies the same
// name+phone match used at lookup time — a client can't just guess an id and
// overwrite someone else's record. Only the 4 congress-wide fields are
// writable here; nothing else on these tables is reachable through this
// route (no name/phone/payment/etc. changes).
const express = require('express');
const multer = require('multer');
const db = require('../db');
const { saveFile, deleteStoredFile } = require('../uploadHelper');

const router = express.Router();
const uploadImage = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const TABLES = {
  participant: { table: 'participants', label: 'Delegate' },
  host_member: { table: 'host_members', label: 'Host Member' },
  volunteer: { table: 'volunteers', label: 'Volunteer' }
};

function normPhone(p) {
  return (p || '').replace(/\D/g, '').slice(-10);
}
function normName(n) {
  return (n || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

// Looks across all three tables for rows whose name+phone both match what
// was typed in. Requires a phone on file for the row (a name-only match is
// too weak to safely let someone view/edit a record over an unauthenticated
// route).
async function findMatches(name, phone) {
  const nn = normName(name);
  const np = normPhone(phone);
  if (!nn || !np) return [];
  const matches = [];
  for (const [type, { table, label }] of Object.entries(TABLES)) {
    // Travel/address columns only exist on `participants` — the my-travel.html
    // page (Delegate-only) needs them to prefill its form; host_members/
    // volunteers don't have these columns so they're left out for those tables.
    const extraCols = type === 'participant'
      ? `, address, travel_mode, travel_number, travel_datetime, arrival_point,
         departure_mode, departure_number, departure_datetime, departure_point,
         dietary_preference, drink_preference, special_requests,
         (SELECT ptp.pre_tour_id FROM pre_tour_participants ptp WHERE ptp.participant_id = ${table}.id ORDER BY ptp.id LIMIT 1) AS pre_tour_id`
      : '';
    const rows = await db.all(`
      SELECT id, name, shirt_size, tshirt_size, waist_size, photo_url, business_card_url${extraCols}
      FROM ${table}
      WHERE lower(trim(name)) = $1
        AND phone <> '' AND RIGHT(regexp_replace(COALESCE(phone,''), '[^0-9]', '', 'g'), 10) = $2
    `, [nn, np]);
    for (const row of rows) {
      matches.push({ type, label, ...row });
    }
  }
  return matches;
}

// POST /lookup { name, phone } — find your own record(s).
router.post('/lookup', async (req, res) => {
  const { name, phone } = req.body;
  if (!name || !phone) return res.status(400).json({ error: 'Please enter both your name and phone number.' });
  try {
    const matches = await findMatches(name, phone);
    if (!matches.length) {
      return res.status(404).json({
        error: "We couldn't find a matching record. Please check the spelling of your name and your phone number, or contact the organizers if you believe this is an error."
      });
    }
    // Multiple matches (e.g. someone who is both a Host Member and a
    // Volunteer) — let the person pick which one to update.
    res.json({ ok: true, matches });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Re-verifies the same name+phone match against the live row before any
// mutation — see file header. Returns the row (with table info) on success.
async function verifyOwnership(type, id, name, phone) {
  const entry = TABLES[type];
  if (!entry) return null;
  const nn = normName(name);
  const np = normPhone(phone);
  if (!nn || !np) return null;
  const row = await db.get(`SELECT id, name, phone FROM ${entry.table} WHERE id=$1`, [id]);
  if (!row) return null;
  if (normName(row.name) !== nn) return null;
  if (normPhone(row.phone) !== np) return null;
  return { ...entry, row };
}

// PUT /:type/:id { name, phone, shirt_size, tshirt_size, waist_size }
router.put('/:type/:id', async (req, res) => {
  const { name, phone, shirt_size, tshirt_size, waist_size } = req.body;
  try {
    const verified = await verifyOwnership(req.params.type, req.params.id, name, phone);
    if (!verified) return res.status(403).json({ error: 'Name and phone number did not match our records — please look yourself up again.' });
    await db.run(`UPDATE ${verified.table} SET shirt_size=$1, tshirt_size=$2, waist_size=$3 WHERE id=$4`, [
      shirt_size || null, tshirt_size || null, waist_size || null, req.params.id
    ]);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// PUT /participant/:id/travel { name, phone, address, travel_mode, travel_number,
// travel_datetime, arrival_point, departure_mode, departure_number,
// departure_datetime, departure_point, shirt_size, tshirt_size, waist_size }
// Delegate-only. Also accepts shirt_size/tshirt_size (same columns the
// generic sizes PUT above writes) so my-travel.html can be a one-stop page
// for Delegates — address, travel, merch size, photo and business card all
// save together from a single "Save changes" button. Photo/business card
// still go through the existing /:type/:id/photo and /:type/:id/business-card
// routes below (unchanged, already generic across all three roles).
const TRAVEL_MODES = ['flight', 'train', 'road', 'other'];
function cleanMode(v) { return TRAVEL_MODES.includes(v) ? v : null; }
function cleanText(v) { return (v === undefined || v === null || String(v).trim() === '') ? null : String(v).trim(); }

// Same-spirit as admin.js's ensureTransportPoint — auto-registers any new
// arrival/departure point a delegate types so it shows up as a suggestion in
// the admin's Transport Planning UI too. Direct SQL rather than calling the
// admin-only /api/transport-points route (which requires a JWT).
async function ensurePoint(name) {
  const trimmed = (name || '').trim();
  if (!trimmed) return;
  await db.run(
    `INSERT INTO transport_points (name) VALUES ($1) ON CONFLICT (LOWER(name)) DO NOTHING`,
    [trimmed]
  );
}

router.put('/participant/:id/travel', async (req, res) => {
  try {
    const verified = await verifyOwnership('participant', req.params.id, req.body.name, req.body.phone);
    if (!verified) return res.status(403).json({ error: 'Name and phone number did not match our records — please look yourself up again.' });
    const b = req.body;
    await db.run(`
      UPDATE participants SET
        address=$1, travel_mode=$2, travel_number=$3, travel_datetime=$4, arrival_point=$5,
        departure_mode=$6, departure_number=$7, departure_datetime=$8, departure_point=$9,
        shirt_size=$10, tshirt_size=$11, waist_size=$12,
        dietary_preference=$13, drink_preference=$14, special_requests=$15
      WHERE id=$16
    `, [
      cleanText(b.address), cleanMode(b.travel_mode), cleanText(b.travel_number), cleanText(b.travel_datetime), cleanText(b.arrival_point),
      cleanMode(b.departure_mode), cleanText(b.departure_number), cleanText(b.departure_datetime), cleanText(b.departure_point),
      cleanText(b.shirt_size), cleanText(b.tshirt_size), cleanText(b.waist_size),
      cleanText(b.dietary_preference), cleanText(b.drink_preference), cleanText(b.special_requests),
      req.params.id
    ]);
    await Promise.all([ensurePoint(b.arrival_point), ensurePoint(b.departure_point)]);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Sets/replaces/clears the Delegate's own pre-tour signup — same
// pre_tour_participants row admin.js's Delegates form and Pre Tours' own
// "Manage" sub-panel use (see server/routes/participants.js's matching
// admin-side /:id/pretour, and pretours.js's POST/DELETE /:id/participants).
// Unlike that admin route, THIS one enforces the tour's capacity — pre-tours
// are limited-seat and first-come-first-served, so a delegate self-signing-up
// can't slip past a tour that's already full (an admin can still add someone
// manually as a deliberate override).
router.put('/participant/:id/pretour', async (req, res) => {
  try {
    const verified = await verifyOwnership('participant', req.params.id, req.body.name, req.body.phone);
    if (!verified) return res.status(403).json({ error: 'Name and phone number did not match our records — please look yourself up again.' });
    const pretourId = req.body.pre_tour_id ? Number(req.body.pre_tour_id) : null;
    const participantId = req.params.id;
    const existing = await db.get('SELECT id, pre_tour_id FROM pre_tour_participants WHERE participant_id=$1 ORDER BY id LIMIT 1', [participantId]);
    if (!pretourId) {
      if (existing) await db.run('DELETE FROM pre_tour_participants WHERE id=$1', [existing.id]);
      return res.json({ ok: true, pre_tour_id: null });
    }
    if (existing && Number(existing.pre_tour_id) === pretourId) {
      return res.json({ ok: true, pre_tour_id: pretourId }); // unchanged
    }
    const tour = await db.get('SELECT id, capacity FROM pre_tours WHERE id=$1', [pretourId]);
    if (!tour) return res.status(400).json({ error: 'Selected pre-tour no longer exists — please pick again.' });
    if (tour.capacity !== null && tour.capacity !== undefined) {
      const { count } = await db.get('SELECT COUNT(*)::int AS count FROM pre_tour_participants WHERE pre_tour_id=$1', [pretourId]);
      if (count >= tour.capacity) {
        return res.status(409).json({ error: 'Sorry, this pre-tour is full — seats are limited and allotted on a first-come, first-served basis. Please choose a different pre-tour, or contact the organizers to be added to a waitlist.' });
      }
    }
    if (existing) await db.run('DELETE FROM pre_tour_participants WHERE id=$1', [existing.id]);
    await db.run(
      `INSERT INTO pre_tour_participants (pre_tour_id, participant_id, payment_status) VALUES ($1,$2,'pending')`,
      [pretourId, participantId]
    );
    res.json({ ok: true, pre_tour_id: pretourId });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

function handleUpload(field) {
  return (req, res, next) => {
    uploadImage.single('file')(req, res, (err) => {
      if (err) {
        const friendly = err.code === 'LIMIT_FILE_SIZE' ? 'Image is too large (max 10MB).' : 'Upload was interrupted — please try again.';
        return res.status(400).json({ error: friendly });
      }
      next();
    });
  };
}

// POST /:type/:id/photo — multipart form with fields: name, phone, file
router.post('/:type/:id/photo', handleUpload(), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'file is required' });
  try {
    const verified = await verifyOwnership(req.params.type, req.params.id, req.body.name, req.body.phone);
    if (!verified) return res.status(403).json({ error: 'Name and phone number did not match our records — please look yourself up again.' });
    const existing = await db.get(`SELECT photo_url FROM ${verified.table} WHERE id=$1`, [req.params.id]);
    const storedPath = await saveFile(req.file, `${req.params.type}-photos`);
    await db.run(`UPDATE ${verified.table} SET photo_url=$1 WHERE id=$2`, [storedPath, req.params.id]);
    if (existing && existing.photo_url) await deleteStoredFile(existing.photo_url);
    res.json({ photo_url: storedPath });
  } catch (e) {
    console.error('Public profile photo upload failed —', e.message);
    res.status(500).json({ error: 'Upload failed: ' + e.message });
  }
});

// POST /:type/:id/business-card — multipart form with fields: name, phone, file
router.post('/:type/:id/business-card', handleUpload(), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'file is required' });
  try {
    const verified = await verifyOwnership(req.params.type, req.params.id, req.body.name, req.body.phone);
    if (!verified) return res.status(403).json({ error: 'Name and phone number did not match our records — please look yourself up again.' });
    const existing = await db.get(`SELECT business_card_url FROM ${verified.table} WHERE id=$1`, [req.params.id]);
    const storedPath = await saveFile(req.file, `${req.params.type}-business-cards`);
    await db.run(`UPDATE ${verified.table} SET business_card_url=$1 WHERE id=$2`, [storedPath, req.params.id]);
    if (existing && existing.business_card_url) await deleteStoredFile(existing.business_card_url);
    res.json({ business_card_url: storedPath });
  } catch (e) {
    console.error('Public profile business card upload failed —', e.message);
    res.status(500).json({ error: 'Upload failed: ' + e.message });
  }
});

module.exports = router;
