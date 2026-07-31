// Email Campaigns: bulk, personalized email blasts to any audience that
// carries an email column — Delegates, Host Members, Volunteers, Sponsors,
// Guest Speakers, Guest Visitors — sent via Resend (server/lib/resendHelper.js).
//
// Two ways to pick who gets a campaign, same as Communications' "role" vs
// "individual" targeting (server/routes/messages.js): an audience_type alone
// sends to everyone in that category who has a valid email on file, OR
// recipient_ids narrows it down to specific hand-picked people (from the
// /directory/:audience_type list an admin can click through in the UI).
//
// A send is never awaited end-to-end by the HTTP request — for a few hundred
// recipients that could take minutes. POST /:id/send flips the campaign to
// 'sending' and returns immediately; the actual per-recipient Resend calls
// run in the background (bounded concurrency below), updating
// email_campaign_recipients as they complete, so the admin UI can poll
// GET /:id (or /:id/recipients) for live progress.
const express = require('express');
const db = require('../db');
const { sendEmail, isConfigured } = require('../lib/resendHelper');
const { logActivity } = require('../lib/activityLogger');

const router = express.Router();

// One SQL source per audience type, normalized to a common column set so the
// merge-token logic below never needs to know which table it came from.
// Columns not meaningful for a given table are simply NULL.
const AUDIENCES = {
  participant: {
    label: 'Delegates',
    sql: `SELECT p.id, p.name, p.email, p.phone, c.name AS club, p.designation,
            NULL::text AS company, NULL::text AS organization, NULL::text AS tier, NULL::text AS topic, p.participant_code AS code
          FROM participants p LEFT JOIN clubs c ON c.id = p.club_id`
  },
  host_member: {
    label: 'Host Members',
    // LEFT JOIN users so a campaign can merge {{username}} (their login,
    // e.g. for a "here are your portal credentials" email) alongside the
    // usual profile fields. Someone with no login yet just gets an empty
    // {{username}} — personalize() already turns null into ''.
    sql: `SELECT hm.id, hm.name, hm.email, hm.phone, NULL::text AS club, hm.designation,
            hm.company, NULL::text AS organization, NULL::text AS tier, NULL::text AS topic, NULL::text AS code,
            u.username AS username
          FROM host_members hm LEFT JOIN users u ON u.host_member_id = hm.id`
  },
  volunteer: {
    label: 'Volunteers',
    sql: `SELECT id, name, email, phone, NULL::text AS club, NULL::text AS designation,
            NULL::text AS company, organization, NULL::text AS tier, NULL::text AS topic, NULL::text AS code
          FROM volunteers`
  },
  sponsor: {
    label: 'Sponsors',
    sql: `SELECT id, name, email, phone, NULL::text AS club, NULL::text AS designation,
            NULL::text AS company, NULL::text AS organization, tier, NULL::text AS topic, NULL::text AS code
          FROM sponsors`
  },
  speaker: {
    label: 'Guest Speakers',
    sql: `SELECT id, name, email, phone, NULL::text AS club, designation,
            NULL::text AS company, organization, NULL::text AS tier, topic, NULL::text AS code
          FROM speakers`
  },
  // No SQL — recipients come from the campaign's manual_recipients text
  // instead of a table. Lets the office mail an address that isn't in the
  // database at all (a hotel contact, a vendor, a one-off re-send).
  manual: {
    label: 'Manually entered addresses',
    manual: true,
    sql: null
  },
  guest_visitor: {
    label: 'Guest Visitors',
    sql: `SELECT id, name, email, phone, NULL::text AS club, designation,
            NULL::text AS company, organization, NULL::text AS tier, NULL::text AS topic, NULL::text AS code
          FROM guest_visitors`
  }
};

// Recipients typed in by hand rather than drawn from a table. Accepts one
// per line or comma/semicolon separated, as "Name <a@b.com>" or a bare
// address, so the office can paste straight out of a spreadsheet or another
// mail client. Entries without an @ are skipped rather than failing the whole
// list, and duplicates are dropped so nobody gets the same mail twice.
function parseManualRecipients(raw) {
  const out = [];
  const seen = new Set();
  String(raw || '').split(/[\n,;]+/).forEach((chunk) => {
    const line = chunk.trim();
    if (!line) return;
    const angled = line.match(/^(.*?)<([^>]+)>$/);
    const name = angled ? angled[1].trim().replace(/^["']|["']$/g, '') : '';
    const email = (angled ? angled[2] : line).trim();
    if (!email.includes('@')) return;
    const key = email.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    // id is the position in the list. email_campaign_recipients.recipient_id
    // is NOT NULL and the send loop updates rows by it, so manual recipients
    // get a stable synthetic index rather than needing a nullable column.
    out.push({ id: out.length, name: name || email, email });
  });
  return out;
}

function assertAudience(audience_type) {
  if (!AUDIENCES[audience_type]) throw new Error(`Unknown audience_type "${audience_type}"`);
  return AUDIENCES[audience_type];
}

// Rows for an audience, optionally narrowed to specific ids. hasEmailOnly
// filters to rows with a non-blank email (the actual sendable set); pass
// false to get the full roster (used by /audiences' total count).
async function fetchAudienceRows(audience_type, { recipientIds, hasEmailOnly = true, manualRecipients } = {}) {
  const entry = assertAudience(audience_type);
  // Manual audiences have no table to query — the addresses are the payload.
  if (entry.manual) return parseManualRecipients(manualRecipients);
  const { sql } = entry;
  const clauses = [];
  const params = [];
  if (hasEmailOnly) clauses.push(`email IS NOT NULL AND trim(email) <> ''`);
  if (Array.isArray(recipientIds) && recipientIds.length) {
    params.push(recipientIds);
    clauses.push(`id = ANY($${params.length}::int[])`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return db.all(`SELECT * FROM (${sql}) t ${where} ORDER BY name`, params);
}

// Replaces {{token}} placeholders with the matching field from `row`
// (name/email/phone/club/designation/company/organization/tier/topic/code/
// username — the last only populated for audiences whose SQL selects it,
// currently just host_member).
// Any token not on that list — including a typo — is quietly replaced with
// an empty string rather than left dangling in the sent email.
const MERGE_FIELDS = ['name', 'email', 'phone', 'club', 'designation', 'company', 'organization', 'tier', 'topic', 'code', 'username'];
function personalize(template, row) {
  return String(template || '').replace(/\{\{\s*([a-zA-Z_]+)\s*\}\}/g, (m, key) => {
    const k = key.toLowerCase();
    if (!MERGE_FIELDS.includes(k)) return '';
    const v = row[k];
    return (v === null || v === undefined) ? '' : String(v);
  });
}

// --- Directory: how many people (and who) are reachable per audience ---
router.get('/audiences', async (req, res) => {
  try {
    const out = {};
    for (const [key, meta] of Object.entries(AUDIENCES)) {
      // Manual has no roster to count — its size depends on what's typed in.
      if (meta.manual) { out[key] = { label: meta.label, total: 0, with_email: 0, manual: true }; continue; }
      const total = await db.get(`SELECT COUNT(*)::int AS n FROM (${meta.sql}) t`);
      const withEmail = await db.get(`SELECT COUNT(*)::int AS n FROM (${meta.sql}) t WHERE email IS NOT NULL AND trim(email) <> ''`);
      out[key] = { label: meta.label, total: total.n, with_email: withEmail.n };
    }
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Lightweight per-person list for the "click to pick individuals" grid —
// name + email + one contextual meta field, plus whether they even have an
// email on file (shown but not selectable in the UI if not).
router.get('/directory/:audience_type', async (req, res) => {
  try {
    // Nothing to pick from — a manual audience is defined by what's typed.
    if (AUDIENCES[req.params.audience_type] && AUDIENCES[req.params.audience_type].manual) return res.json([]);
    const rows = await fetchAudienceRows(req.params.audience_type, { hasEmailOnly: false });
    res.json(rows.map((r) => ({
      id: r.id, name: r.name, email: r.email || '',
      meta: [r.club, r.company, r.organization, r.tier, r.topic, r.designation].filter(Boolean)[0] || ''
    })));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Preview: shows the recipient count that would actually receive this send,
// plus the first couple of rows personalized, so an admin can sanity-check
// merge tokens before committing to Create/Send.
router.post('/preview', async (req, res) => {
  const { audience_type, recipient_ids, subject, body_html, manual_recipients } = req.body;
  try {
    const rows = await fetchAudienceRows(audience_type, { recipientIds: recipient_ids, manualRecipients: manual_recipients });
    const sample = rows.slice(0, 3).map((r) => ({
      name: r.name, email: r.email,
      subject: personalize(subject, r),
      body_html: personalize(body_html, r)
    }));
    res.json({ recipient_count: rows.length, sample });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// --- Create (draft) ---
router.post('/', async (req, res) => {
  const { name, subject, body_html, audience_type, recipient_ids, from_name, manual_recipients } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });
  if (!subject || !subject.trim()) return res.status(400).json({ error: 'subject is required' });
  if (!body_html || !body_html.trim()) return res.status(400).json({ error: 'body_html is required' });
  try {
    assertAudience(audience_type);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  try {
    // A manual campaign with no parseable address would send to nobody, so
    // it's rejected here rather than saved as an empty draft.
    if (AUDIENCES[audience_type].manual && !parseManualRecipients(manual_recipients).length) {
      return res.status(400).json({ error: 'Enter at least one valid email address (one per line, or comma separated).' });
    }
    const row = await db.get(
      `INSERT INTO email_campaigns (name, subject, body_html, audience_type, recipient_ids, from_name, created_by, manual_recipients)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [
        name.trim(), subject.trim(), body_html, audience_type,
        (Array.isArray(recipient_ids) && recipient_ids.length) ? recipient_ids : null,
        (from_name && from_name.trim()) || 'SINC2026 Congress',
        req.user.id,
        manual_recipients || null
      ]
    );
    logActivity(req.user, { action: 'create', entityType: 'email_campaign', entityId: row.id, label: row.name });
    res.json(row);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// --- History list ---
router.get('/', async (req, res) => {
  try {
    const rows = await db.all(`
      SELECT c.*, u.username AS created_by_username,
        (SELECT COUNT(*) FROM email_campaign_recipients r WHERE r.campaign_id = c.id) AS attempted_count,
        (SELECT COUNT(*) FROM email_campaign_recipients r WHERE r.campaign_id = c.id AND r.status = 'sent') AS sent_count,
        (SELECT COUNT(*) FROM email_campaign_recipients r WHERE r.campaign_id = c.id AND r.status = 'failed') AS failed_count
      FROM email_campaigns c
      LEFT JOIN users u ON u.id = c.created_by
      ORDER BY c.created_at DESC
    `);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const row = await db.get(`
      SELECT c.*,
        (SELECT COUNT(*) FROM email_campaign_recipients r WHERE r.campaign_id = c.id) AS attempted_count,
        (SELECT COUNT(*) FROM email_campaign_recipients r WHERE r.campaign_id = c.id AND r.status = 'sent') AS sent_count,
        (SELECT COUNT(*) FROM email_campaign_recipients r WHERE r.campaign_id = c.id AND r.status = 'failed') AS failed_count
      FROM email_campaigns c WHERE c.id = $1
    `, [req.params.id]);
    if (!row) return res.status(404).json({ error: 'Campaign not found' });
    res.json(row);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/:id/recipients', async (req, res) => {
  try {
    const rows = await db.all(
      `SELECT * FROM email_campaign_recipients WHERE campaign_id = $1 ORDER BY name`,
      [req.params.id]
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Send a single test email (to the admin's own address, or any address
// they type in) using the first matching recipient's data for merge tokens,
// so the tokens can be checked against real data without touching anyone
// else's inbox or the campaign's sent/recipient records at all.
router.post('/:id/send-test', async (req, res) => {
  const { to } = req.body;
  if (!to || !to.trim()) return res.status(400).json({ error: 'to (an email address) is required' });
  if (!isConfigured()) return res.status(400).json({ error: 'RESEND_API_KEY is not set on the server yet.' });
  try {
    const campaign = await db.get('SELECT * FROM email_campaigns WHERE id=$1', [req.params.id]);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    const rows = await fetchAudienceRows(campaign.audience_type, { recipientIds: campaign.recipient_ids, manualRecipients: campaign.manual_recipients });
    const sampleRow = rows[0] || { name: 'Sample Name', email: to };
    const result = await sendEmail({
      to: to.trim(),
      subject: `[TEST] ${personalize(campaign.subject, sampleRow)}`,
      html: personalize(campaign.body_html, sampleRow),
      fromName: campaign.from_name
    });
    if (!result.ok) return res.status(400).json({ error: result.error });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Bounded-concurrency loop — sends CONCURRENCY at a time rather than either
// all-at-once (risks tripping Resend's rate limit) or one-at-a-time (far too
// slow for a few hundred recipients).
const CONCURRENCY = 5;
async function runInBatches(items, worker) {
  let cursor = 0;
  async function next() {
    while (cursor < items.length) {
      const i = cursor++;
      await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, next));
}

async function processSend(campaignId) {
  const campaign = await db.get('SELECT * FROM email_campaigns WHERE id=$1', [campaignId]);
  if (!campaign) return;
  const rows = await fetchAudienceRows(campaign.audience_type, { recipientIds: campaign.recipient_ids, manualRecipients: campaign.manual_recipients });

  // One recipient row per person, created up front as 'pending' so the admin
  // UI has something to poll immediately even before the first send lands.
  for (const r of rows) {
    await db.run(
      `INSERT INTO email_campaign_recipients (campaign_id, recipient_type, recipient_id, name, email, status)
       VALUES ($1,$2,$3,$4,$5,'pending')`,
      [campaignId, campaign.audience_type, r.id, r.name, r.email]
    );
  }

  let sentCount = 0;
  await runInBatches(rows, async (r) => {
    const result = await sendEmail({
      to: r.email,
      subject: personalize(campaign.subject, r),
      html: personalize(campaign.body_html, r),
      fromName: campaign.from_name
    });
    if (result.ok) sentCount++;
    await db.run(
      `UPDATE email_campaign_recipients SET status=$1, resend_id=$2, error=$3, sent_at=CASE WHEN $1='sent' THEN NOW() ELSE sent_at END
       WHERE campaign_id=$4 AND recipient_type=$5 AND recipient_id=$6`,
      [result.ok ? 'sent' : 'failed', result.id || null, result.error || null, campaignId, campaign.audience_type, r.id]
    );
  });

  await db.run(
    `UPDATE email_campaigns SET status=$1, sent_at=NOW() WHERE id=$2`,
    [sentCount > 0 ? 'sent' : 'failed', campaignId]
  );
}

// Re-sends only to recipients whose last attempt failed (a typo'd address
// that's since been fixed, a transient Resend hiccup, etc.) rather than
// blasting everyone in the campaign again. Re-fetches each failed person's
// full row (by their original recipient_id) so merge tokens still resolve
// correctly, falling back to the name/email captured at the original send
// if the source record has since been deleted.
async function processResend(campaign, failedRows) {
  const failedIds = new Set(failedRows.map((r) => r.recipient_id));
  const audienceRows = await fetchAudienceRows(campaign.audience_type, {
    recipientIds: failedRows.map((r) => r.recipient_id),
    manualRecipients: campaign.manual_recipients
  });
  const byId = new Map(audienceRows.filter((r) => failedIds.has(r.id)).map((r) => [r.id, r]));

  await runInBatches(failedRows, async (fr) => {
    const row = byId.get(fr.recipient_id) || { id: fr.recipient_id, name: fr.name, email: fr.email };
    const result = await sendEmail({
      to: row.email || fr.email,
      subject: personalize(campaign.subject, row),
      html: personalize(campaign.body_html, row),
      fromName: campaign.from_name
    });
    await db.run(
      `UPDATE email_campaign_recipients SET status=$1, resend_id=$2, error=$3, sent_at=CASE WHEN $1='sent' THEN NOW() ELSE sent_at END
       WHERE id=$4`,
      [result.ok ? 'sent' : 'failed', result.id || null, result.error || null, fr.id]
    );
  });

  // Recompute the campaign's overall status from ALL its recipients (not just
  // this resend batch), since some may have succeeded on the original send.
  const counts = await db.get(
    `SELECT COUNT(*) FILTER (WHERE status = 'sent')::int AS sent FROM email_campaign_recipients WHERE campaign_id=$1`,
    [campaign.id]
  );
  await db.run(`UPDATE email_campaigns SET status=$1, sent_at=NOW() WHERE id=$2`, [counts.sent > 0 ? 'sent' : 'failed', campaign.id]);
}

router.post('/:id/resend-failed', async (req, res) => {
  if (!isConfigured()) return res.status(400).json({ error: 'RESEND_API_KEY is not set on the server yet — add it in Render\'s Environment tab, then try again.' });
  try {
    const campaign = await db.get('SELECT * FROM email_campaigns WHERE id=$1', [req.params.id]);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    if (campaign.status === 'sending') return res.status(409).json({ error: 'This campaign is already sending.' });

    const failed = await db.all(
      `SELECT * FROM email_campaign_recipients WHERE campaign_id=$1 AND status='failed'`,
      [req.params.id]
    );
    if (!failed.length) return res.status(400).json({ error: 'No failed recipients to resend.' });

    await db.run(`UPDATE email_campaigns SET status='sending' WHERE id=$1`, [req.params.id]);
    logActivity(req.user, {
      action: 'resend', entityType: 'email_campaign', entityId: campaign.id, label: campaign.name,
      details: `${failed.length} previously-failed recipient(s)`
    });

    // Fire-and-forget, same as /:id/send — errors per-recipient are already
    // captured; anything that escapes that is logged, not thrown.
    processResend(campaign, failed).catch((e) => console.error(`Email campaign #${campaign.id} resend failed:`, e.message));

    res.json({ ok: true, status: 'sending', recipient_count: failed.length });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Kicks off the send in the background and returns immediately — see file
// header for why this isn't awaited end-to-end by the request.
router.post('/:id/send', async (req, res) => {
  if (!isConfigured()) return res.status(400).json({ error: 'RESEND_API_KEY is not set on the server yet — add it in Render\'s Environment tab, then try again.' });
  try {
    const campaign = await db.get('SELECT * FROM email_campaigns WHERE id=$1', [req.params.id]);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    if (campaign.status === 'sending') return res.status(409).json({ error: 'This campaign is already sending.' });

    const rows = await fetchAudienceRows(campaign.audience_type, { recipientIds: campaign.recipient_ids, manualRecipients: campaign.manual_recipients });
    if (!rows.length) return res.status(400).json({ error: 'No recipients with a valid email match this campaign — nothing to send.' });

    await db.run(`UPDATE email_campaigns SET status='sending' WHERE id=$1`, [req.params.id]);
    logActivity(req.user, { action: 'send', entityType: 'email_campaign', entityId: campaign.id, label: campaign.name, details: `${campaign.audience_type} → ${rows.length} recipient(s)` });

    // Fire-and-forget — errors inside are already captured per-recipient;
    // anything that escapes that (e.g. a DB hiccup) is logged, not thrown,
    // since there's no request left to respond to by the time this runs.
    processSend(campaign.id).catch((e) => console.error(`Email campaign #${campaign.id} send failed:`, e.message));

    res.json({ ok: true, status: 'sending', recipient_count: rows.length });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

module.exports = router;
