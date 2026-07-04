// Delivery Monitor — cross-committee visibility into every checklist item
// across every category (Sponsors, Guest Speakers, Guest Visitors, Delegates,
// Host Members), so "who's actually handing this over, and are they late"
// can be answered in one place instead of clicking into each sponsor/speaker
// one at a time. Mounted onto the shared /api/checklist-items router (see
// checklistHelper.js's buildChecklistItemsRouter) — routes are registered
// there before the generic /:itemId routes so literal paths like /monitor
// are never swallowed as an id.
const db = require('../db');

// owner_type-specific tables joined in, so we can show a human name (e.g.
// "Acme Corp", "Dr. Rao", "Delegate: Priya Shah") without the caller having
// to know which of the 5 tables a given checklist item's owner lives in.
const OWNER_NAME_JOIN = `
  LEFT JOIN sponsors s ON ci.owner_type='sponsor' AND ci.owner_id = s.id
  LEFT JOIN speakers sp ON ci.owner_type='speaker' AND ci.owner_id = sp.id
  LEFT JOIN guest_visitors gv ON ci.owner_type='guest_visitor' AND ci.owner_id = gv.id
  LEFT JOIN participants p ON ci.owner_type='participant' AND ci.owner_id = p.id
  LEFT JOIN host_members hm ON ci.owner_type='host_member' AND ci.owner_id = hm.id
`;
const OWNER_NAME_SELECT = `COALESCE(s.name, sp.name, gv.name, p.name, hm.name) AS owner_name`;

function attachDeliveryMonitorRoutes(router) {
  // Per-committee rollup: total/pending/in_progress/done/overdue counts, so
  // the dashboard can show every committee's completion % at a glance. A
  // NULL committee (never assigned, or its committee was later deleted)
  // shows up as its own "Unassigned" bucket rather than being dropped.
  router.get('/monitor/summary', async (req, res) => {
    try {
      const rows = await db.all(`
        SELECT
          c.id AS committee_id, c.name AS committee_name,
          COUNT(ci.id)::int AS total,
          COUNT(*) FILTER (WHERE ci.status='done')::int AS done,
          COUNT(*) FILTER (WHERE ci.status='in_progress')::int AS in_progress,
          COUNT(*) FILTER (WHERE ci.status='pending')::int AS pending,
          COUNT(*) FILTER (WHERE ci.status != 'done' AND ci.due_date IS NOT NULL AND ci.due_date < CURRENT_DATE)::int AS overdue
        FROM checklist_items ci
        LEFT JOIN committees c ON c.id = ci.responsible_committee_id
        GROUP BY c.id, c.name
        ORDER BY c.name IS NULL, c.name
      `);
      const withPct = rows.map((r) => ({
        ...r,
        completion_pct: r.total > 0 ? Math.round((r.done / r.total) * 100) : null
      }));
      res.json(withPct);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Full detail list — filterable by committee_id ('unassigned' for the NULL
  // bucket), status, and owner_type. Sorted overdue-first, then soonest due
  // date, so the most urgent items are always at the top.
  router.get('/monitor', async (req, res) => {
    try {
      const { committee_id, status, owner_type } = req.query;
      const conditions = [];
      const params = [];
      if (committee_id !== undefined && committee_id !== '') {
        if (committee_id === 'unassigned') {
          conditions.push('ci.responsible_committee_id IS NULL');
        } else {
          params.push(committee_id);
          conditions.push(`ci.responsible_committee_id = $${params.length}`);
        }
      }
      if (status) { params.push(status); conditions.push(`ci.status = $${params.length}`); }
      if (owner_type) { params.push(owner_type); conditions.push(`ci.owner_type = $${params.length}`); }
      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
      const rows = await db.all(`
        SELECT ci.*, ${OWNER_NAME_SELECT}, c.name AS responsible_committee_name, u.username AS completed_by_username,
          (ci.status != 'done' AND ci.due_date IS NOT NULL AND ci.due_date < CURRENT_DATE) AS is_overdue
        FROM checklist_items ci
        ${OWNER_NAME_JOIN}
        LEFT JOIN committees c ON c.id = ci.responsible_committee_id
        LEFT JOIN users u ON u.id = ci.completed_by_user_id
        ${where}
        ORDER BY is_overdue DESC, ci.due_date ASC NULLS LAST, ci.id
      `, params);
      res.json(rows);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Bulk reassignment — e.g. a committee is overloaded or got merged, and its
  // (still-outstanding, by default) items need to move to another committee
  // in one action instead of editing each item individually. from_committee_id
  // may be 'unassigned'/null/omitted to target the NULL bucket.
  router.put('/reassign-committee', async (req, res) => {
    const { from_committee_id, to_committee_id, only_incomplete } = req.body;
    if (to_committee_id === undefined) {
      return res.status(400).json({ error: 'to_committee_id is required (use null to unassign)' });
    }
    try {
      const conditions = [];
      const params = [to_committee_id || null];
      if (!from_committee_id || from_committee_id === 'unassigned') {
        conditions.push('responsible_committee_id IS NULL');
      } else {
        params.push(from_committee_id);
        conditions.push(`responsible_committee_id = $${params.length}`);
      }
      if (only_incomplete !== false) conditions.push(`status != 'done'`);
      const result = await db.run(
        `UPDATE checklist_items SET responsible_committee_id=$1, updated_at=NOW() WHERE ${conditions.join(' AND ')} RETURNING id`,
        params
      );
      res.json({ reassigned: result.rowCount });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });
}

module.exports = { attachDeliveryMonitorRoutes };
