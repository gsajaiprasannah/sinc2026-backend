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

    // The programme. "What time does the AGM start", "who is speaking after
    // lunch on the 14th" are the questions a delegate actually rings about, so
    // the agenda belongs in the public-safe export — it contains no personal
    // data beyond the names of people already billed as speaking publicly.
    const schedule = await db.all(`
      SELECT i.day_label, i.time_label AS block_time, i.title AS block_title, i.description AS block_description,
             e.time_label AS event_time, e.title AS event_title, e.description AS event_description,
             i.sort_order AS block_order, e.sort_order AS event_order
        FROM itinerary_items i
        LEFT JOIN agenda_events e ON e.itinerary_item_id = i.id
       ORDER BY i.sort_order, i.id, e.sort_order, e.id
    `);

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

    // --- programme -----------------------------------------------------------
    // Grouped by day, then by block, so the agent can answer both "what is on
    // Thursday" and "when is the AGM" without re-deriving structure from a flat
    // list. The flat Q&A pairs below cover the phrasings people actually use.
    const days = [];
    const dayIndex = {};
    for (const row of schedule) {
      if (!dayIndex[row.day_label]) {
        dayIndex[row.day_label] = { day: row.day_label, blocks: [] };
        days.push(dayIndex[row.day_label]);
      }
      const day = dayIndex[row.day_label];
      let block = day.blocks[day.blocks.length - 1];
      if (!block || block.title !== row.block_title || block.time !== row.block_time) {
        block = { time: row.block_time, title: row.block_title, description: row.block_description, events: [] };
        day.blocks.push(block);
      }
      if (row.event_title) {
        block.events.push({ time: row.event_time, title: row.event_title, description: row.event_description });
      }
    }

    for (const d of days) {
      const lines = d.blocks.map((b) => {
        if (!b.events.length) return `${b.time ? b.time + ' — ' : ''}${b.title}`;
        return b.events.map((e) => `${e.time} ${e.title}${e.description ? ' (' + e.description + ')' : ''}`).join('; ');
      });
      qa.push({
        question: `What is the programme on ${d.day}?`,
        answer: `On ${d.day}: ${lines.join('. ')}.`
      });
    }

    // One pair per individual session, so "when does the Awards Night start"
    // matches directly rather than relying on the agent parsing a whole day.
    for (const d of days) {
      for (const b of d.blocks) {
        for (const e of b.events) {
          qa.push({
            question: `When is ${e.title}?`,
            answer: `${e.title} is on ${d.day} at ${e.time}.${e.description ? ' ' + e.description : ''}`
          });
        }
        if (!b.events.length && b.title) {
          qa.push({
            question: `When is ${b.title}?`,
            answer: `${b.title} is on ${d.day}${b.time ? ', ' + b.time : ''}.${b.description ? ' ' + b.description : ''}`
          });
        }
      }
    }

    res.json({
      generated_at: new Date().toISOString(),
      note: 'Public-safe export: no personal contact/travel details or payment data are included. See server/routes/export.js for the exclusion list.',
      summary: {
        totalClubs: clubs.length, totalMembers, totalRegistrations: totalRegs, single, double, congressOnly,
        programme_days: days.length,
        programme_sessions: schedule.filter((r) => r.event_title).length
      },
      qa_pairs: qa,
      raw: { clubs, happenings, programme: days }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// GET /voice-agent-attendees
// ---------------------------------------------------------------------------
// A SECOND, deliberately separate export in the per-attendee shape a
// concierge-style voice agent needs ("when does Rajesh land, who is picking
// him up, which hotel").
//
// THIS ONE IS NOT PUBLIC-SAFE. It contains, per named individual: mobile and
// WhatsApp numbers, flight numbers and times, pickup point, the name and phone
// of whoever is collecting them, their hotel and room, their assigned helper,
// and free-text notes. It is kept as its own endpoint rather than folded into
// /voice-agent precisely so the public-safe export stays public-safe and
// nobody ships this one by accident.
//
// Before handing this file to a voice-agent vendor, confirm: the platform
// stores it encrypted, it is not used to train a shared model, and it can be
// deleted after the congress. Everyone in it is a real person who gave their
// number to register for an event, not to be read out by a bot.

// "9840077988" -> "+91 98400 77988".
//
// The +91 is only added when we actually believe the delegate is Indian.
// Length alone is not enough: the cleanup script stripped country codes from
// Indian numbers, leaving 10 digits, but a Singapore number like 6596192544
// is ALSO 10 digits and is already complete. Stamping +91 on that would hand
// the voice agent an undiallable number for every overseas delegate.
//
// `countryCode` is the two-letter code parsed out of the import notes; when
// it is absent we assume India, which is right for the overwhelming majority
// and is the same assumption the rest of the system makes.
function formatPhone(raw, countryCode) {
  const d = String(raw || '').replace(/\D/g, '');
  if (!d) return null;
  const isIndian = !countryCode || String(countryCode).toUpperCase() === 'IN';
  if (d.length === 12 && d.startsWith('91')) return `+91 ${d.slice(2, 7)} ${d.slice(7)}`;
  if (d.length === 10 && isIndian) return `+91 ${d.slice(0, 5)} ${d.slice(5)}`;
  return `+${d}`;
}

// travel_datetime is stored as free text from a datetime-local input
// ("2026-08-12T10:20"), so it is split rather than parsed as a Date — a bad
// value should degrade to nulls, not throw or invent a date.
function splitDateTime(v) {
  const s = String(v || '').trim();
  if (!s) return { date: null, time: null };
  const m = s.match(/^(\d{4}-\d{2}-\d{2})[T\s]?(\d{2}:\d{2})?/);
  if (!m) return { date: null, time: null };
  return { date: m[1], time: m[2] || null };
}

// The registration-form import packed extras into notes as
// "Company: X | Job Title: Y | City: Z | Country: IN | ...".
function fromNotes(notes, key) {
  const m = new RegExp(`${key}:\\s*([^|]+)`, 'i').exec(String(notes || ''));
  if (!m) return null;
  const v = m[1].replace(/\s+/g, ' ').replace(/[,\-\s]+$/, '').trim();
  return v && !['na', 'n/a', '-', 'nil'].includes(v.toLowerCase()) ? v : null;
}

const COUNTRY_NAMES = { IN: 'India', SG: 'Singapore', AE: 'United Arab Emirates', LK: 'Sri Lanka', NP: 'Nepal', GB: 'United Kingdom', US: 'United States', MY: 'Malaysia', TH: 'Thailand' };

router.get('/voice-agent-attendees', async (req, res) => {
  try {
    const rows = await db.all(`
      SELECT p.id, p.name, p.phone, p.whatsapp, p.is_primary,
             p.travel_mode, p.travel_number, p.travel_datetime, p.arrival_point,
             p.departure_mode, p.departure_number, p.departure_datetime, p.departure_point,
             p.pickup_by, p.pickup_vehicle, p.pickup_phone,
             p.spoc_name, p.spoc_phone, p.dietary_preference, p.special_requests, p.notes,
             r.reg_number, r.reg_type,
             c.name AS club_name, c.city AS club_city,
             ra.room_type, ra.room_number, h.name AS hotel_name,
             hm.name AS spoc_member_name, hm.phone AS spoc_member_phone
        FROM participants p
        LEFT JOIN registrations r ON r.id = p.registration_id
        LEFT JOIN clubs c         ON c.id = p.club_id
        LEFT JOIN room_assignments ra ON ra.participant_id = p.id
        LEFT JOIN hotels h        ON h.id = ra.hotel_id
        -- The assigned helper is a delegate_assignments row with role 'SPOC',
        -- not a column on participants — same join participants.js uses.
        -- spoc_name/spoc_phone survive as legacy free text for older rows.
        LEFT JOIN delegate_assignments spoc_da ON spoc_da.participant_id = p.id AND spoc_da.role = 'SPOC'
        LEFT JOIN host_members hm ON hm.id = spoc_da.host_member_id
       ORDER BY r.reg_number NULLS LAST, p.is_primary DESC, p.id
    `);

    const attendees = rows.map((p) => {
      const arr = splitDateTime(p.travel_datetime);
      const dep = splitDateTime(p.departure_datetime);
      const countryCode = fromNotes(p.notes, 'Country');
      // A helper is the assigned host member where there is one, otherwise the
      // free-typed SPOC the office entered.
      const helperName = p.spoc_member_name || p.spoc_name || null;
      const helperPhone = p.spoc_member_phone || p.spoc_phone || null;
      // Roll the scattered free-text fields into one sentence the agent can read.
      const noteParts = [
        p.dietary_preference ? `${p.dietary_preference} meals.` : null,
        p.special_requests || null,
        Number(p.is_primary) === 1 ? null : 'Co-registrant on this booking.',
        p.pickup_vehicle ? `Pickup vehicle: ${p.pickup_vehicle}.` : null
      ].filter(Boolean);

      return {
        registration_id: p.reg_number || null,
        name: p.name || null,
        club: p.club_name || null,
        registration_type: p.reg_type || null,
        coming_from_city: fromNotes(p.notes, 'City') || p.club_city || null,
        coming_from_country: countryCode ? (COUNTRY_NAMES[countryCode.toUpperCase()] || countryCode) : 'India',
        phone_number: formatPhone(p.phone, countryCode),
        whatsapp_number: formatPhone(p.whatsapp || p.phone, countryCode),
        pickup_point: p.arrival_point || null,
        arrival_airport: p.travel_mode === 'flight' ? (p.arrival_point || null) : null,
        arrival_flight_number: p.travel_number || null,
        arrival_date: arr.date,
        arrival_time: arr.time,
        pickup_by_name: p.pickup_by || null,
        pickup_by_phone: formatPhone(p.pickup_phone, 'IN'),
        stay_hotel: p.hotel_name || null,
        room_type: p.room_type || p.reg_type || null,
        helper_name: helperName,
        helper_phone: formatPhone(helperPhone, 'IN'),
        departure_date: dep.date,
        departure_flight_number: p.departure_number || null,
        notes: noteParts.length ? noteParts.join(' ') : null
      };
    });

    // A count of what is actually populated, so whoever hands this over can
    // see at a glance how much is still blank rather than assuming it is full.
    const filled = (key) => attendees.filter((a) => a[key] !== null && a[key] !== '').length;
    const coverage = {};
    ['phone_number', 'arrival_date', 'arrival_flight_number', 'pickup_by_name',
     'stay_hotel', 'helper_name', 'departure_date'].forEach((k) => { coverage[k] = filled(k); });

    res.json({
      generated_at: new Date().toISOString(),
      privacy_notice: 'CONTAINS PERSONAL DATA — mobile numbers, travel itineraries, hotel allocations and helper contacts for named individuals. Share only with a voice-agent platform that encrypts at rest, does not train shared models on it, and can delete it after the congress.',
      total_attendees: attendees.length,
      field_coverage: coverage,
      sample_attendees: attendees
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
