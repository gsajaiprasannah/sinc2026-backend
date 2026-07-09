const express = require('express');
const multer = require('multer');
const db = require('../db');
const { attachChecklistRoutes, deleteChecklistForOwner } = require('./checklistHelper');
const { saveFile, deleteStoredFile } = require('../uploadHelper');
const { logActivity } = require('../lib/activityLogger');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } }); // photos: 10MB is plenty

router.get('/', async (req, res) => {
  try {
    const rows = await db.all(`
      SELECT s.*, hm.name AS guest_relation_name,
        (SELECT COUNT(*) FROM checklist_items ci WHERE ci.owner_type='speaker' AND ci.owner_id=s.id) AS checklist_total,
        (SELECT COUNT(*) FROM checklist_items ci WHERE ci.owner_type='speaker' AND ci.owner_id=s.id AND ci.status='done') AS checklist_done
      FROM speakers s
      LEFT JOIN host_members hm ON hm.id = s.guest_relation_host_member_id
      ORDER BY s.created_at DESC
    `);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const row = await db.get(`
      SELECT s.*, hm.name AS guest_relation_name
      FROM speakers s LEFT JOIN host_members hm ON hm.id = s.guest_relation_host_member_id
      WHERE s.id=$1
    `, [req.params.id]);
    if (!row) return res.status(404).json({ error: 'not found' });
    res.json(row);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/', async (req, res) => {
  const { name, designation, organization, phone, email, topic, session_type, guest_relation_host_member_id, status, notes } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });
  try {
    const result = await db.run(`
      INSERT INTO speakers (name, designation, organization, phone, email, topic, session_type, guest_relation_host_member_id, status, notes)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id
    `, [name.trim(), designation || '', organization || '', phone || '', email || '',
        topic || '', session_type || 'Speaker', guest_relation_host_member_id || null, status || 'invited', notes || '']);
    logActivity(req.user, { action: 'create', entityType: 'speaker', entityId: result.id, label: name.trim() });
    res.json({ id: result.id });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.put('/:id', async (req, res) => {
  const { name, designation, organization, phone, email, topic, session_type, guest_relation_host_member_id, status, notes } = req.body;
  try {
    await db.run(`
      UPDATE speakers SET
        name=COALESCE($1,name), designation=COALESCE($2,designation), organization=COALESCE($3,organization),
        phone=COALESCE($4,phone), email=COALESCE($5,email), topic=COALESCE($6,topic),
        session_type=COALESCE($7,session_type), guest_relation_host_member_id=$8,
        status=COALESCE($9,status), notes=COALESCE($10,notes)
      WHERE id=$11
    `, [name || null, designation !== undefined ? designation : null, organization !== undefined ? organization : null,
        phone !== undefined ? phone : null, email !== undefined ? email : null, topic !== undefined ? topic : null,
        session_type || null, guest_relation_host_member_id || null, status || null, notes !== undefined ? notes : null, req.params.id]);
    logActivity(req.user, { action: 'update', entityType: 'speaker', entityId: Number(req.params.id), label: name });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.delete('/:id', async (req, res) => {
  const row = await db.get('SELECT name, photo_url FROM speakers WHERE id=$1', [req.params.id]);
  if (row) await deleteStoredFile(row.photo_url);
  await deleteChecklistForOwner('speaker', req.params.id);
  await db.run('DELETE FROM speakers WHERE id=$1', [req.params.id]);
  logActivity(req.user, { action: 'delete', entityType: 'speaker', entityId: Number(req.params.id), label: row?.name });
  res.json({ ok: true });
});

// Speaker photo — shown on the public homepage next to the speaker's name.
// Replaces any existing photo (old file is deleted so storage doesn't leak).
router.post('/:id/photo', (req, res, next) => {
  upload.single('file')(req, res, (err) => {
    if (err) {
      const friendly = err.code === 'LIMIT_FILE_SIZE' ? 'Photo is too large (max 10MB).' : 'Upload was interrupted — please try again.';
      return res.status(400).json({ error: friendly });
    }
    next();
  });
}, async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'file is required' });
  try {
    const existing = await db.get('SELECT photo_url FROM speakers WHERE id=$1', [req.params.id]);
    if (!existing) return res.status(404).json({ error: 'Speaker not found' });
    const storedPath = await saveFile(req.file, 'speaker-photos');
    await db.run('UPDATE speakers SET photo_url=$1 WHERE id=$2', [storedPath, req.params.id]);
    if (existing.photo_url) await deleteStoredFile(existing.photo_url);
    res.json({ photo_url: storedPath });
  } catch (e) {
    console.error('Speaker photo upload failed —', e.message);
    res.status(500).json({ error: 'Upload failed: ' + e.message });
  }
});

router.delete('/:id/photo', async (req, res) => {
  try {
    const existing = await db.get('SELECT photo_url FROM speakers WHERE id=$1', [req.params.id]);
    if (!existing) return res.status(404).json({ error: 'Speaker not found' });
    await db.run('UPDATE speakers SET photo_url=NULL WHERE id=$1', [req.params.id]);
    if (existing.photo_url) await deleteStoredFile(existing.photo_url);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

attachChecklistRoutes(router, 'speaker');

module.exports = router;
