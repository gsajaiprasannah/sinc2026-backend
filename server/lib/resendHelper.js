// Thin wrapper around Resend's REST API (https://api.resend.com/emails).
// No SDK dependency needed — Node 18+ (this project's minimum, see
// package.json engines) has a global fetch, so a single POST is all this is.
//
// RESEND_API_KEY must be set in the environment (Render → Environment tab).
// RESEND_FROM_EMAIL defaults to the verified `updates.sinc2026.com` sending
// subdomain set up in Resend — see server/routes/emailCampaigns.js for how
// this is used. Deliberately a single-email send (not the /emails/batch
// endpoint): each call's success/failure is attributed to exactly one
// recipient row, so a partial failure across a big send is always visible
// per-person instead of an opaque all-or-nothing batch result.
const RESEND_API_URL = 'https://api.resend.com/emails';
const DEFAULT_FROM_EMAIL = process.env.RESEND_FROM_EMAIL || 'no-reply@updates.sinc2026.com';

function isConfigured() {
  return !!process.env.RESEND_API_KEY;
}

// Returns { ok: true, id } on success, or { ok: false, error } on failure —
// never throws, so a caller looping over many recipients doesn't need a
// try/catch around every single send.
async function sendEmail({ to, subject, html, fromName }) {
  if (!process.env.RESEND_API_KEY) {
    return { ok: false, error: 'RESEND_API_KEY is not set on the server — add it in Render\'s Environment tab.' };
  }
  if (!to || !subject || !html) {
    return { ok: false, error: 'to, subject, and html are all required.' };
  }
  const from = `${(fromName || 'SINC2026 Congress').replace(/[<>]/g, '')} <${DEFAULT_FROM_EMAIL}>`;
  try {
    const r = await fetch(RESEND_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ from, to: [to], subject, html })
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      return { ok: false, error: (data && (data.message || data.error)) || `Resend returned HTTP ${r.status}` };
    }
    return { ok: true, id: data.id };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { sendEmail, isConfigured, DEFAULT_FROM_EMAIL };
