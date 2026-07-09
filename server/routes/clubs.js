const express = require('express');
const multer = require('multer');
const { parse } = require('csv-parse/sync');
const db = require('../db');
const { logActivity } = require('../lib/activityLogger');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

router.get('/', async (req, res) => {
  try {
    const clubs = await db.all('SELECT * FROM clubs ORDER BY members_count DESC');
    res.json(clubs);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/', async (req, res) => {
  const { name, city, state, zone, members_count } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  try {
    const result = await db.run(
      'INSERT INTO clubs (name, city, state, zone, members_count) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      [name, city || '', state || '', zone || '', Number(members_count) || 0]
    );
    logActivity(req.user, { action: 'create', entityType: 'club', entityId: result.id, label: name });
    res.json({ id: result.id });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.put('/:id', async (req, res) => {
  const { name, city, state, zone, members_count } = req.body;
  try {
    await db.run(
      `UPDATE clubs SET name=COALESCE($1,name), city=COALESCE($2,city), state=COALESCE($3,state),
       zone=COALESCE($4,zone), members_count=COALESCE($5,members_count), updated_at=NOW() WHERE id=$6`,
      [name || null, city || null, state || null, zone || null,
       members_count !== undefined ? Number(members_count) : null, req.params.id]
    );
    logActivity(req.user, { action: 'update', entityType: 'club', entityId: Number(req.params.id), label: name });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.delete('/:id', async (req, res) => {
  const existing = await db.get('SELECT name FROM clubs WHERE id=$1', [req.params.id]);
  await db.run('DELETE FROM clubs WHERE id=$1', [req.params.id]);
  logActivity(req.user, { action: 'delete', entityType: 'club', entityId: Number(req.params.id), label: existing?.name });
  res.json({ ok: true });
});

// Bulk CSV upload: columns name,city,state,zone,members_count
router.post('/bulk-upload', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'CSV file is required (field name: file)' });
  try {
    const records = parse(req.file.buffer.toString('utf8'), {
      columns: true,
      skip_empty_lines: true,
      trim: true
    });
    let imported = 0;
    await db.transaction(async (tx) => {
      for (const r of records) {
        await tx.run(
          `INSERT INTO clubs (name, city, state, zone, members_count)
           VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (name) DO UPDATE SET
             city=excluded.city, state=excluded.state, zone=excluded.zone,
             members_count=excluded.members_count, updated_at=NOW()`,
          [
            r.name || r.Name || r.club || r.Club,
            r.city || r.City || '',
            r.state || r.State || '',
            r.zone || r.Zone || r.region || r.Region || '',
            Number(r.members_count || r.Members || r.members || 0)
          ]
        );
        imported++;
      }
    });
    res.json({ ok: true, imported });
  } catch (e) {
    res.status(400).json({ error: 'Failed to parse/import CSV: ' + e.message });
  }
});

module.exports = router;
