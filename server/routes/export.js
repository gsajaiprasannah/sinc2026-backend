const express = require('express');
const db = require('../db');

const router = express.Router();

// Builds a PUBLIC-SAFE knowledge-base style export (facts + Q&A pairs) meant
// to be fed into a voice agent's retrieval/training pipeline. Because this
// data leaves our own admin-gated system once it's handed to a voice agent
// platform, it must never contain personal or financial data tied to a named
// individual — anyone talking to that agent could potentially surface it.
//
// Deliberately EXCLUDED from this export (do not add back without a privacy
// review): participant/host-member phone, whatsapp, email, address, dietary
// preference, travel/departure numbers & datetimes, pickup/SPOC names or
// phone numbers, notes fields, individual registration payment status /
// amount_paid / amount_due / payment_ref / payment_mode, and any aggregate
// revenue figure. Only club-level (not person-level) and general/public
// congress facts belong here.
router.get('/voice-agent', async (req, res) => {
  try {
    const clubs = await db.all('SELECT name, city, state, zone, members_count FROM clubs ORDER BY members_count DESC');
    const registrations = await db.all('SELECT reg_type FROM registrations');
    const happenings = await db.all('SELECT title, description, category, happened_at FROM happenings ORDER BY happened_at ASC');

    const totalMembers = clubs.reduce((s, c) => s + Number(c.members_count), 0);
    const totalRegs = registrations.length;
    const single = registrations.filter((r) => r.reg_type === 'single').length;
    const double = registrations.filter((r) => r.reg_type === 'double').length;
    const congressOnly = registrations.filter((r) => r.reg_type === 'congress_only').length;

    const qa = [];
    qa.push({ question: 'How many Skål clubs are there across India in SINC2026?', answer: `There are ${clubs.length} clubs registered, with a combined membership of ${totalMembers} across India.` });
    qa.push({ question: 'How many people have registered for SINC2026?', answer: `${totalRegs} registrations have been made: ${single} single registrations, ${double} double registrations, and ${congressOnly} Congress Only (domestic, no room) registrations.` });

    for (const c of clubs) {
      qa.push({
        question: `How many members does ${c.name} have?`,
        answer: `${c.name} (${c.city || ''}, ${c.state || ''}) has ${c.members_count} members.`
      });
    }

    for (const h of happenings) {
      qa.push({
        question: `What happened regarding "${h.title}"?`,
        answer: `${h.description || h.title} (logged at ${h.happened_at})`
      });
    }

    res.json({
      generated_at: new Date().toISOString(),
      note: 'Public-safe export: no personal contact/travel details or payment data are included. See server/routes/export.js for the exclusion list.',
      summary: { totalClubs: clubs.length, totalMembers, totalRegistrations: totalRegs, single, double, congressOnly },
      qa_pairs: qa,
      raw: { clubs, happenings }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
