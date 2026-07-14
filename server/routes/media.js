const express = require('express');
const multer = require('multer');
const path = require('path');
const db = require('../db');
const { R2_ENABLED, saveFile, deleteStoredFile, s3Client, S3Cmds } = require('../uploadHelper');
const push = require('../pushHelper');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 500 * 1024 * 1024 } });

console.log(R2_ENABLED
  ? 'Media storage: Cloudflare R2 (bucket: ' + process.env.R2_BUCKET + ')'
  : 'Media storage: local disk (public/uploads) — set R2_* env vars to switch to Cloudflare R2');

// saveFile()/deleteStoredFile() now live in server/uploadHelper.js, shared
// with the sponsor-logo and speaker-photo uploads in sponsors.js/speakers.js
// — see that file for the R2-vs-local-disk + upload-verification logic.

router.get('/', async (req, res) => {
  try {
    const type = req.query.type;
    const rows = type
      ? await db.all('SELECT * FROM media WHERE type = $1 ORDER BY sort_order ASC, uploaded_at ASC', [type])
      : await db.all('SELECT * FROM media ORDER BY type, sort_order ASC, uploaded_at ASC');
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Forces a real download (correct filename, Content-Disposition: attachment)
// instead of the browser trying to play/preview the file inline. We stream it
// through our own server rather than linking straight to the R2/public URL —
// that way this works regardless of the bucket's CORS configuration, and the
// downloaded file always gets a friendly name instead of a timestamped key.
router.get('/:id/download', async (req, res) => {
  try {
    const row = await db.get('SELECT * FROM media WHERE id=$1', [req.params.id]);
    if (!row) return res.status(404).json({ error: 'Not found' });

    const extMatch = row.filename.match(/\.([a-zA-Z0-9]+)(?:$|\?)/);
    const ext = extMatch ? extMatch[1] : '';
    let baseName = (row.original_name || row.title || `media-${row.id}`).replace(/[^a-zA-Z0-9.\-_ ]/g, '_').trim();
    if (ext && !baseName.toLowerCase().endsWith('.' + ext.toLowerCase())) baseName += '.' + ext;
    const downloadName = baseName || `media-${row.id}`;

    if (R2_ENABLED && /^https?:\/\//.test(row.filename)) {
      const key = row.filename.replace(process.env.R2_PUBLIC_URL_BASE.replace(/\/$/, '') + '/', '');
      const obj = await s3Client.send(new S3Cmds.GetObjectCommand({ Bucket: process.env.R2_BUCKET, Key: key }));
      res.setHeader('Content-Disposition', `attachment; filename="${downloadName.replace(/"/g, '')}"`);
      res.setHeader('Content-Type', obj.ContentType || 'application/octet-stream');
      if (obj.ContentLength) res.setHeader('Content-Length', obj.ContentLength);
      obj.Body.pipe(res);
      return;
    }

    if (row.filename && row.filename.startsWith('/uploads/')) {
      const filePath = path.join(__dirname, '..', '..', 'public', row.filename);
      return res.download(filePath, downloadName);
    }

    res.status(404).json({ error: 'File location unknown' });
  } catch (e) {
    console.error('Media download failed —', e.message);
    res.status(500).json({ error: 'Download failed: ' + e.message });
  }
});

router.post('/upload', (req, res, next) => {
  // Run multer manually (instead of as route middleware) so we can catch its
  // errors — e.g. LIMIT_FILE_SIZE, or a multipart stream that ends early
  // because the client's connection dropped mid-upload — and return a clean
  // JSON error instead of letting Express fall through to its default HTML
  // error page (which the admin panel's fetch() can't parse, and previously
  // just showed as a cryptic failure with no real explanation).
  upload.single('file')(req, res, (err) => {
    if (err) {
      console.error('Media upload: multer/stream error —', err.message);
      const friendly = err.code === 'LIMIT_FILE_SIZE'
        ? 'File is too large (max 500MB).'
        : 'Upload was interrupted before it finished (likely a dropped connection). Please try again.';
      return res.status(400).json({ error: friendly });
    }
    next();
  });
}, async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'file is required' });
  try {
    const type = req.body.type === 'poster' ? 'poster' : req.body.type === 'document' ? 'document' : 'video';
    const sub = type === 'poster' ? 'posters' : type === 'document' ? 'documents' : 'videos';
    const storedPath = await saveFile(req.file, sub);
    const result = await db.run(
      'INSERT INTO media (type, filename, original_name, title, active, sort_order) VALUES ($1,$2,$3,$4,1,$5) RETURNING id',
      [type, storedPath, req.file.originalname, req.body.title || req.file.originalname, Number(req.body.sort_order) || 0]
    );
    // "New upload alert" — nudge admin/super_admin/host_member logins that
    // there's fresh content on the public homepage's video reel/posters.
    const label = req.body.title || req.file.originalname;
    push.sendToRoles(['admin', 'super_admin', 'host_member'], {
      title: `New ${type} uploaded`,
      body: label,
      url: 'index.html'
    }).catch((e) => console.error('media upload push failed', e.message));
    res.json({ id: result.id, path: storedPath });
  } catch (e) {
    console.error('Media upload failed —', e.message);
    res.status(500).json({ error: 'Upload failed: ' + e.message });
  }
});

router.put('/:id', async (req, res) => {
  const { title, active, sort_order } = req.body;
  try {
    await db.run(
      'UPDATE media SET title=COALESCE($1,title), active=COALESCE($2,active), sort_order=COALESCE($3,sort_order) WHERE id=$4',
      [title || null, active !== undefined ? Number(active) : null, sort_order !== undefined ? Number(sort_order) : null, req.params.id]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.delete('/:id', async (req, res) => {
  const row = await db.get('SELECT * FROM media WHERE id=$1', [req.params.id]);
  if (row) await deleteStoredFile(row.filename);
  await db.run('DELETE FROM media WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

module.exports = router;
