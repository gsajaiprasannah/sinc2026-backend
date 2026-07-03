const express = require('express');
const multer = require('multer');
const { parse } = require('csv-parse/sync');
const db = require('../db');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

router.get('/', async (req, res) => {
  try {
    const rows = await db.all(`
      SELECT hm.*,
        COALESCE(
          (SELECT json_agg(json_build_object('id', c.id, 'name', c.name))
           FROM committee_members cmem JOIN committees c ON c.id = cmem.committee_id
           WHERE cmem.host_member_id = hm.id),
          '[]'
        ) AS committees,
        (SELECT COUNT(*) FROM delegate_assignments da WHERE da.host_member_id = hm.id) AS assignment_count,
        (SELECT u.id FROM users u WHERE u.host_member_id = hm.id LIMIT 1) AS user_id
      FROM host_members hm
      ORDER BY hm.name
    `);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const row = await db.get('SELECT * FROM host_members WHERE id=$1', [req.params.id]);
    if (!row) return res.status(404).json({ error: 'not found' });
    res.json(row);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/', async (req, res) => {
  const { name, email, phone, company, designation, category, payment_status, payment_amount, payment_date, payment_mode, notes } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  try {
    const result = await db.run(`
      INSERT INTO host_members (name, email, phone, company, designation, category, payment_status, payment_amount, payment_date, payment_mode, notes)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id
    `, [name, email || '', phone || '', company || '', designation || '', category || '',
        payment_status || 'pending', Number(payment_amount) || 5000, payment_date || null, payment_mode || '', notes || '']);
    res.json({ id: result.id });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.put('/:id', async (req, res) => {
  const { name, email, phone, company, designation, category, payment_status, payment_amount, payment_date, payment_mode, notes } = req.body;
  try {
    await db.run(`
      UPDATE host_members SET
        name=COALESCE($1,name), email=COALESCE($2,email), phone=COALESCE($3,phone),
        company=COALESCE($4,company), designation=COALESCE($5,designation), category=COALESCE($6,category),
        payment_status=COALESCE($7,payment_status), payment_amount=COALESCE($8,payment_amount),
        payment_date=COALESCE($9,payment_date), payment_mode=COALESCE($10,payment_mode), notes=COALESCE($11,notes)
      WHERE id=$12
    `, [name || null, email || null, phone || null, company || null, designation || null, category || null,
        payment_status || null, payment_amount !== undefined ? Number(payment_amount) : null,
        payment_date || null, payment_mode || null, notes !== undefined ? notes : null, req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.delete('/:id', async (req, res) => {
  await db.run('DELETE FROM host_members WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

// Bulk CSV upload: name,email,phone,company,designation,category
router.post('/bulk-upload', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'CSV file is required (field name: file)' });
  try {
    const records = parse(req.file.buffer.toString('utf8'), { columns: true, skip_empty_lines: true, trim: true });
    let imported = 0;
    await db.transaction(async (tx) => {
      for (const r of records) {
        await tx.run(`
          INSERT INTO host_members (name, email, phone, company, designation, category)
          VALUES ($1,$2,$3,$4,$5,$6)
        `, [r.name || r.Name, r.email || '', r.phone || '', r.company || '', r.designation || '', r.category || '']);
        imported++;
      }
    });
    res.json({ ok: true, imported });
  } catch (e) {
    res.status(400).json({ error: 'Failed to parse/import CSV: ' + e.message });
  }
});

module.exports = router;
