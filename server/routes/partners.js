const express = require('express');
const db = require('../db');
const { logActivity } = require('../lib/activityLogger');

const router = express.Router();

function normPhone(p) {
  return (p || '').replace(/\D/g, '').slice(-10);
}

async function findDuplicatePartner({ name, category, phone, excludeId }) {
  const np = normPhone(phone);
  if (np) {
    let sql = `SELECT id, name, category FROM partners WHERE phone <> '' AND RIGHT(regexp_replace(phone, '[^0-9]', '', 'g'), 10) = $1`;
    const params = [np];
    if (excludeId) { sql += ' AND id <> $2'; params.push(excludeId); }
    const row = await db.get(sql, params);
    if (row) return row;
  }
  let sql = `SELECT id, name, category FROM partners WHERE lower(trim(name)) = lower(trim($1)) AND category = $2`;
  const params = [name, category || 'other'];
  if (excludeId) { sql += ' AND id <> $3'; params.push(excludeId); }
  return db.get(sql, params);
}

router.get('/', async (req, res) => {
  try {
    const rows = await db.all('SELECT * FROM partners ORDER BY category, name');
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/', async (req, res) => {
  const { category, name, contact_person, phone, email, notes, force } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  try {
    if (!force) {
      const dup = await findDuplicatePartner({ name, category, phone });
      if (dup) return res.status(409).json({ error: `A ${dup.category} partner named "${dup.name}" already exists.`, existing: dup });
    }
    const result = await db.run(`
      INSERT INTO partners (category, name, contact_person, phone, email, notes)
      VALUES ($1,$2,$3,$4,$5,$6) RETURNING id
    `, [category || 'other', name, contact_person || '', phone || '', email || '', notes || '']);
    logActivity(req.user, { action: 'create', entityType: 'partner', entityId: result.id, label: name });
    res.json({ id: result.id });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.put('/:id', async (req, res) => {
  const { category, name, contact_person, phone, email, notes } = req.body;
  try {
    await db.run(`
      UPDATE partners SET
        category=COALESCE($1,category), name=COALESCE($2,name), contact_person=COALESCE($3,contact_person),
        phone=COALESCE($4,phone), email=COALESCE($5,email), notes=COALESCE($6,notes)
      WHERE id=$7
    `, [category || null, name || null, contact_person || null, phone || null, email || null,
        notes !== undefined ? notes : null, req.params.id]);
    logActivity(req.user, { action: 'update', entityType: 'partner', entityId: Number(req.params.id), label: name });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.delete('/:id', async (req, res) => {
  const existing = await db.get('SELECT name FROM partners WHERE id=$1', [req.params.id]);
  await db.run('DELETE FROM partners WHERE id=$1', [req.params.id]);
  logActivity(req.user, { action: 'delete', entityType: 'partner', entityId: Number(req.params.id), label: existing?.name });
  res.json({ ok: true });
});

module.exports = router;
