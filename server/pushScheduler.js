// Daily due-date reminder sweep — the "checklist/task reminders" push
// notification use case. Runs once at boot (a minute in, alongside the
// existing backup job) and then every 24h. Finds committee tasks and
// personal checklist items due today or tomorrow that aren't done yet, and
// nudges the responsible host member — but only if that host member has
// their own login (and, in turn, has enabled push on some browser); a no-op
// otherwise. Safe to run repeatedly: it just re-sends until the item is
// marked done, same as a real reminder should.
const db = require('./db');
const push = require('./pushHelper');

async function runDueDateReminders() {
  if (!push.PUSH_ENABLED) return; // nothing to do until VAPID keys are set

  try {
    // --- Committee tasks / milestones due today or tomorrow, not yet done
    // by a given member ---
    const committeeRows = await db.all(`
      SELECT ct.id AS task_id, ct.title, ct.due_date, u.id AS user_id
      FROM committee_tasks ct
      JOIN committee_task_completions tc ON tc.committee_task_id = ct.id AND tc.status = 'pending'
      JOIN users u ON u.host_member_id = tc.host_member_id
      WHERE ct.due_date IN (CURRENT_DATE, CURRENT_DATE + INTERVAL '1 day')
    `);
    for (const row of committeeRows) {
      await push.sendToUser(row.user_id, {
        title: 'Checklist reminder',
        body: `"${row.title}" is due ${row.due_date.toISOString ? row.due_date.toISOString().slice(0, 10) : row.due_date}.`,
        url: 'login.html'
      });
    }

    // --- Personal checklist items (host member's own kit/souvenir/etc.
    // checklist) due today or tomorrow, not yet done ---
    const checklistRows = await db.all(`
      SELECT ci.id AS item_id, ci.label, ci.due_date, u.id AS user_id
      FROM checklist_items ci
      JOIN users u ON u.host_member_id = ci.owner_id
      WHERE ci.owner_type = 'host_member'
        AND ci.status <> 'done'
        AND ci.due_date IN (CURRENT_DATE, CURRENT_DATE + INTERVAL '1 day')
    `);
    for (const row of checklistRows) {
      await push.sendToUser(row.user_id, {
        title: 'Checklist reminder',
        body: `"${row.label}" is due ${row.due_date.toISOString ? row.due_date.toISOString().slice(0, 10) : row.due_date}.`,
        url: 'login.html'
      });
    }
  } catch (e) {
    console.error('Due-date reminder sweep failed', e.message);
  }
}

module.exports = { runDueDateReminders };
