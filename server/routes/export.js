const express = require('express');
const db = require('../db');

const router = express.Router();

// Builds a knowledge-base style export (facts + Q&A pairs) that can be fed
// into a voice agent's retrieval/training pipeline. Also includes raw tables
// for anyone who wants to build their own prompts on top of it.
router.get('/voice-agent', async (req, res) => {
  try {
    const clubs = await db.all('SELECT * FROM clubs ORDER BY members_count DESC');
    const registrations = await db.all(`
      SELECT r.*, c.name AS club_name FROM registrations r LEFT JOIN clubs c ON c.id = r.club_id
    `);
    const participants = await db.all(`
      SELECT p.*, r.reg_number, c.name AS club_name FROM participants p
      LEFT JOIN registrations r ON r.id = p.registration_id
      LEFT JOIN clubs c ON c.id = p.club_id
    `);
    const happenings = await db.all('SELECT * FROM happenings ORDER BY happened_at ASC');

    const totalMembers = clubs.reduce((s, c) => s + Number(c.members_count), 0);
    const totalRegs = registrations.length;
    const single = registrations.filter((r) => r.reg_type === 'single').length;
    const double = registrations.filter((r) => r.reg_type === 'double').length;
    const totalCollected = registrations.reduce((s, r) => s + Number(r.amount_paid || 0), 0);

    const qa = [];
    qa.push({ question: 'How many Skål clubs are there across India in SINC2026?', answer: `There are ${clubs.length} clubs registered, with a combined membership of ${totalMembers} across India.` });
    qa.push({ question: 'How many people have registered for SINC2026?', answer: `${totalRegs} registrations have been made: ${single} single registrations and ${double} double registrations.` });
    qa.push({ question: 'How much money has been collected so far for SINC2026?', answer: `A total of ₹${totalCollected.toLocaleString('en-IN')} has been collected so far across all registrations.` });

    for (const c of clubs) {
      qa.push({
        question: `How many members does ${c.name} have?`,
        answer: `${c.name} (${c.city || ''}, ${c.state || ''}) has ${c.members_count} members.`
      });
    }

    for (const r of registrations) {
      qa.push({
        question: `What is the payment status of registration ${r.reg_number}?`,
        answer: `Registration ${r.reg_number} from ${r.club_name || 'an unaffiliated club'} is a ${r.reg_type} registration with payment status "${r.payment_status}". Amount paid: ₹${r.amount_paid}, amount due: ₹${r.amount_due}.`
      });
    }

    for (const p of participants) {
      if (p.spoc_name) {
        qa.push({
          question: `Who is the SPOC for ${p.name}?`,
          answer: `${p.spoc_name}${p.spoc_phone ? ' (contact: ' + p.spoc_phone + ')' : ''} is the SPOC for ${p.name} from ${p.club_name || 'their club'}.`
        });
      }
      if (p.travel_mode) {
        qa.push({
          question: `How is ${p.name} travelling to SINC2026?`,
          answer: `${p.name} is arriving by ${p.travel_mode}${p.travel_number ? ' (' + p.travel_number + ')' : ''} on ${p.travel_datetime || 'an unspecified date/time'}, arriving at ${p.arrival_point || 'the venue city'}. Pickup by ${p.pickup_by || 'to be assigned'}${p.pickup_vehicle ? ' in ' + p.pickup_vehicle : ''}.`
        });
      }
    }

    for (const h of happenings) {
      qa.push({
        question: `What happened regarding "${h.title}"?`,
        answer: `${h.description || h.title} (logged at ${h.happened_at})`
      });
    }

    res.json({
      generated_at: new Date().toISOString(),
      summary: { totalClubs: clubs.length, totalMembers, totalRegistrations: totalRegs, single, double, totalCollected },
      qa_pairs: qa,
      raw: { clubs, registrations, participants, happenings }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
