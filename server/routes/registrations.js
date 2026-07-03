const express = require('express');
const multer = require('multer');
const { parse } = require('csv-parse/sync');
const db = require('../db');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

router.get('/', async (req, res) => {
  try {
    const rows = await db.all(`
      SELECT r.*, c.name AS club_name,
        (SELECT COUNT(*) FROM participants p WHERE p.registration_id = r.id) AS participant_count
      FROM registrations r LEFT JOIN clubs c ON c.id = r.club_id
      ORDER BY r.created_at DESC
    `);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/', async (req, res) => {
  const { reg_number, reg_type, club_id, amount_paid, amount_due, payment_mode, payment_status, payment_ref } = req.body;
  if (!reg_number || !reg_type) return res.status(400).json({ error: 'reg_number and reg_type are required' });
  try {
    const result = await db.run(`
      INSERT INTO registrations (reg_number, reg_type, club_id, amount_paid, amount_due, payment_mode, payment_status, payment_ref)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id
    `, [reg_number, reg_type, club_id || null, Number(amount_paid) || 0, Number(amount_due) || 0,
        payment_mode || '', payment_status || 'pending', payment_ref || '']);
    res.json({ id: result.id });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.put('/:id', async (req, res) => {
  const { reg_type, club_id, amount_paid, amount_due, payment_mode, payment_status, payment_ref } = req.body;
  try {
    await db.run(`
      UPDATE registrations SET
        reg_type=COALESCE($1,reg_type), club_id=COALESCE($2,club_id),
        amount_paid=COALESCE($3,amount_paid), amount_due=COALESCE($4,amount_due),
        payment_mode=COALESCE($5,payment_mode), payment_status=COALESCE($6,payment_status),
        payment_ref=COALESCE($7,payment_ref)
      WHERE id=$8
    `, [reg_type || null, club_id || null,
        amount_paid !== undefined ? Number(amount_paid) : null,
        amount_due !== undefined ? Number(amount_due) : null,
        payment_mode || null, payment_status || null, payment_ref || null, req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.delete('/:id', async (req, res) => {
  await db.run('DELETE FROM registrations WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

// Bulk CSV: reg_number,reg_type,club_name,amount_paid,amount_due,payment_mode,payment_status,payment_ref
router.post('/bulk-upload', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'CSV file is required (field name: file)' });
  try {
    const records = parse(req.file.buffer.toString('utf8'), { columns: true, skip_empty_lines: true, trim: true });
    let imported = 0;
    await db.transaction(async (tx) => {
      for (const r of records) {
        const clubName = r.club_name || r.club || r.Club;
        const club = clubName ? await tx.get('SELECT id FROM clubs WHERE name = $1', [clubName]) : null;
        await tx.run(`
          INSERT INTO registrations (reg_number, reg_type, club_id, amount_paid, amount_due, payment_mode, payment_status, payment_ref)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
          ON CONFLICT (reg_number) DO UPDATE SET
            reg_type=excluded.reg_type, club_id=excluded.club_id, amount_paid=excluded.amount_paid,
            amount_due=excluded.amount_due, payment_mode=excluded.payment_mode,
            payment_status=excluded.payment_status, payment_ref=excluded.payment_ref
        `, [
          r.reg_number || r.RegNumber,
          (r.reg_type || r.type || 'single').toLowerCase(),
          club ? club.id : null,
          Number(r.amount_paid || 0),
          Number(r.amount_due || 0),
          r.payment_mode || '',
          r.payment_status || 'pending',
          r.payment_ref || ''
        ]);
        imported++;
      }
    });
    res.json({ ok: true, imported });
  } catch (e) {
    res.status(400).json({ error: 'Failed to parse/import CSV: ' + e.message });
  }
});

module.exports = router;
