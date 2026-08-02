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
         dietary_preference, drink_preference, special_requests, business_profile,
         aadhaar_number, aadhaar_url, passport_number, passport_url,
         (SELECT ptp.pre_tour_id FROM pre_tour_participants ptp WHERE ptp.participant_id = ${table}.id ORDER BY ptp.id LIMIT 1) AS pre_tour_id`
      // host_members/volunteers answer the same catering questions plus the
      // accommodation one, on my-profile.html — returned here so that form
      // can prefill what they've already told us. The spouse-dinner and
      // goodies columns exist ONLY on host_members (see the db.js migration),
      // so they're appended for that type alone — asking for them against
      // `volunteers` would fail the whole lookup with "column does not exist".
      : `, dietary_preference, drink_preference, special_requests,
         hotel_stay_required, hotel_stay_notes, logo_url` +
        (type === 'host_member'
          ? `, spouse_name, spouse_dinner_aug12, spouse_dinner_aug13, spouse_dinner_aug14,
             goodies_offer, goodies_details`
          : '');
    const rows = await db.all(`
      SELECT id, name, email, shirt_size, tshirt_size, waist_size, photo_url, business_card_url${extraCols}
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

// PUT /:type/:id { name, phone, email, shirt_size, tshirt_size, waist_size }
// email was added alongside the congress-wide fields above so Host Members
// and Volunteers can supply/correct their own email address from
// my-profile.html — the address the Email Campaigns admin feature then sends
// to (see server/routes/emailCampaigns.js). Left optional/nullable, same as
// every other field here — an admin can still fill it in manually instead.
// Catering/accommodation fields, added for host members and volunteers (see
// the migration in db.js). participants have the same columns but fill them
// in via my-travel.html instead, so they're only written here when actually
// submitted — see the "only update what was sent" note below.
const PROFILE_EXTRA_FIELDS = {
  dietary_preference: (v) => cleanText(v),
  drink_preference: (v) => cleanText(v),
  special_requests: (v) => cleanText(v),
  hotel_stay_notes: (v) => cleanText(v),
  // Checkbox — accept a real boolean or the string forms a form/JSON might send.
  hotel_stay_required: (v) => (v === true || v === 'true' || v === 'on' || v === 1 || v === '1'),
};

// Columns that exist ONLY on host_members. Kept separate from the shared set
// above because the same PUT serves delegates and volunteers too, and naming a
// column their table doesn't have would fail the UPDATE outright.
const HOST_MEMBER_ONLY_FIELDS = {
  // Spouse dinner attendance. One flag per night because catering counts are
  // per-night — see the migration note in db.js.
  spouse_name: (v) => cleanText(v),
  spouse_dinner_aug12: (v) => toBool(v),
  spouse_dinner_aug13: (v) => toBool(v),
  spouse_dinner_aug14: (v) => toBool(v),
  goodies_offer: (v) => toBool(v),
  goodies_details: (v) => cleanText(v),
};

// Checkboxes reach us as `true`, `"true"`, `"on"`, `1` or `"1"` depending on
// whether the page posts JSON or a form encoding; anything else is false.
function toBool(v) {
  return v === true || v === 'true' || v === 'on' || v === 1 || v === '1';
}

router.put('/:type/:id', async (req, res) => {
  const { name, phone, email, shirt_size, tshirt_size, waist_size } = req.body;
  try {
    const verified = await verifyOwnership(req.params.type, req.params.id, name, phone);
    if (!verified) return res.status(403).json({ error: 'Name and phone number did not match our records — please look yourself up again.' });

    const sets = ['email=$1', 'shirt_size=$2', 'tshirt_size=$3', 'waist_size=$4'];
    const params = [cleanText(email), shirt_size || null, tshirt_size || null, waist_size || null];
    // Only write the extras the client actually sent. my-profile.html posts
    // them; my-travel.html (Delegates) doesn't, and a delegate who also opens
    // my-profile.html must not have the food/drink answers they gave on the
    // travel page silently blanked by a form that never showed those inputs.
    const allowed = verified.table === 'host_members'
      ? { ...PROFILE_EXTRA_FIELDS, ...HOST_MEMBER_ONLY_FIELDS }
      : PROFILE_EXTRA_FIELDS;
    for (const [col, clean] of Object.entries(allowed)) {
      if (req.body[col] === undefined) continue;
      params.push(clean(req.body[col]));
      sets.push(`${col}=$${params.length}`);
    }
    params.push(req.params.id);
    await db.run(`UPDATE ${verified.table} SET ${sets.join(', ')} WHERE id=$${params.length}`, params);
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

// International Delegates don't hold an Aadhaar, so a Delegate only ever
// needs to provide ONE of Aadhaar or Passport — not both, and not
// specifically Aadhaar. Both cleaners are therefore "optional, but if you
// typed something it has to be valid": empty input is not an error here,
// it's just not a complete document on its own. The PUT handler below is
// what actually enforces "at least one of the two is fully provided".
//
// Aadhaar: exactly the 12 digits an Aadhaar number actually has,
// spaces/dashes stripped first since people commonly write it as
// "1234 5678 9012".
function cleanAadhaar(v) {
  const digits = String(v || '').replace(/\D/g, '');
  if (!digits) return { value: null, error: null };
  if (digits.length !== 12) return { value: null, error: 'Aadhaar number must be exactly 12 digits.' };
  return { value: digits, error: null };
}

// Passport: formats vary a lot by issuing country (letters + digits, lengths
// from about 6 to 9 characters typically, sometimes more) — so this is
// deliberately lenient rather than matching one country's exact pattern.
// Spaces are stripped and the value is upper-cased for consistent storage/
// display; only rejected if it's clearly not a plausible passport number.
function cleanPassport(v) {
  const cleaned = String(v || '').replace(/\s+/g, '').toUpperCase();
  if (!cleaned) return { value: null, error: null };
  if (!/^[A-Z0-9]{5,15}$/.test(cleaned)) {
    return { value: null, error: 'Passport number looks incorrect — please double-check it (letters and numbers only, 5–15 characters).' };
  }
  return { value: cleaned, error: null };
}

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

// A Delegate must provide a complete identity document — either Aadhaar
// (number + scan) or Passport (number + scan), not necessarily both. The
// frontend (mytravel.js) uploads whichever document file the person picked
// BEFORE calling this route, specifically so that by the time this handler
// runs, aadhaar_url/passport_url is already set on the row (either from a
// prior save, or from the upload that just happened seconds ago in the same
// "Save changes" click) — that lets this handler check the URL columns the
// normal way instead of trying to coordinate two separate HTTP requests
// atomically.
router.put('/participant/:id/travel', async (req, res) => {
  try {
    const verified = await verifyOwnership('participant', req.params.id, req.body.name, req.body.phone);
    if (!verified) return res.status(403).json({ error: 'Name and phone number did not match our records — please look yourself up again.' });
    const b = req.body;
    const aadhaar = cleanAadhaar(b.aadhaar_number);
    if (aadhaar.error) return res.status(400).json({ error: aadhaar.error });
    const passport = cleanPassport(b.passport_number);
    if (passport.error) return res.status(400).json({ error: passport.error });

    const existingDoc = await db.get('SELECT aadhaar_url, passport_url FROM participants WHERE id=$1', [req.params.id]);
    const hasAadhaar = !!(aadhaar.value && existingDoc && existingDoc.aadhaar_url);
    const hasPassport = !!(passport.value && existingDoc && existingDoc.passport_url);
    if (!hasAadhaar && !hasPassport) {
      return res.status(400).json({ error: 'Please provide a complete identity document — either your Aadhaar number and a scan, or your Passport number and a scan.' });
    }

    await db.run(`
      UPDATE participants SET
        email=$1,
        address=$2, travel_mode=$3, travel_number=$4, travel_datetime=$5, arrival_point=$6,
        departure_mode=$7, departure_number=$8, departure_datetime=$9, departure_point=$10,
        shirt_size=$11, tshirt_size=$12, waist_size=$13,
        dietary_preference=$14, drink_preference=$15, special_requests=$16, business_profile=$17,
        aadhaar_number=$18, passport_number=$19
      WHERE id=$20
    `, [
      cleanText(b.email),
      cleanText(b.address), cleanMode(b.travel_mode), cleanText(b.travel_number), cleanText(b.travel_datetime), cleanText(b.arrival_point),
      cleanMode(b.departure_mode), cleanText(b.departure_number), cleanText(b.departure_datetime), cleanText(b.departure_point),
      cleanText(b.shirt_size), cleanText(b.tshirt_size), cleanText(b.waist_size),
      cleanText(b.dietary_preference), cleanText(b.drink_preference), cleanText(b.special_requests), cleanText(b.business_profile),
      aadhaar.value, passport.value,
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

// POST /:type/:id/logo — the member's own company logo. Same shape as the
// business-card upload above; kept separate rather than overloading that one
// because a firm's logo and a scan of a business card serve different
// purposes and both are worth having on file.
router.post('/:type/:id/logo', handleUpload(), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'file is required' });
  // Only host members and volunteers carry a logo_url column — delegates
  // don't, so reject rather than let the UPDATE fail with a SQL error.
  if (!['host_member', 'volunteer'].includes(req.params.type)) {
    return res.status(400).json({ error: 'A company logo can only be added to a Host Member or Volunteer record.' });
  }
  try {
    const verified = await verifyOwnership(req.params.type, req.params.id, req.body.name, req.body.phone);
    if (!verified) return res.status(403).json({ error: 'Name and phone number did not match our records — please look yourself up again.' });
    const existing = await db.get(`SELECT logo_url FROM ${verified.table} WHERE id=$1`, [req.params.id]);
    const storedPath = await saveFile(req.file, `${req.params.type}-logos`);
    await db.run(`UPDATE ${verified.table} SET logo_url=$1 WHERE id=$2`, [storedPath, req.params.id]);
    if (existing && existing.logo_url) await deleteStoredFile(existing.logo_url);
    res.json({ logo_url: storedPath });
  } catch (e) {
    console.error('Public profile logo upload failed —', e.message);
    res.status(500).json({ error: 'Upload failed: ' + e.message });
  }
});

// POST /participant/:id/aadhaar — multipart form with fields: name, phone, file.
// Delegate-only (aadhaar_url only exists on `participants`), same
// unauthenticated re-verification as every other mutation on this route.
// Accepts a PDF scan as well as an image — handleUpload()'s multer instance
// only caps file size, it doesn't restrict mimetype.
router.post('/participant/:id/aadhaar', handleUpload(), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'file is required' });
  try {
    const verified = await verifyOwnership('participant', req.params.id, req.body.name, req.body.phone);
    if (!verified) return res.status(403).json({ error: 'Name and phone number did not match our records — please look yourself up again.' });
    const existing = await db.get('SELECT aadhaar_url FROM participants WHERE id=$1', [req.params.id]);
    const storedPath = await saveFile(req.file, 'participant-aadhaar');
    await db.run('UPDATE participants SET aadhaar_url=$1 WHERE id=$2', [storedPath, req.params.id]);
    if (existing && existing.aadhaar_url) await deleteStoredFile(existing.aadhaar_url);
    res.json({ aadhaar_url: storedPath });
  } catch (e) {
    console.error('Public profile Aadhaar upload failed —', e.message);
    res.status(500).json({ error: 'Upload failed: ' + e.message });
  }
});

// POST /participant/:id/passport — multipart form with fields: name, phone,
// file. Delegate-only, same shape as the Aadhaar upload above — this is the
// alternate identity document for international Delegates who don't have an
// Aadhaar. Accepts a PDF scan as well as an image.
router.post('/participant/:id/passport', handleUpload(), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'file is required' });
  try {
    const verified = await verifyOwnership('participant', req.params.id, req.body.name, req.body.phone);
    if (!verified) return res.status(403).json({ error: 'Name and phone number did not match our records — please look yourself up again.' });
    const existing = await db.get('SELECT passport_url FROM participants WHERE id=$1', [req.params.id]);
    const storedPath = await saveFile(req.file, 'participant-passport');
    await db.run('UPDATE participants SET passport_url=$1 WHERE id=$2', [storedPath, req.params.id]);
    if (existing && existing.passport_url) await deleteStoredFile(existing.passport_url);
    res.json({ passport_url: storedPath });
  } catch (e) {
    console.error('Public profile Passport upload failed —', e.message);
    res.status(500).json({ error: 'Upload failed: ' + e.message });
  }
});

module.exports = router;
