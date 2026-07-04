const express = require('express');
const db = require('../db');
const { attachChecklistRoutes, deleteChecklistForOwner } = require('./checklistHelper');

const router = express.Router();

// Sponsor pass identifiers: SP-0001, SP-0002, ... — same advisory-lock
// pattern as vehicle codes, so two concurrent submits can't collide.
async function computeNextSponsorPassCode(runner) {
  const row = await runner.get(`
    SELECT COALESCE(MAX((regexp_match(sponsor_pass_code, '(\\d+)$'))[1]::int), 0) AS max_num
    FROM sponsors WHERE sponsor_pass_code LIKE 'SP-%'
  `);
  return 'SP-' + String((row && row.max_num ? row.max_num : 0) + 1).padStart(4, '0');
}

router.get('/', async (req, res) => {
  try {
    const rows = await db.all(`
      SELECT s.*, hm.name AS guest_relation_name,
        (SELECT COUNT(*) FROM checklist_items ci WHERE ci.owner_type='sponsor' AND ci.owner_id=s.id) AS checklist_total,
        (SELECT COUNT(*) FROM checklist_items ci WHERE ci.owner_type='sponsor' AND ci.owner_id=s.id AND ci.status='done') AS checklist_done
      FROM sponsors s
      LEFT JOIN host_members hm ON hm.id = s.guest_relation_host_member_id
      ORDER BY s.created_at DESC
    `);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/next-code', async (req, res) => {
  try {
    res.json({ sponsor_pass_code: await computeNextSponsorPassCode(db) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const row = await db.get(`
      SELECT s.*, hm.name AS guest_relation_name
      FROM sponsors s LEFT JOIN host_members hm ON hm.id = s.guest_relation_host_member_id
      WHERE s.id=$1
    `, [req.params.id]);
    if (!row) return res.status(404).json({ error: 'not found' });
    res.json(row);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/', async (req, res) => {
  let { name, tier, contact_person, phone, email, sponsor_pass_code, guest_relation_host_member_id, status, notes } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });
  try {
    const result = await db.transaction(async (tx) => {
      await tx.run('SELECT pg_advisory_xact_lock(778901)');
      if (!sponsor_pass_code || !sponsor_pass_code.trim()) {
        sponsor_pass_code = await computeNextSponsorPassCode(tx);
      }
      return tx.run(`
        INSERT INTO sponsors (name, tier, contact_person, phone, email, sponsor_pass_code, guest_relation_host_member_id, status, notes)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id
      `, [name.trim(), tier || '', contact_person || '', phone || '', email || '', sponsor_pass_code,
          guest_relation_host_member_id || null, status || 'confirmed', notes || '']);
    });
    res.json({ id: result.id, sponsor_pass_code });
  } catch (e) {
    if (e.code === '23505') {
      return res.status(409).json({ error: `Sponsor pass code "${sponsor_pass_code}" already exists. Please try again.` });
    }
    res.status(400).json({ error: e.message });
  }
});

router.put('/:id', async (req, res) => {
  const { name, tier, contact_person, phone, email, guest_relation_host_member_id, status, notes } = req.body;
  try {
    await db.run(`
      UPDATE sponsors SET
        name=COALESCE($1,name), tier=COALESCE($2,tier), contact_person=COALESCE($3,contact_person),
        phone=COALESCE($4,phone), email=COALESCE($5,email),
        guest_relation_host_member_id=$6,
        status=COALESCE($7,status), notes=COALESCE($8,notes)
      WHERE id=$9
    `, [name || null, tier !== undefined ? tier : null, contact_person !== undefined ? contact_person : null,
        phone !== undefined ? phone : null, email !== undefined ? email : null,
        guest_relation_host_member_id || null, status || null, notes !== undefined ? notes : null, req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.delete('/:id', async (req, res) => {
  await deleteChecklistForOwner('sponsor', req.params.id);
  await db.run('DELETE FROM sponsors WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

attachChecklistRoutes(router, 'sponsor');

module.exports = router;
