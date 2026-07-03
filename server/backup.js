// Secondary backup layer: exports every table as a single timestamped JSON
// file and uploads it to Cloudflare R2 (or any S3-compatible bucket).
//
// This is NOT a replacement for Render's built-in automatic Postgres backups
// (daily snapshots + point-in-time recovery) — it's a belt-and-suspenders copy
// that lives outside Render entirely, in case something ever happens to the
// database instance itself. Runs automatically once a week (see index.js) and
// can also be triggered on demand via POST /api/admin/backup-now.
//
// No-op if R2 env vars aren't set, so this is safe to leave in even before
// R2 is configured.

const db = require('./db');

const R2_ENABLED = !!(
  process.env.R2_ACCOUNT_ID &&
  process.env.R2_ACCESS_KEY_ID &&
  process.env.R2_SECRET_ACCESS_KEY &&
  process.env.R2_BUCKET
);

async function runBackup() {
  if (!R2_ENABLED) {
    return { ok: false, skipped: true, reason: 'R2 env vars not set — backup skipped' };
  }

  const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
  const s3Client = new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY
    }
  });

  const [clubs, registrations, participants, media, happenings] = await Promise.all([
    db.all('SELECT * FROM clubs'),
    db.all('SELECT * FROM registrations'),
    db.all('SELECT * FROM participants'),
    db.all('SELECT * FROM media'),
    db.all('SELECT * FROM happenings')
  ]);

  const dump = {
    exported_at: new Date().toISOString(),
    clubs, registrations, participants, media, happenings
  };

  const key = `backups/sinc2026-backup-${new Date().toISOString().slice(0, 10)}.json`;
  await s3Client.send(new PutObjectCommand({
    Bucket: process.env.R2_BUCKET,
    Key: key,
    Body: JSON.stringify(dump, null, 2),
    ContentType: 'application/json'
  }));

  console.log(`Backup written to R2: ${key} (${clubs.length} clubs, ${registrations.length} registrations, ${participants.length} participants)`);
  return { ok: true, key, counts: { clubs: clubs.length, registrations: registrations.length, participants: participants.length, media: media.length, happenings: happenings.length } };
}

module.exports = { runBackup };
