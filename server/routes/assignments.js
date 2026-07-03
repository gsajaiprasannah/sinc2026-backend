const express = require('express');
const db = require('../db');

const router = express.Router();

// Admin-side view of every host-member ↔ delegate assistance assignment,
// with enough joined context (names, club, reg #) to make the table useful
// without a second lookup.
router.get('/', async (req, res) => {
  try {
    const rows = await db.all(`
      SELECT da.*,
        hm.name AS host_member_name, hm.phone AS host_member_phone, hm.company AS host_member_company,
        p.name AS participant_name, p.participant_code, p.phone AS participant_phone,
        c.name AS club_name, r.reg_number
      FROM delegate_assignments da
      JOIN host_members hm ON hm.id = da.host_member_id
      JOIN participants p ON p.id = da.participant_id
      LEFT JOIN clubs c ON c.id = p.club_id
      LEFT JOIN registrations r ON r.id = p.registration_id
      ORDER BY da.created_at DESC
    `);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/', async (req, res) => {
  const { host_member_id, participant_id, role, status, notes } = req.body;
  if (!host_member_id || !participant_id) {
    return res.status(400).json({ error: 'host_member_id and participant_id are required' });
  }
  try {
    const result = await db.run(`
      INSERT INTO delegate_assignments (host_member_id, participant_id, role, status, notes)
      VALUES ($1,$2,$3,$4,$5) RETURNING id
    `, [host_member_id, participant_id, role || 'assistance', status || 'not_started', notes || '']);
    res.json({ id: result.id });
  } catch (e) {
    if (e.message && e.message.includes('duplicate key')) {
      return res.status(409).json({ error: 'This host member is already assigned to this delegate.' });
    }
    res.status(400).json({ error: e.message });
  }
});

// Convenience endpoint for the Participants tab: sets (or clears, if
// host_member_id is omitted) the single "SPOC" delegate_assignment for a
// participant in one call, instead of managing it through the general
// assignment CRUD above. Keeps at most one SPOC assignment per delegate.
router.put('/spoc/:participantId', async (req, res) => {
  const { host_member_id } = req.body;
  const participantId = req.params.participantId;
  try {
    await db.transaction(async (tx) => {
      await tx.run(`DELETE FROM delegate_assignments WHERE participant_id=$1 AND role='SPOC'`, [participantId]);
      if (host_member_id) {
        await tx.run(`
          INSERT INTO delegate_assignments (host_member_id, participant_id, role, status)
          VALUES ($1,$2,'SPOC','not_started')
          ON CONFLICT (host_member_id, participant_id) DO UPDATE SET role='SPOC'
        `, [host_member_id, participantId]);
      }
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.put('/:id', async (req, res) => {
  const { role, status, notes } = req.body;
  try {
    await db.run(`
      UPDATE delegate_assignments SET
        role=COALESCE($1,role), status=COALESCE($2,status), notes=COALESCE($3,notes), updated_at=NOW()
      WHERE id=$4
    `, [role || null, status || null, notes !== undefined ? notes : null, req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.delete('/:id', async (req, res) => {
  await db.run('DELETE FROM delegate_assignments WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

module.exports = router;
