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
  const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
  S3Cmds = { PutObjectCommand, DeleteObjectCommand };
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
async function saveFile(file, sub) {
  const ts = Date.now();
  const key = `${sub}/${ts}-${safeName(file.originalname)}`;

  if (R2_ENABLED) {
    await s3Client.send(new S3Cmds.PutObjectCommand({
      Bucket: process.env.R2_BUCKET,
      Key: key,
      Body: file.buffer,
      ContentType: file.mimetype
    }));
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

router.post('/upload', upload.single('file'), async (req, res) => {
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
