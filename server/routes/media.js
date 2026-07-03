const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const db = require('../db');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 500 * 1024 * 1024 } });

const UPLOAD_ROOT = path.join(__dirname, '..', '..', 'public', 'uploads');

// If Cloudflare R2 (or any S3-compatible bucket) is configured via env vars,
// uploaded videos/posters go there instead of the server's local disk — durable,
// not tied to a single instance, and not wiped on redeploy.
const R2_ENABLED = !!(
  process.env.R2_ACCOUNT_ID &&
  process.env.R2_ACCESS_KEY_ID &&
  process.env.R2_SECRET_ACCESS_KEY &&
  process.env.R2_BUCKET &&
  process.env.R2_PUBLIC_URL_BASE
);

let s3Client = null;
let S3Cmds = null;
if (R2_ENABLED) {
  const { S3Client, PutObjectCommand, DeleteObjectCommand, HeadObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
  S3Cmds = { PutObjectCommand, DeleteObjectCommand, HeadObjectCommand, GetObjectCommand };
  s3Client = new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY
    }
  });
  console.log('Media storage: Cloudflare R2 (bucket: ' + process.env.R2_BUCKET + ')');
} else {
  console.log('Media storage: local disk (public/uploads) — set R2_* env vars to switch to Cloudflare R2');
}

function safeName(original) {
  return original.replace(/[^a-zA-Z0-9.\-_]/g, '_');
}

// Saves the uploaded file and returns the path/URL to store in the DB.
// R2 path returns an absolute https:// URL; local disk returns a relative
// /uploads/... path — the frontend's mediaUrl() helper already handles both.
//
// IMPORTANT: after the R2 write we re-read the object's metadata (HeadObject)
// and confirm its size matches what we tried to upload. This catches the
// class of bug where a flaky connection truncates the upload partway —
// without this check, a broken/incomplete file could get written to R2 (or
// simply never make it) while still looking "successful" to the caller,
// leaving a database row that points at a corrupt or missing file. Better to
// fail loudly here than silently create a broken media entry.
async function saveFile(file, sub) {
  if (!file.buffer || file.buffer.length === 0) {
    throw new Error('The uploaded file came through empty (0 bytes) — likely an interrupted upload. Please try again.');
  }

  const ts = Date.now();
  const key = `${sub}/${ts}-${safeName(file.originalname)}`;

  if (R2_ENABLED) {
    await s3Client.send(new S3Cmds.PutObjectCommand({
      Bucket: process.env.R2_BUCKET,
      Key: key,
      Body: file.buffer,
      ContentType: file.mimetype
    }));

    // Verify the object actually landed intact before we tell the caller (and
    // the database) that this upload succeeded.
    const head = await s3Client.send(new S3Cmds.HeadObjectCommand({ Bucket: process.env.R2_BUCKET, Key: key }));
    if (Number(head.ContentLength) !== file.buffer.length) {
      // Clean up the bad object so it doesn't linger as orphaned storage.
      await s3Client.send(new S3Cmds.DeleteObjectCommand({ Bucket: process.env.R2_BUCKET, Key: key })).catch(() => {});
      throw new Error(`Upload verification failed — expected ${file.buffer.length} bytes but R2 stored ${head.ContentLength}. Please try again (this usually means the network connection dropped mid-upload).`);
    }

    return `${process.env.R2_PUBLIC_URL_BASE.replace(/\/$/, '')}/${key}`;
  }

  const dir = path.join(UPLOAD_ROOT, sub);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${ts}-${safeName(file.originalname)}`), file.buffer);
  return `/uploads/${sub}/${ts}-${safeName(file.originalname)}`;
}

async function deleteStoredFile(storedPath) {
  if (R2_ENABLED && /^https?:\/\//.test(storedPath)) {
    const key = storedPath.replace(process.env.R2_PUBLIC_URL_BASE.replace(/\/$/, '') + '/', '');
    try {
      await s3Client.send(new S3Cmds.DeleteObjectCommand({ Bucket: process.env.R2_BUCKET, Key: key }));
    } catch (e) {
      console.error('Failed to delete R2 object', key, e.message);
    }
    return;
  }
  if (storedPath && storedPath.startsWith('/uploads/')) {
    const filePath = path.join(__dirname, '..', '..', 'public', storedPath);
    fs.unlink(filePath, () => {});
  }
}

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
    const type = req.body.type === 'poster' ? 'poster' : 'video';
    const sub = type === 'poster' ? 'posters' : 'videos';
    const storedPath = await saveFile(req.file, sub);
    const result = await db.run(
      'INSERT INTO media (type, filename, original_name, title, active, sort_order) VALUES ($1,$2,$3,$4,1,$5) RETURNING id',
      [type, storedPath, req.file.originalname, req.body.title || req.file.originalname, Number(req.body.sort_order) || 0]
    );
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
