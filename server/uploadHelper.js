const path = require('path');
const fs = require('fs');

// Shared file-storage helper used by media.js (video/poster reel) and, now,
// sponsors.js (logo) + speakers.js (photo). Pulled out of media.js so every
// upload path — reel media or a sponsor logo/speaker photo — gets the exact
// same "which backend (R2 vs local disk), verify-after-write" behavior
// instead of three copies of the same logic drifting apart over time.

const UPLOAD_ROOT = path.join(__dirname, '..', 'public', 'uploads');

// If Cloudflare R2 (or any S3-compatible bucket) is configured via env vars,
// uploads go there instead of the server's local disk — durable, not tied to
// a single instance, and not wiped on redeploy.
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
}

function safeName(original) {
  return original.replace(/[^a-zA-Z0-9.\-_]/g, '_');
}

// Saves the uploaded file and returns the path/URL to store in the DB.
// R2 path returns an absolute https:// URL; local disk returns a relative
// /uploads/... path — the frontend's mediaUrl()-style helper handles both.
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
  if (!storedPath) return;
  if (R2_ENABLED && /^https?:\/\//.test(storedPath)) {
    const key = storedPath.replace(process.env.R2_PUBLIC_URL_BASE.replace(/\/$/, '') + '/', '');
    try {
      await s3Client.send(new S3Cmds.DeleteObjectCommand({ Bucket: process.env.R2_BUCKET, Key: key }));
    } catch (e) {
      console.error('Failed to delete stored object', key, e.message);
    }
    return;
  }
  if (storedPath.startsWith('/uploads/')) {
    const filePath = path.join(__dirname, '..', 'public', storedPath);
    fs.unlink(filePath, () => {});
  }
}

module.exports = { R2_ENABLED, UPLOAD_ROOT, saveFile, deleteStoredFile, safeName, s3Client, S3Cmds };
