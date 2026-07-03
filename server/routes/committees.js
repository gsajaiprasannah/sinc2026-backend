const express = require('express');
const db = require('../db');

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const rows = await db.all(`
      SELECT c.*,
        COALESCE(
          (SELECT json_agg(json_build_object('id', hm.id, 'name', hm.name, 'company', hm.company, 'phone', hm.phone) ORDER BY hm.name)
           FROM committee_members cm JOIN host_members hm ON hm.id = cm.host_member_id
           WHERE cm.committee_id = c.id),
          '[]'
        ) AS members
      FROM committees c
      ORDER BY c.sort_order, c.name
    `);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/', async (req, res) => {
  const { name, sort_order } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  try {
    const dup = await db.get('SELECT id FROM committees WHERE lower(trim(name)) = lower(trim($1))', [name]);
    if (dup) return res.status(409).json({ error: `A committee named "${name}" already exists.` });
    const result = await db.run(
      'INSERT INTO committees (name, sort_order) VALUES ($1,$2) RETURNING id',
      [name, Number(sort_order) || 0]
    );
    res.json({ id: result.id });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.put('/:id', async (req, res) => {
  const { name, sort_order } = req.body;
  try {
    if (name !== undefined) {
      const dup = await db.get('SELECT id FROM committees WHERE lower(trim(name)) = lower(trim($1)) AND id <> $2', [name, req.params.id]);
      if (dup) return res.status(409).json({ error: `A committee named "${name}" already exists.` });
    }
    await db.run(
      'UPDATE committees SET name=COALESCE($1,name), sort_order=COALESCE($2,sort_order) WHERE id=$3',
      [name || null, sort_order !== undefined ? Number(sort_order) : null, req.params.id]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.delete('/:id', async (req, res) => {
  await db.run('DELETE FROM committees WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

// Add a host member to a committee
router.post('/:id/members', async (req, res) => {
  const { host_member_id } = req.body;
  if (!host_member_id) return res.status(400).json({ error: 'host_member_id is required' });
  try {
    await db.run(
      'INSERT INTO committee_members (committee_id, host_member_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
      [req.params.id, host_member_id]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.delete('/:id/members/:hostMemberId', async (req, res) => {
  await db.run(
    'DELETE FROM committee_members WHERE committee_id=$1 AND host_member_id=$2',
    [req.params.id, req.params.hostMemberId]
  );
  res.json({ ok: true });
});

module.exports = router;
