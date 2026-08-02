// Sex (M/F) normalisation, shared by the Delegates and Host Members routes so
// both accept the same spellings and store the same two canonical values.
//
// The column is deliberately nullable — "not recorded yet" is a real state and
// is very different from a guess. Anything we can't map with certainty becomes
// NULL rather than a best effort, because a wrong value here would flow
// straight into gender-segregated twin-sharing room allocation and headcounts.

// Accepts what the office actually types or pastes: "M", "Male", "F",
// "Female", and the honorifics that appear in imported spreadsheets.
// Everything else (including "Dr", "Sk", initials, blanks) returns null.
function normalizeSex(raw) {
  if (raw === null || raw === undefined) return null;
  const v = String(raw).trim().toLowerCase().replace(/\.$/, '');
  if (!v) return null;
  if (['m', 'male', 'man', 'mr', 'shri', 'sri'].includes(v)) return 'M';
  if (['f', 'female', 'woman', 'mrs', 'ms', 'miss', 'smt'].includes(v)) return 'F';
  return null;
}

// Derives sex from an honorific already carried in a person's name, e.g.
// "Mrs Aruna Anand" -> 'F'. Mirrors the one-time SQL backfill in db.js so the
// admin UI can offer the same suggestion for rows added later. Only
// unambiguous titles count: "Dr <name>" and bare names return null.
const TITLE_RE = /^\s*(mr|mrs|ms|miss|smt|shri|sri)\.?\s+/i;
function sexFromName(name) {
  const m = TITLE_RE.exec(String(name || ''));
  return m ? normalizeSex(m[1]) : null;
}

module.exports = { normalizeSex, sexFromName };
