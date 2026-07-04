const express = require('express');
const db = require('../db');
const { attachChecklistRoutes, deleteChecklistForOwner } = require('./checklistHelper');

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const rows = await db.all(`
      SELECT g.*,
        (SELECT COUNT(*) FROM checklist_items ci WHERE ci.owner_type='guest_visitor' AND ci.owner_id=g.id) AS checklist_total,
        (SELECT COUNT(*) FROM checklist_items ci WHERE ci.owner_type='guest_visitor' AND ci.owner_id=g.id AND ci.status='done') AS checklist_done
      FROM guest_visitors g
      ORDER BY g.visit_date NULLS LAST, g.created_at DESC
    `);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const row = await db.get('SELECT * FROM guest_visitors WHERE id=$1', [req.params.id]);
    if (!row) return res.status(404).json({ error: 'not found' });
    res.json(row);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/', async (req, res) => {
  const { name, designation, organization, phone, email, category, visit_date, status, notes } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });
  try {
    const result = await db.run(`
      INSERT INTO guest_visitors (name, designation, organization, phone, email, category, visit_date, status, notes)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id
    `, [name.trim(), designation || '', organization || '', phone || '', email || '',
        category || '', visit_date || null, status || 'invited', notes || '']);
    res.json({ id: result.id });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.put('/:id', async (req, res) => {
  const { name, designation, organization, phone, email, category, visit_date, status, notes } = req.body;
  try {
    await db.run(`
      UPDATE guest_visitors SET
        name=COALESCE($1,name), designation=COALESCE($2,designation), organization=COALESCE($3,organization),
        phone=COALESCE($4,phone), email=COALESCE($5,email), category=COALESCE($6,category),
        visit_date=$7, status=COALESCE($8,status), notes=COALESCE($9,notes)
      WHERE id=$10
    `, [name || null, designation !== undefined ? designation : null, organization !== undefined ? organization : null,
        phone !== undefined ? phone : null, email !== undefined ? email : null, category !== undefined ? category : null,
        visit_date || null, status || null, notes !== undefined ? notes : null, req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.delete('/:id', async (req, res) => {
  await deleteChecklistForOwner('guest_visitor', req.params.id);
  await db.run('DELETE FROM guest_visitors WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

attachChecklistRoutes(router, 'guest_visitor');

module.exports = router;
