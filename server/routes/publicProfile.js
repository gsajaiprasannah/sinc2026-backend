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
    const rows = await db.all(`
      SELECT id, name, shirt_size, tshirt_size, photo_url, business_card_url
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

// PUT /:type/:id { name, phone, shirt_size, tshirt_size }
router.put('/:type/:id', async (req, res) => {
  const { name, phone, shirt_size, tshirt_size } = req.body;
  try {
    const verified = await verifyOwnership(req.params.type, req.params.id, name, phone);
    if (!verified) return res.status(403).json({ error: 'Name and phone number did not match our records — please look yourself up again.' });
    await db.run(`UPDATE ${verified.table} SET shirt_size=$1, tshirt_size=$2 WHERE id=$3`, [
      shirt_size || null, tshirt_size || null, req.params.id
    ]);
    res.json({ ok: true });
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
