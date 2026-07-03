const API = ((window.SINC_CONFIG && window.SINC_CONFIG.API_BASE_URL) || '/api').replace(/\/$/, '');
const MEDIA_ORIGIN = API.replace(/\/api\/?$/, ''); // '' when API is relative, backend origin when API is absolute
// credentials: 'include' is required so the browser sends/caches the admin
// Basic Auth login when this page is hosted on a different origin than the
// backend (e.g. frontend on Netlify, backend on Render). Harmless when
// same-origin too.
const FETCH_OPTS = { credentials: 'include' };

function mediaUrl(p) {
  if (!p) return p;
  if (/^https?:\/\//.test(p)) return p;
  return MEDIA_ORIGIN + p;
}

function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2200);
}

async function jget(url) {
  const r = await fetch(url, FETCH_OPTS);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}
async function jpost(url, body) {
  const r = await fetch(url, { ...FETCH_OPTS, method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || 'Request failed');
  return data;
}
async function jdel(url) {
  const r = await fetch(url, { ...FETCH_OPTS, method: 'DELETE' });
  return r.json();
}
async function uploadFile(url, formEl) {
  const r = await fetch(url, { ...FETCH_OPTS, method: 'POST', body: new FormData(formEl) });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || 'Upload failed');
  return data;
}

// --- Tabs ---
document.getElementById('tabNav').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  document.querySelectorAll('.admin-nav button').forEach((b) => b.classList.remove('active'));
  document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
  btn.classList.add('active');
  document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
});

// --- Clubs ---
async function refreshClubs() {
  const clubs = await jget(`${API}/clubs`);
  document.getElementById('clubsTableBody').innerHTML = clubs.map((c) => `
    <tr>
      <td>${c.name}</td><td>${c.city || ''}</td><td>${c.state || ''}</td><td>${c.zone || ''}</td><td>${c.members_count}</td>
      <td><button class="btn danger small" onclick="deleteClub(${c.id})">Delete</button></td>
    </tr>
  `).join('') || '<tr><td colspan="6" class="empty">No clubs yet</td></tr>';

  const opts = clubs.map((c) => `<option value="${c.id}">${c.name}</option>`).join('');
  document.getElementById('regClubSelect').innerHTML = '<option value="">-- none --</option>' + opts;
  document.getElementById('partClubSelect').innerHTML = '<option value="">-- none --</option>' + opts;
}
window.deleteClub = async (id) => { await jdel(`${API}/clubs/${id}`); toast('Club deleted'); refreshClubs(); refreshStatsDependents(); };

document.getElementById('clubForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  await jpost(`${API}/clubs`, Object.fromEntries(fd.entries()));
  e.target.reset();
  toast('Club saved');
  refreshClubs();
});

document.getElementById('clubCsvForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const res = await uploadFile(`${API}/clubs/bulk-upload`, e.target);
    toast(`Imported ${res.imported} clubs`);
    e.target.reset();
    refreshClubs();
  } catch (err) { toast(err.message); }
});

// --- Registrations ---
async function refreshRegs() {
  const regs = await jget(`${API}/registrations`);
  document.getElementById('regsTableBody').innerHTML = regs.map((r) => `
    <tr>
      <td>${r.reg_number}</td>
      <td><span class="pill ${r.reg_type}">${r.reg_type}</span></td>
      <td>${r.club_name || '-'}</td>
      <td>₹${r.amount_paid}</td>
      <td>₹${r.amount_due}</td>
      <td><span class="pill ${r.payment_status}">${r.payment_status}</span></td>
      <td>${r.participant_count}</td>
      <td><button class="btn danger small" onclick="deleteReg(${r.id})">Delete</button></td>
    </tr>
  `).join('') || '<tr><td colspan="8" class="empty">No registrations yet</td></tr>';

  const opts = regs.map((r) => `<option value="${r.id}">${r.reg_number} (${r.club_name || '-'})</option>`).join('');
  document.getElementById('partRegSelect').innerHTML = '<option value="">-- none --</option>' + opts;
}
window.deleteReg = async (id) => { await jdel(`${API}/registrations/${id}`); toast('Registration deleted'); refreshRegs(); };

document.getElementById('regForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  await jpost(`${API}/registrations`, Object.fromEntries(fd.entries()));
  e.target.reset();
  toast('Registration saved');
  refreshRegs();
});

document.getElementById('regCsvForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const res = await uploadFile(`${API}/registrations/bulk-upload`, e.target);
    toast(`Imported ${res.imported} registrations`);
    e.target.reset();
    refreshRegs();
  } catch (err) { toast(err.message); }
});

// --- Participants ---
async function refreshParts(query) {
  const url = query ? `${API}/participants?q=${encodeURIComponent(query)}` : `${API}/participants`;
  const rows = await jget(url);
  document.getElementById('partsTableBody').innerHTML = rows.map((p) => `
    <tr>
      <td>${p.name}${p.designation ? ' <span class="hint">(' + p.designation + ')</span>' : ''}</td>
      <td>${p.club_name || '-'}</td>
      <td>${p.reg_number || '-'}</td>
      <td>${p.phone || '-'}</td>
      <td>${p.travel_mode ? p.travel_mode + ' ' + (p.travel_number || '') + '<br><span class="hint">' + (p.travel_datetime || '') + '</span>' : '-'}</td>
      <td>${p.pickup_by || '-'}${p.pickup_vehicle ? '<br><span class="hint">' + p.pickup_vehicle + '</span>' : ''}</td>
      <td>${p.spoc_name || '-'}${p.spoc_phone ? '<br><span class="hint">' + p.spoc_phone + '</span>' : ''}</td>
      <td><button class="btn danger small" onclick="deletePart(${p.id})">Delete</button></td>
    </tr>
  `).join('') || '<tr><td colspan="8" class="empty">No participants yet</td></tr>';
}
window.deletePart = async (id) => { await jdel(`${API}/participants/${id}`); toast('Participant deleted'); refreshParts(); };

document.getElementById('partForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const body = Object.fromEntries(fd.entries());
  if (!body.club_id) delete body.club_id;
  if (!body.registration_id) delete body.registration_id;
  await jpost(`${API}/participants`, body);
  e.target.reset();
  toast('Participant saved');
  refreshParts();
});

document.getElementById('partCsvForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const res = await uploadFile(`${API}/participants/bulk-upload`, e.target);
    toast(`Imported ${res.imported} participants`);
    e.target.reset();
    refreshParts();
  } catch (err) { toast(err.message); }
});

let searchTimer = null;
document.getElementById('partSearch').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => refreshParts(e.target.value), 300);
});

// --- Media ---
async function refreshMediaAdmin() {
  const videos = await jget(`${API}/media?type=video`);
  const posters = await jget(`${API}/media?type=poster`);
  const render = (items, kind) => items.map((m) => `
    <div class="thumb">
      ${kind === 'video' ? `<video src="${mediaUrl(m.filename)}" muted></video>` : `<img src="${mediaUrl(m.filename)}" />`}
      <div class="meta">
        <span>${m.title || ''}</span>
        <div>
          <button class="btn ${m.active ? 'outline' : 'gold'} small" onclick="toggleMedia(${m.id}, ${m.active ? 0 : 1})">${m.active ? 'Hide' : 'Show'}</button>
          <button class="btn danger small" onclick="deleteMedia(${m.id})">Del</button>
        </div>
      </div>
    </div>
  `).join('') || '<div class="empty">None uploaded yet</div>';
  document.getElementById('videoThumbs').innerHTML = render(videos, 'video');
  document.getElementById('posterThumbs').innerHTML = render(posters, 'poster');
}
window.toggleMedia = async (id, active) => {
  await fetch(`${API}/media/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ active }) });
  refreshMediaAdmin();
};
window.deleteMedia = async (id) => { await jdel(`${API}/media/${id}`); toast('Media removed'); refreshMediaAdmin(); };

document.getElementById('mediaForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await uploadFile(`${API}/media/upload`, e.target);
    e.target.reset();
    toast('Uploaded');
    refreshMediaAdmin();
  } catch (err) { toast(err.message); }
});

// --- Happenings ---
async function refreshHappeningsAdmin() {
  const rows = await jget(`${API}/happenings?limit=50`);
  document.getElementById('happeningsList').innerHTML = rows.map((h) => `
    <div class="feed-item">
      <div class="time">${new Date(h.happened_at.replace(' ', 'T') + 'Z').toLocaleString()} · ${h.category} · ${h.posted_by || ''}</div>
      <div class="title">${h.title}</div>
      <div class="desc">${h.description || ''}</div>
      <button class="btn danger small" style="margin-top:6px;" onclick="deleteHappening(${h.id})">Delete</button>
    </div>
  `).join('') || '<div class="empty">No updates yet</div>';
}
window.deleteHappening = async (id) => { await jdel(`${API}/happenings/${id}`); toast('Removed'); refreshHappeningsAdmin(); };

document.getElementById('happeningForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  await jpost(`${API}/happenings`, Object.fromEntries(fd.entries()));
  e.target.reset();
  toast('Posted');
  refreshHappeningsAdmin();
});

// --- Export ---
document.getElementById('exportBtn').addEventListener('click', async () => {
  const data = await jget(`${API}/export/voice-agent`);
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'voice-agent-data.json';
  a.click();
  URL.revokeObjectURL(url);
});

function refreshStatsDependents() { /* hook for cross-tab refresh if needed */ }

// --- Init ---
refreshClubs();
refreshRegs();
refreshParts();
refreshMediaAdmin();
refreshHappeningsAdmin();
