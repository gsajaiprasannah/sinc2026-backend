// Read-only view over the activity_log table populated by
// server/lib/activityLogger.js's logActivity() calls scattered across every
// CRUD route + self-service portal write endpoint. Restricted to
// super_admin only (mounted with requireSuperAdmin in index.js) — regular
// admins never see this tab.
const express = require('express');
const db = require('../db');

const router = express.Router();

// Every distinct action/entity_type/role value seen so far — powers the
// filter dropdowns in the admin UI without hardcoding a list that'd drift
// out of sync with whatever routes actually log.
router.get('/filters', async (req, res) => {
  try {
    const [actions, entityTypes, roles] = await Promise.all([
      db.all(`SELECT DISTINCT action FROM activity_log WHERE action IS NOT NULL ORDER BY action`),
      db.all(`SELECT DISTINCT entity_type FROM activity_log WHERE entity_type IS NOT NULL ORDER BY entity_type`),
      db.all(`SELECT DISTINCT role FROM activity_log WHERE role IS NOT NULL ORDER BY role`)
    ]);
    res.json({
      actions: actions.map((r) => r.action),
      entity_types: entityTypes.map((r) => r.entity_type),
      roles: roles.map((r) => r.role)
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/', async (req, res) => {
  try {
    const {
      user_id, role, action, entity_type, search,
      date_from, date_to,
      page = '1', page_size = '50'
    } = req.query;

    const where = [];
    const params = [];
    function addParam(val) {
      params.push(val);
      return `$${params.length}`;
    }

    if (user_id) where.push(`user_id = ${addParam(Number(user_id))}`);
    if (role) where.push(`role = ${addParam(role)}`);
    if (action) where.push(`action = ${addParam(action)}`);
    if (entity_type) where.push(`entity_type = ${addParam(entity_type)}`);
    if (date_from) where.push(`created_at >= ${addParam(date_from)}`);
    if (date_to) where.push(`created_at < (${addParam(date_to)}::date + interval '1 day')`);
    if (search && search.trim()) {
      const p = addParam(`%${search.trim()}%`);
      where.push(`(username ILIKE ${p} OR label ILIKE ${p} OR details ILIKE ${p})`);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const pageSize = Math.min(200, Math.max(1, parseInt(page_size, 10) || 50));
    const offset = (pageNum - 1) * pageSize;

    const countRow = await db.get(`SELECT COUNT(*) AS total FROM activity_log ${whereSql}`, params);
    const limitParam = addParam(pageSize);
    const offsetParam = addParam(offset);
    const rows = await db.all(
      `SELECT * FROM activity_log ${whereSql} ORDER BY created_at DESC LIMIT ${limitParam} OFFSET ${offsetParam}`,
      params
    );

    res.json({
      rows,
      total: Number(countRow.total),
      page: pageNum,
      page_size: pageSize,
      total_pages: Math.max(1, Math.ceil(Number(countRow.total) / pageSize))
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
