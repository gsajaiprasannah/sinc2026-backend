const API = ((window.SINC_CONFIG && window.SINC_CONFIG.API_BASE_URL) || '/api').replace(/\/$/, '');
const MEDIA_ORIGIN = API.replace(/\/api\/?$/, ''); // '' when API is relative, backend origin when API is absolute

const TOKEN_KEY = 'sinc_admin_token';
let CURRENT_USER = null;

function getToken() { return localStorage.getItem(TOKEN_KEY) || ''; }
function setToken(t) { if (t) localStorage.setItem(TOKEN_KEY, t); else localStorage.removeItem(TOKEN_KEY); }

function authHeaders(extra) {
  const h = Object.assign({}, extra || {});
  const t = getToken();
  if (t) h['Authorization'] = 'Bearer ' + t;
  return h;
}

function mediaUrl(p) {
  if (!p) return p;
  if (/^https?:\/\//.test(p)) return p;
  return MEDIA_ORIGIN + p;
}

// Only a super admin can delete records — everyone else can still create and
// edit, just not permanently remove anything. The backend enforces this too
// (a regular admin's DELETE request gets a 403 either way); this just keeps
// the button from being shown in the first place.
function canDelete() {
  return !!(CURRENT_USER && CURRENT_USER.role === 'super_admin');
}

let toastTimer = null;
function toast(msg, durationMs) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), durationMs || 2200);
}

// Thrown by jget/jpost/etc when the server says the session is no longer valid.
function handleUnauthorized() {
  setToken('');
  CURRENT_USER = null;
  showAuthGate();
}

// Parses a fetch Response as JSON, but falls back to a readable error
// instead of letting a non-JSON body (e.g. an HTML 404/500 page from a
// backend that hasn't picked up the latest deploy yet) throw an opaque
// "unexpected token" / "string did not match the expected pattern" parse
// error that gives no clue what actually went wrong.
async function parseJsonResponse(r) {
  const text = await r.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch (e) {
    const hint = !r.ok
      ? `Server returned HTTP ${r.status} instead of JSON — the backend may not have this endpoint deployed yet. Try a fresh Render deploy of the latest commit.`
      : 'Server returned an unexpected (non-JSON) response.';
    throw new Error(hint);
  }
}
async function jget(url) {
  const r = await fetch(url, { headers: authHeaders() });
  if (r.status === 401) { handleUnauthorized(); throw new Error('Please log in again.'); }
  const data = await parseJsonResponse(r);
  if (!r.ok) { const err = new Error(data.error || `Request failed (HTTP ${r.status})`); err.data = data; err.status = r.status; throw err; }
  return data;
}
async function jpost(url, body) {
  const r = await fetch(url, { method: 'POST', headers: authHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify(body) });
  if (r.status === 401) { handleUnauthorized(); throw new Error('Please log in again.'); }
  const data = await parseJsonResponse(r);
  if (!r.ok) { const err = new Error(data.error || `Request failed (HTTP ${r.status})`); err.data = data; err.status = r.status; throw err; }
  return data;
}
async function jput(url, body) {
  const r = await fetch(url, { method: 'PUT', headers: authHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify(body) });
  if (r.status === 401) { handleUnauthorized(); throw new Error('Please log in again.'); }
  const data = await parseJsonResponse(r);
  if (!r.ok) { const err = new Error(data.error || `Request failed (HTTP ${r.status})`); err.data = data; err.status = r.status; throw err; }
  return data;
}
async function jdel(url) {
  const r = await fetch(url, { method: 'DELETE', headers: authHeaders() });
  if (r.status === 401) { handleUnauthorized(); throw new Error('Please log in again.'); }
  const data = await parseJsonResponse(r);
  if (!r.ok) { const err = new Error(data.error || `Request failed (HTTP ${r.status})`); err.data = data; err.status = r.status; throw err; }
  return data;
}
async function uploadFile(url, formEl) {
  let r;
  try {
    r = await fetch(url, { method: 'POST', headers: authHeaders(), body: new FormData(formEl) });
  } catch (networkErr) {
    // fetch() itself rejects on a dropped connection (not just a non-2xx
    // response) — surface that clearly instead of a generic "Upload failed".
    throw new Error('Upload failed — the connection was interrupted. Check your internet connection and try again.');
  }
  if (r.status === 401) { handleUnauthorized(); throw new Error('Please log in again.'); }
  let data;
  try {
    data = await r.json();
  } catch (parseErr) {
    throw new Error(`Server returned an unexpected response (status ${r.status}). Please try again.`);
  }
  if (!r.ok) throw new Error(data.error || 'Upload failed');
  return data;
}

// --- Auth: login / signup / logout ---
function showAuthGate() {
  document.getElementById('authGate').style.display = 'block';
  document.getElementById('appShell').style.display = 'none';
  document.getElementById('logoutLink').style.display = 'none';
  document.getElementById('whoami').textContent = '';
}

function showApp() {
  document.getElementById('authGate').style.display = 'none';
  document.getElementById('appShell').style.display = 'block';
  document.getElementById('logoutLink').style.display = '';
  document.getElementById('whoami').textContent = CURRENT_USER ? `${CURRENT_USER.username} (${CURRENT_USER.role === 'super_admin' ? 'Super Admin' : 'Admin'})` : '';
  document.getElementById('settingsTabBtn').style.display = (CURRENT_USER && CURRENT_USER.role === 'super_admin') ? '' : 'none';
  loadAllData();
}

document.getElementById('showSignup').addEventListener('click', (e) => {
  e.preventDefault();
  document.getElementById('loginCard').style.display = 'none';
  document.getElementById('signupCard').style.display = 'block';
});
document.getElementById('showLogin').addEventListener('click', (e) => {
  e.preventDefault();
  document.getElementById('signupCard').style.display = 'none';
  document.getElementById('loginCard').style.display = 'block';
});

document.getElementById('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errEl = document.getElementById('loginError');
  errEl.style.display = 'none';
  const fd = new FormData(e.target);
  try {
    const r = await fetch(`${API}/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.fromEntries(fd.entries()))
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Login failed');
    setToken(data.token);
    CURRENT_USER = data.user;
    e.target.reset();
    showApp();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.style.display = 'block';
  }
});

document.getElementById('signupForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errEl = document.getElementById('signupError');
  const okEl = document.getElementById('signupSuccess');
  errEl.style.display = 'none';
  okEl.style.display = 'none';
  const fd = new FormData(e.target);
  try {
    const r = await fetch(`${API}/auth/signup`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.fromEntries(fd.entries()))
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Signup failed');
    okEl.textContent = data.message || 'Request submitted — wait for admin approval.';
    okEl.style.display = 'block';
    e.target.reset();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.style.display = 'block';
  }
});

document.getElementById('logoutLink').addEventListener('click', (e) => {
  e.preventDefault();
  setToken('');
  CURRENT_USER = null;
  showAuthGate();
});

async function tryResumeSession() {
  const t = getToken();
  if (!t) { showAuthGate(); return; }
  try {
    const user = await jget(`${API}/auth/me`);
    CURRENT_USER = user;
    showApp();
  } catch (e) {
    showAuthGate();
  }
}

// --- Sidebar hide/expand toggle (state remembered across visits) ---
const SIDEBAR_HIDDEN_KEY = 'sinc_admin_sidebar_hidden';
const adminShell = document.getElementById('adminShell');
const sidebarToggleBtn = document.getElementById('sidebarToggle');
function applySidebarState() {
  if (!adminShell) return;
  let hidden = localStorage.getItem(SIDEBAR_HIDDEN_KEY);
  if (hidden === null) hidden = window.innerWidth < 860 ? '1' : '0'; // sensible default on small screens
  adminShell.classList.toggle('sidebar-hidden', hidden === '1');
}
if (sidebarToggleBtn) {
  sidebarToggleBtn.addEventListener('click', () => {
    const nowHidden = !adminShell.classList.contains('sidebar-hidden');
    localStorage.setItem(SIDEBAR_HIDDEN_KEY, nowHidden ? '1' : '0');
    applySidebarState();
  });
}
applySidebarState();

// --- Tabs ---
document.getElementById('tabNav').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  document.querySelectorAll('.admin-nav button').forEach((b) => b.classList.remove('active'));
  document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
  btn.classList.add('active');
  document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
  if (btn.dataset.tab === 'settings') refreshUsersAdmin();
  // On phone/tablet widths the sidebar overlays the content, so tuck it away
  // again once a section has been picked (matches the standard mobile pattern).
  if (window.innerWidth < 860 && adminShell) {
    localStorage.setItem(SIDEBAR_HIDDEN_KEY, '1');
    applySidebarState();
  }
});

// --- Clubs ---
async function refreshClubs() {
  const clubs = await jget(`${API}/clubs`);
  document.getElementById('clubsTableBody').innerHTML = clubs.map((c) => `
    <tr>
      <td>${c.name}</td><td>${c.city || ''}</td><td>${c.state || ''}</td><td>${c.zone || ''}</td><td>${c.members_count}</td>
      <td>${canDelete() ? `<button class="btn danger small" onclick="deleteClub(${c.id})">Delete</button>` : ''}</td>
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
const REG_TYPE_LABEL = { single: 'Single', double: 'Double', congress_only: 'Congress Only' };
async function refreshRegs() {
  const regs = await jget(`${API}/registrations`);
  document.getElementById('regsTableBody').innerHTML = regs.map((r) => `
    <tr>
      <td>${r.reg_number}</td>
      <td><span class="pill ${r.reg_type}">${REG_TYPE_LABEL[r.reg_type] || r.reg_type}</span></td>
      <td>${r.club_name || '-'}</td>
      <td>₹${r.amount_paid}</td>
      <td>₹${r.amount_due}</td>
      <td><span class="pill ${r.payment_status}">${r.payment_status}</span></td>
      <td>${r.participant_count}</td>
      <td>${canDelete() ? `<button class="btn danger small" onclick="deleteReg(${r.id})">Delete</button>` : ''}</td>
    </tr>
  `).join('') || '<tr><td colspan="8" class="empty">No registrations yet</td></tr>';

  const opts = regs.map((r) => `<option value="${r.id}">${r.reg_number} (${r.club_name || '-'})</option>`).join('');
  document.getElementById('partRegSelect').innerHTML = '<option value="">-- none --</option>' + opts;
}
window.deleteReg = async (id) => { await jdel(`${API}/registrations/${id}`); toast('Registration deleted'); refreshRegs(); };

async function loadNextRegNumber() {
  const field = document.getElementById('regNumberField');
  if (!field) return;
  try {
    const res = await jget(`${API}/registrations/next-number`);
    field.value = res.reg_number;
  } catch (err) {
    field.value = '';
    field.placeholder = 'Could not auto-generate — reload page';
  }
}

document.getElementById('regForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  try {
    await jpost(`${API}/registrations`, Object.fromEntries(fd.entries()));
    e.target.reset();
    toast('Registration saved');
    refreshRegs();
    loadNextRegNumber();
  } catch (err) {
    // Someone else grabbed this number first (rare race) — fetch a fresh one and let the admin retry.
    toast(err.message);
    loadNextRegNumber();
  }
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
function paymentPill(status) {
  if (!status) return '<span class="hint">-</span>';
  return `<span class="pill ${status}">${status}</span>`;
}

// Prefers the linked host member (real, always-current contact info) over
// the legacy free-text spoc_name/spoc_phone, which only remain as a fallback
// for participants that predate the host-member link.
function spocDisplay(p) {
  if (p.spoc_host_member_name) {
    return `${p.spoc_host_member_name}<br><span class="hint">${p.spoc_host_member_phone || ''} (host member)</span>`;
  }
  return `${p.spoc_name || '-'}${p.spoc_phone ? '<br><span class="hint">' + p.spoc_phone + '</span>' : ''}`;
}

async function refreshParts(query) {
  const url = query ? `${API}/participants?q=${encodeURIComponent(query)}` : `${API}/participants`;
  const rows = await jget(url);
  document.getElementById('partsTableBody').innerHTML = rows.map((p) => `
    <tr>
      <td><strong>${p.participant_code || '-'}</strong></td>
      <td>${p.name}${p.designation ? ' <span class="hint">(' + p.designation + ')</span>' : ''}</td>
      <td>${p.club_name || '-'}</td>
      <td>${p.reg_number || '-'}</td>
      <td>${p.phone || '-'}</td>
      <td>${p.travel_mode ? p.travel_mode + ' ' + (p.travel_number || '') + '<br><span class="hint">' + (p.travel_datetime || '') + '</span>' : '-'}</td>
      <td>${p.pickup_by || '-'}${p.pickup_vehicle ? '<br><span class="hint">' + p.pickup_vehicle + '</span>' : ''}</td>
      <td>${spocDisplay(p)}</td>
      <td>${paymentPill(p.payment_status)}</td>
      <td>
        <button class="btn small" onclick="editPart(${p.id})">Edit</button>
        <button class="btn small" onclick="openChecklistModal('participant', ${p.id})">Kit</button>
        ${canDelete() ? `<button class="btn danger small" onclick="deletePart(${p.id})">Delete</button>` : ''}
      </td>
    </tr>
  `).join('') || '<tr><td colspan="10" class="empty">No delegates yet</td></tr>';
}
window.deletePart = async (id) => { await jdel(`${API}/participants/${id}`); toast('Delegate deleted'); refreshParts(); };

const PART_FORM_FIELDS = [
  'name', 'phone', 'whatsapp', 'email', 'address', 'club_id', 'registration_id', 'designation', 'is_primary',
  'travel_mode', 'travel_number', 'travel_datetime', 'arrival_point',
  'departure_mode', 'departure_number', 'departure_datetime',
  'pickup_by', 'pickup_vehicle', 'pickup_phone', 'spoc_name', 'spoc_phone', 'notes'
];

// Loads an existing delegate into the Add Delegate form and switches
// it into "update" mode (tracked via form.dataset.editId) so the same form
// is used for both creating and editing — no separate edit screen needed.
window.editPart = async (id) => {
  let p;
  try {
    p = await jget(`${API}/participants/${id}`);
  } catch (err) {
    toast(err.message);
    return;
  }
  const form = document.getElementById('partForm');
  PART_FORM_FIELDS.forEach((f) => {
    const el = form.elements[f];
    if (!el) return;
    el.value = p[f] !== null && p[f] !== undefined ? p[f] : '';
  });
  if (form.elements.spoc_host_member_id) {
    form.elements.spoc_host_member_id.value = p.spoc_host_member_id || '';
  }
  form.dataset.editId = id;
  document.getElementById('partFormTitle').textContent = `Edit delegate — ${p.participant_code || p.name}`;
  document.getElementById('partSubmitBtn').textContent = 'Update Delegate';
  document.getElementById('partCancelEditBtn').style.display = '';
  form.scrollIntoView({ behavior: 'smooth', block: 'start' });
};

window.cancelEditPart = () => {
  const form = document.getElementById('partForm');
  form.reset();
  delete form.dataset.editId;
  document.getElementById('partFormTitle').textContent = 'Add delegate';
  document.getElementById('partSubmitBtn').textContent = 'Save Delegate';
  document.getElementById('partCancelEditBtn').style.display = 'none';
};

async function savePartForm(form, force) {
  const fd = new FormData(form);
  const body = Object.fromEntries(fd.entries());
  // spoc_host_member_id isn't a participants column — it's saved separately
  // as a delegate_assignments row (role='SPOC') via /api/assignments/spoc/:id.
  const spocHostMemberId = body.spoc_host_member_id || '';
  delete body.spoc_host_member_id;
  if (!body.club_id) delete body.club_id;
  if (!body.registration_id) delete body.registration_id;
  // travel_mode/departure_mode have a DB check constraint allowing only
  // flight/train/road/other or NULL — an empty string (the "-" placeholder
  // option) would violate it, so strip it rather than send "".
  if (!body.travel_mode) delete body.travel_mode;
  if (!body.departure_mode) delete body.departure_mode;
  if (force) body.force = true;
  const editId = form.dataset.editId;
  try {
    let participantId = editId;
    if (editId) {
      await jput(`${API}/participants/${editId}`, body);
      toast('Delegate updated');
    } else {
      const res = await jpost(`${API}/participants`, body);
      participantId = res.id;
      toast(`Delegate saved${res.participant_code ? ' — Registration ID ' + res.participant_code : ''}`);
    }
    if (participantId) {
      try {
        await jput(`${API}/assignments/spoc/${participantId}`, { host_member_id: spocHostMemberId || null });
      } catch (spocErr) {
        toast('Delegate saved, but SPOC link failed: ' + spocErr.message);
      }
    }
    if (editId) window.cancelEditPart();
    else form.reset();
    refreshParts();
  } catch (err) {
    if (err.status === 409 && err.data && err.data.error === 'duplicate') {
      const proceed = confirm(err.data.message + '\n\nClick OK to save anyway, or Cancel to go back and edit.');
      if (proceed) return savePartForm(form, true);
    } else {
      toast(err.message);
    }
  }
}

document.getElementById('partForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  await savePartForm(e.target, false);
});

document.getElementById('partCancelEditBtn').addEventListener('click', (e) => {
  e.preventDefault();
  window.cancelEditPart();
});

document.getElementById('partCsvForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const res = await uploadFile(`${API}/participants/bulk-upload`, e.target);
    let msg = `Imported ${res.imported} delegates`;
    if (res.skipped) msg += `, skipped ${res.skipped} likely duplicates`;
    toast(msg);
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
          ${canDelete() ? `<button class="btn danger small" onclick="deleteMedia(${m.id})">Del</button>` : ''}
        </div>
      </div>
    </div>
  `).join('') || '<div class="empty">None uploaded yet</div>';
  document.getElementById('videoThumbs').innerHTML = render(videos, 'video');
  document.getElementById('posterThumbs').innerHTML = render(posters, 'poster');
}
window.toggleMedia = async (id, active) => { await jput(`${API}/media/${id}`, { active }); refreshMediaAdmin(); };
window.deleteMedia = async (id) => { await jdel(`${API}/media/${id}`); toast('Media removed'); refreshMediaAdmin(); };

document.getElementById('mediaForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const btn = form.querySelector('button[type="submit"]');
  const fileInput = form.querySelector('input[type="file"]');
  if (!fileInput.files.length) { toast('Choose a file first'); return; }

  const originalLabel = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Uploading… do not close this tab';
  toast(`Uploading ${fileInput.files[0].name} — this can take a while for large videos`, 6000);
  try {
    const res = await uploadFile(`${API}/media/upload`, form);
    form.reset();
    toast('Upload complete and verified on the server', 3000);
    refreshMediaAdmin();
  } catch (err) {
    toast(err.message, 8000);
  } finally {
    btn.disabled = false;
    btn.textContent = originalLabel;
  }
});

// --- Happenings ---
async function refreshHappeningsAdmin() {
  const rows = await jget(`${API}/happenings?limit=50`);
  document.getElementById('happeningsList').innerHTML = rows.map((h) => `
    <div class="feed-item">
      <div class="time">${new Date(h.happened_at.replace(' ', 'T') + 'Z').toLocaleString()} · ${h.category} · ${h.posted_by || ''}</div>
      <div class="title">${h.title}</div>
      <div class="desc">${h.description || ''}</div>
      ${canDelete() ? `<button class="btn danger small" style="margin-top:6px;" onclick="deleteHappening(${h.id})">Delete</button>` : ''}
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

// --- Itinerary (congress agenda, editable — shown on public dashboard) ---
async function refreshItinerary() {
  const rows = await jget(`${API}/itinerary`);
  document.getElementById('itinTableBody').innerHTML = rows.map((it) => `
    <tr>
      <td>${it.day_label}</td>
      <td>${it.time_label || '-'}</td>
      <td>${it.title}</td>
      <td>${it.description || '-'}</td>
      <td>
        <button class="btn small" onclick="editItin(${it.id})">Edit</button>
        ${canDelete() ? `<button class="btn danger small" onclick="deleteItin(${it.id})">Delete</button>` : ''}
      </td>
    </tr>
  `).join('') || '<tr><td colspan="5" class="empty">No itinerary items yet</td></tr>';
}
window.deleteItin = async (id) => { await jdel(`${API}/itinerary/${id}`); toast('Itinerary item deleted'); refreshItinerary(); };

window.editItin = async (id) => {
  const it = await jget(`${API}/itinerary/${id}`);
  const form = document.getElementById('itinForm');
  ['day_label', 'time_label', 'title', 'description', 'sort_order'].forEach((f) => {
    if (form.elements[f]) form.elements[f].value = it[f] !== null && it[f] !== undefined ? it[f] : '';
  });
  form.dataset.editId = id;
  document.getElementById('itinFormTitle').textContent = 'Edit itinerary item';
  document.getElementById('itinSubmitBtn').textContent = 'Update Item';
  document.getElementById('itinCancelEditBtn').style.display = '';
  form.scrollIntoView({ behavior: 'smooth', block: 'start' });
};
window.cancelEditItin = () => {
  const form = document.getElementById('itinForm');
  form.reset();
  delete form.dataset.editId;
  document.getElementById('itinFormTitle').textContent = 'Add itinerary item';
  document.getElementById('itinSubmitBtn').textContent = 'Save Item';
  document.getElementById('itinCancelEditBtn').style.display = 'none';
};
document.getElementById('itinCancelEditBtn').addEventListener('click', (e) => { e.preventDefault(); window.cancelEditItin(); });
document.getElementById('itinForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const body = Object.fromEntries(new FormData(form).entries());
  const editId = form.dataset.editId;
  try {
    if (editId) {
      await jput(`${API}/itinerary/${editId}`, body);
      toast('Itinerary item updated');
      window.cancelEditItin();
    } else {
      await jpost(`${API}/itinerary`, body);
      form.reset();
      toast('Itinerary item saved');
    }
    refreshItinerary();
  } catch (err) { toast(err.message); }
});

// --- Host Members ---
async function refreshHostMembers(query) {
  const rows = await jget(`${API}/hostmembers`);
  const q = (query || '').toLowerCase();
  const filtered = q
    ? rows.filter((h) => [h.name, h.phone, h.company].filter(Boolean).some((v) => String(v).toLowerCase().includes(q)))
    : rows;
  document.getElementById('hmTableBody').innerHTML = filtered.map((h) => {
    const committeeNames = (h.committees || []).map((c) => c.name);
    const committeesLabel = committeeNames.length > 2
      ? committeeNames.slice(0, 2).join(', ') + ` +${committeeNames.length - 2} more`
      : (committeeNames.join(', ') || '-');
    return `
    <tr>
      <td class="sticky-col">${h.name}${h.designation ? ' <span class="hint">(' + h.designation + ')</span>' : ''}</td>
      <td>${h.company || '-'}</td>
      <td>${h.phone || '-'}</td>
      <td style="white-space:normal;max-width:220px;" title="${committeeNames.join(', ')}">${committeesLabel}</td>
      <td><span class="pill ${h.payment_status}">${h.payment_status}</span> <span class="hint">₹${h.payment_amount}</span></td>
      <td>${h.user_id ? '<span class="pill paid">has login</span>' : `<button class="btn small" onclick="createHostLogin(${h.id}, '${(h.name || '').replace(/'/g, '')}')">Create login</button>`}</td>
      <td class="sticky-actions">
        <button class="btn small" onclick="editHm(${h.id})">Edit</button>
        <button class="btn small" onclick="openChecklistModal('host_member', ${h.id})">Kit</button>
        ${canDelete() ? `<button class="btn danger small" onclick="deleteHm(${h.id})">Delete</button>` : ''}
      </td>
    </tr>
  `;
  }).join('') || '<tr><td colspan="7" class="empty">No host members yet</td></tr>';

  // Keep every other tab's host-member dropdowns in sync with the latest list.
  const opts = rows.map((h) => `<option value="${h.id}">${h.name}${h.company ? ' (' + h.company + ')' : ''}</option>`).join('');
  ['committeeHmSelect', 'assignHmSelect', 'taskHmSelect', 'createUserHmSelect', 'partSpocHmSelect', 'tripPassengerHmSelect', 'tourPartHmSelect', 'roomHmSelect', 'sponsorHmSelect', 'speakerHmSelect', 'gvHmSelect'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = '<option value="">-- select --</option>' + opts;
  });
}
window.deleteHm = async (id) => { await jdel(`${API}/hostmembers/${id}`); toast('Host member deleted'); refreshHostMembers(); };

window.createHostLogin = async (id, name) => {
  const username = prompt(`Username for ${name}'s login:`, (name || '').toLowerCase().replace(/[^a-z0-9]+/g, '.').replace(/^\.+|\.+$/g, ''));
  if (!username) return;
  const password = prompt('Temporary password (they can change it after logging in, min 6 characters):');
  if (!password || password.length < 6) { toast('Password must be at least 6 characters'); return; }
  try {
    await jpost(`${API}/auth/users`, { username, password, role: 'host_member', host_member_id: id });
    toast(`Login created for ${name}. Share the username/password with them — they log in at host.html.`, 6000);
    refreshHostMembers();
  } catch (err) { toast(err.message); }
};

const HM_FORM_FIELDS = ['name', 'phone', 'email', 'company', 'designation', 'category', 'payment_status', 'payment_amount', 'payment_mode', 'payment_date', 'notes'];
window.editHm = async (id) => {
  const h = await jget(`${API}/hostmembers/${id}`);
  const form = document.getElementById('hmForm');
  HM_FORM_FIELDS.forEach((f) => {
    if (form.elements[f]) form.elements[f].value = h[f] !== null && h[f] !== undefined ? h[f] : '';
  });
  form.dataset.editId = id;
  document.getElementById('hmFormTitle').textContent = `Edit host member — ${h.name}`;
  document.getElementById('hmSubmitBtn').textContent = 'Update Host Member';
  document.getElementById('hmCancelEditBtn').style.display = '';
  form.scrollIntoView({ behavior: 'smooth', block: 'start' });
};
window.cancelEditHm = () => {
  const form = document.getElementById('hmForm');
  form.reset();
  delete form.dataset.editId;
  document.getElementById('hmFormTitle').textContent = 'Add host member';
  document.getElementById('hmSubmitBtn').textContent = 'Save Host Member';
  document.getElementById('hmCancelEditBtn').style.display = 'none';
};
document.getElementById('hmCancelEditBtn').addEventListener('click', (e) => { e.preventDefault(); window.cancelEditHm(); });
async function saveHmForm(form, force) {
  const body = Object.fromEntries(new FormData(form).entries());
  if (force) body.force = true;
  const editId = form.dataset.editId;
  try {
    if (editId) {
      await jput(`${API}/hostmembers/${editId}`, body);
      toast('Host member updated');
      window.cancelEditHm();
    } else {
      await jpost(`${API}/hostmembers`, body);
      form.reset();
      toast('Host member saved');
    }
    refreshHostMembers();
  } catch (err) {
    if (err.status === 409 && err.data && err.data.error === 'duplicate') {
      const proceed = confirm(err.data.message + '\n\nClick OK to save anyway, or Cancel to go back and edit.');
      if (proceed) return saveHmForm(form, true);
    } else {
      toast(err.message);
    }
  }
}
document.getElementById('hmForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  await saveHmForm(e.target, false);
});
document.getElementById('hmCsvForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const res = await uploadFile(`${API}/hostmembers/bulk-upload`, e.target);
    toast(`Imported ${res.imported} host members`);
    e.target.reset();
    refreshHostMembers();
  } catch (err) { toast(err.message); }
});
let hmSearchTimer = null;
document.getElementById('hmSearch').addEventListener('input', (e) => {
  clearTimeout(hmSearchTimer);
  hmSearchTimer = setTimeout(() => refreshHostMembers(e.target.value), 300);
});

// --- Host Registration & Payments ---
// A view dedicated to the host club members' own ₹5,000 personal
// contribution. This reads/writes the SAME host_members rows as the Host
// Members tab (just the payment_* columns) — it never touches the
// `registrations` table used by the delegate "Registrations & Payments" tab,
// so the two payment streams can never mix up.
async function refreshHostPayments() {
  const rows = await jget(`${API}/hostmembers`);
  const paidCount = rows.filter((h) => h.payment_status === 'paid').length;
  const pendingCount = rows.length - paidCount;
  const totalCollected = rows
    .filter((h) => h.payment_status === 'paid')
    .reduce((sum, h) => sum + Number(h.payment_amount || 0), 0);
  document.getElementById('hostPaymentStats').innerHTML = `
    <div class="stat-card"><div class="value">${rows.length}</div><div class="label">Host Members</div></div>
    <div class="stat-card"><div class="value">${paidCount}</div><div class="label">Paid</div></div>
    <div class="stat-card"><div class="value">${pendingCount}</div><div class="label">Pending</div></div>
    <div class="stat-card"><div class="value">₹${totalCollected.toLocaleString('en-IN')}</div><div class="label">Total Collected</div></div>
  `;
  document.getElementById('hostPaymentsTableBody').innerHTML = rows.map((h) => `
    <tr>
      <td class="sticky-col-left"><strong>${h.name}</strong></td>
      <td>
        <select id="hp-status-${h.id}" class="hp-status-select ${h.payment_status}">
          <option value="pending" ${h.payment_status === 'pending' ? 'selected' : ''}>Pending</option>
          <option value="paid" ${h.payment_status === 'paid' ? 'selected' : ''}>Paid</option>
        </select>
      </td>
      <td><input id="hp-amount-${h.id}" type="number" value="${h.payment_amount}" style="width:100px;" /></td>
      <td>${h.company || '-'}</td>
      <td>${h.phone || '-'}</td>
      <td><input id="hp-mode-${h.id}" type="text" value="${(h.payment_mode || '').replace(/"/g, '&quot;')}" style="width:120px;" placeholder="UPI / Bank / Others" /></td>
      <td><input id="hp-date-${h.id}" type="date" value="${h.payment_date ? new Date(h.payment_date).toISOString().slice(0, 10) : ''}" /></td>
      <td><input id="hp-notes-${h.id}" type="text" value="${(h.notes || '').replace(/"/g, '&quot;')}" style="width:150px;" /></td>
      <td class="sticky-actions"><button class="btn small" onclick="saveHostPayment(${h.id})">Save</button></td>
    </tr>
  `).join('') || '<tr><td colspan="9" class="empty">No host members yet</td></tr>';
}
window.saveHostPayment = async (id) => {
  const body = {
    payment_status: document.getElementById(`hp-status-${id}`).value,
    payment_amount: document.getElementById(`hp-amount-${id}`).value,
    payment_mode: document.getElementById(`hp-mode-${id}`).value,
    payment_date: document.getElementById(`hp-date-${id}`).value || null,
    notes: document.getElementById(`hp-notes-${id}`).value
  };
  try {
    await jput(`${API}/hostmembers/${id}`, body);
    toast('Payment updated');
    refreshHostPayments();
    refreshHostMembers();
  } catch (err) { toast(err.message); }
};

// --- Committees ---
let ALL_COMMITTEES_CACHE = [];
async function refreshCommittees() {
  const rows = await jget(`${API}/committees`);
  ALL_COMMITTEES_CACHE = rows;
  document.getElementById('committeesList').innerHTML = rows.map((c) => `
    <div class="card" style="margin-bottom:10px;">
      <div style="display:flex;justify-content:space-between;align-items:center;">
        <strong>${c.name}</strong>
        <div>
          <button class="btn small" onclick="editCommittee(${c.id})">Edit</button>
          <button class="btn small" onclick="toggleCommitteeTasks(${c.id})">Checklist &amp; Milestones (${c.tasks_completed || 0}/${c.task_count || 0})</button>
          ${canDelete() ? `<button class="btn danger small" onclick="deleteCommittee(${c.id})">Delete</button>` : ''}
        </div>
      </div>
      ${c.description ? `<p class="hint" style="margin:6px 0 0;white-space:pre-wrap;">${c.description}</p>` : ''}
      <div style="margin-top:8px;display:flex;flex-wrap:wrap;gap:6px;">
        ${(c.members || []).map((m) => `
          <span class="pill single" style="display:inline-flex;align-items:center;gap:6px;">
            ${m.name}${canDelete() ? ` <a href="#" onclick="removeCommitteeMember(${c.id}, ${m.id});return false;" style="color:inherit;">✕</a>` : ''}
          </span>
        `).join('') || '<span class="hint">No members assigned yet</span>'}
      </div>
      <div id="committeeTasksPanel-${c.id}" style="display:none;margin-top:12px;border-top:1px solid var(--line);padding-top:12px;"></div>
    </div>
  `).join('') || '<div class="empty">No committees yet</div>';

  const opts = rows.map((c) => `<option value="${c.id}">${c.name}</option>`).join('');
  document.getElementById('committeeSelect').innerHTML = opts;

  // Re-render innerHTML wipes any open checklist/milestones panels — reopen
  // whichever ones were open before this refresh so admin actions inside
  // them (add/delete/toggle) don't visibly close the panel each time.
  for (const id of openCommitteeTaskPanels) {
    const panel = document.getElementById(`committeeTasksPanel-${id}`);
    if (panel) { panel.style.display = ''; renderCommitteeTasksPanel(id); }
  }
}
let openCommitteeTaskPanels = new Set();

window.toggleCommitteeTasks = async (committeeId) => {
  const panel = document.getElementById(`committeeTasksPanel-${committeeId}`);
  if (!panel) return;
  const isOpen = panel.style.display !== 'none';
  if (isOpen) {
    panel.style.display = 'none';
    openCommitteeTaskPanels.delete(committeeId);
  } else {
    panel.style.display = '';
    openCommitteeTaskPanels.add(committeeId);
    await renderCommitteeTasksPanel(committeeId);
  }
};

async function renderCommitteeTasksPanel(committeeId) {
  const panel = document.getElementById(`committeeTasksPanel-${committeeId}`);
  if (!panel) return;
  const tasks = await jget(`${API}/committees/${committeeId}/tasks`);
  panel.innerHTML = `
    <form onsubmit="return submitCommitteeTask(event, ${committeeId})" style="margin-bottom:10px;">
      <div class="form-grid cols-3">
        <div class="field"><label>Title *</label><input name="title" required /></div>
        <div class="field"><label>Due date</label><input name="due_date" type="date" /></div>
        <div class="field"><label>Type</label>
          <select name="is_milestone"><option value="0">Checklist item</option><option value="1">Milestone</option></select>
        </div>
      </div>
      <div class="field"><label>Description</label><textarea name="description"></textarea></div>
      <button class="btn gold small" type="submit">Add checklist item / milestone</button>
    </form>
    ${tasks.map((t) => {
      const total = Number(t.total_members) || 0;
      const done = Number(t.done_count) || 0;
      const allDone = total > 0 && done === total;
      return `
        <div style="padding:8px 0;border-bottom:1px solid var(--line);">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;">
            <div>
              ${Number(t.is_milestone) ? '<span class="pill double">Milestone</span> ' : ''}
              <strong>${t.title}</strong>
              ${t.due_date ? ` <span class="hint">due ${t.due_date}</span>` : ''}
              ${t.description ? `<br><span class="hint">${t.description}</span>` : ''}
            </div>
            <div style="text-align:right;white-space:nowrap;">
              <span class="pill ${allDone ? 'done' : 'in_progress'}">${done}/${total} done</span>
              ${canDelete() ? `<button class="btn danger small" onclick="deleteCommitteeTask(${t.id}, ${committeeId})">Delete</button>` : ''}
            </div>
          </div>
          <div style="margin-top:6px;display:flex;flex-wrap:wrap;gap:6px;">
            ${(t.members || []).map((m) => `
              <span class="pill ${m.status === 'done' ? 'done' : 'not_started'}" style="cursor:pointer;" title="Click to toggle" onclick="toggleCommitteeMemberCompletion(${m.completion_id}, '${m.status}', ${committeeId})">
                ${m.name} ${m.status === 'done' ? '✓' : ''}
              </span>
            `).join('')}
          </div>
        </div>
      `;
    }).join('') || '<p class="hint">No checklist items or milestones yet.</p>'}
  `;
}
window.submitCommitteeTask = async (e, committeeId) => {
  e.preventDefault();
  const body = Object.fromEntries(new FormData(e.target).entries());
  try {
    await jpost(`${API}/committees/${committeeId}/tasks`, body);
    e.target.reset();
    toast('Checklist item added');
    openCommitteeTaskPanels.add(committeeId);
    refreshCommittees();
  } catch (err) { toast(err.message); }
  return false;
};
window.deleteCommitteeTask = async (taskId, committeeId) => {
  await jdel(`${API}/committees/tasks/${taskId}`);
  toast('Removed');
  refreshCommittees();
};
window.toggleCommitteeMemberCompletion = async (completionId, currentStatus, committeeId) => {
  const next = currentStatus === 'done' ? 'pending' : 'done';
  try {
    await jput(`${API}/committees/tasks/completions/${completionId}`, { status: next });
    refreshCommittees();
  } catch (err) { toast(err.message); }
};
window.removeCommitteeMember = async (committeeId, hostMemberId) => {
  await jdel(`${API}/committees/${committeeId}/members/${hostMemberId}`);
  toast('Removed from committee');
  refreshCommittees();
};
window.deleteCommittee = async (id) => {
  if (!confirm('Delete this committee? Members will be unassigned from it, but not deleted themselves.')) return;
  try {
    await jdel(`${API}/committees/${id}`);
    toast('Committee deleted');
    refreshCommittees();
  } catch (err) { toast(err.message); }
};
window.editCommittee = (id) => {
  const c = ALL_COMMITTEES_CACHE.find((x) => x.id === id);
  if (!c) return;
  const form = document.getElementById('committeeForm');
  form.elements.name.value = c.name;
  form.elements.sort_order.value = c.sort_order;
  form.elements.description.value = c.description || '';
  form.dataset.editId = id;
  document.getElementById('committeeFormTitle').textContent = `Edit committee — ${c.name}`;
  document.getElementById('committeeSubmitBtn').textContent = 'Update Committee';
  document.getElementById('committeeCancelEditBtn').style.display = '';
  form.scrollIntoView({ behavior: 'smooth', block: 'start' });
};
window.cancelEditCommittee = () => {
  const form = document.getElementById('committeeForm');
  form.reset();
  delete form.dataset.editId;
  document.getElementById('committeeFormTitle').textContent = 'Add committee';
  document.getElementById('committeeSubmitBtn').textContent = 'Save Committee';
  document.getElementById('committeeCancelEditBtn').style.display = 'none';
};
document.getElementById('committeeCancelEditBtn').addEventListener('click', (e) => { e.preventDefault(); window.cancelEditCommittee(); });
document.getElementById('committeeForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const body = Object.fromEntries(new FormData(form).entries());
  const editId = form.dataset.editId;
  try {
    if (editId) {
      await jput(`${API}/committees/${editId}`, body);
      toast('Committee updated');
      window.cancelEditCommittee();
    } else {
      await jpost(`${API}/committees`, body);
      form.reset();
      toast('Committee saved');
    }
    refreshCommittees();
  } catch (err) { toast(err.message); }
});
document.getElementById('committeeAssignForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const committeeId = fd.get('committee_id');
  const hostMemberId = fd.get('host_member_id');
  if (!hostMemberId) { toast('Choose a host member'); return; }
  try {
    await jpost(`${API}/committees/${committeeId}/members`, { host_member_id: hostMemberId });
    toast('Added to committee');
    refreshCommittees();
  } catch (err) { toast(err.message); }
});

// --- Delegate assistance assignments ---
async function refreshAssignments() {
  const rows = await jget(`${API}/assignments`);
  document.getElementById('assignTableBody').innerHTML = rows.map((a) => `
    <tr>
      <td>${a.host_member_name}<br><span class="hint">${a.host_member_phone || ''}</span></td>
      <td>${a.participant_name}<br><span class="hint">${a.participant_code || ''}</span></td>
      <td>${a.club_name || '-'}</td>
      <td>${a.reg_number || '-'}</td>
      <td>
        <select onchange="updateAssignmentStatus(${a.id}, this.value)">
          <option value="not_started" ${a.status === 'not_started' ? 'selected' : ''}>Not started</option>
          <option value="in_progress" ${a.status === 'in_progress' ? 'selected' : ''}>In progress</option>
          <option value="completed" ${a.status === 'completed' ? 'selected' : ''}>Completed</option>
        </select>
      </td>
      <td>${a.notes || '-'}</td>
      <td>${canDelete() ? `<button class="btn danger small" onclick="deleteAssignment(${a.id})">Delete</button>` : ''}</td>
    </tr>
  `).join('') || '<tr><td colspan="7" class="empty">No assignments yet</td></tr>';
}
window.deleteAssignment = async (id) => { await jdel(`${API}/assignments/${id}`); toast('Assignment removed'); refreshAssignments(); };
window.updateAssignmentStatus = async (id, status) => {
  try {
    await jput(`${API}/assignments/${id}`, { status });
    toast('Status updated');
  } catch (err) { toast(err.message); }
};

async function refreshAssignmentDropdowns() {
  const parts = await jget(`${API}/participants`);
  const opts = parts.map((p) => `<option value="${p.id}">${p.name} — ${p.participant_code || ''} (${p.club_name || 'no club'})</option>`).join('');
  ['assignPartSelect', 'tripPassengerParticipantSelect', 'tourPartParticipantSelect', 'roomParticipantSelect'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = opts;
  });
}

document.getElementById('assignForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = Object.fromEntries(new FormData(e.target).entries());
  try {
    await jpost(`${API}/assignments`, body);
    e.target.reset();
    toast('Assignment created');
    refreshAssignments();
  } catch (err) { toast(err.message); }
});

// --- Checklists & milestones (host_tasks) ---
async function refreshTasks() {
  const rows = await jget(`${API}/tasks`);
  document.getElementById('taskTableBody').innerHTML = rows.map((t) => `
    <tr>
      <td>${t.host_member_name}</td>
      <td>${t.title}${t.description ? '<br><span class="hint">' + t.description + '</span>' : ''}</td>
      <td>${Number(t.is_milestone) ? '<span class="pill double">Milestone</span>' : '<span class="hint">Checklist</span>'}</td>
      <td>
        <select onchange="updateTaskStatus(${t.id}, this.value)">
          <option value="pending" ${t.status === 'pending' ? 'selected' : ''}>Pending</option>
          <option value="in_progress" ${t.status === 'in_progress' ? 'selected' : ''}>In progress</option>
          <option value="done" ${t.status === 'done' ? 'selected' : ''}>Done</option>
        </select>
      </td>
      <td>${t.due_date ? new Date(t.due_date).toLocaleDateString() : '-'}</td>
      <td>${canDelete() ? `<button class="btn danger small" onclick="deleteTask(${t.id})">Delete</button>` : ''}</td>
    </tr>
  `).join('') || '<tr><td colspan="6" class="empty">No tasks yet</td></tr>';
}
window.deleteTask = async (id) => { await jdel(`${API}/tasks/${id}`); toast('Task removed'); refreshTasks(); };
window.updateTaskStatus = async (id, status) => {
  try {
    await jput(`${API}/tasks/${id}`, { status });
    toast('Status updated');
  } catch (err) { toast(err.message); }
};
document.getElementById('taskForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = Object.fromEntries(new FormData(e.target).entries());
  try {
    await jpost(`${API}/tasks`, body);
    e.target.reset();
    toast('Task saved');
    refreshTasks();
  } catch (err) { toast(err.message); }
});

// --- Partners & Drivers (masters) ---
async function refreshPartners() {
  const rows = await jget(`${API}/partners`);
  document.getElementById('partnerTableBody').innerHTML = rows.map((p) => `
    <tr>
      <td>${p.category}</td>
      <td>${p.name}</td>
      <td>${p.contact_person || '-'}</td>
      <td>${p.phone || '-'}</td>
      <td>${canDelete() ? `<button class="btn danger small" onclick="deletePartner(${p.id})">Delete</button>` : ''}</td>
    </tr>
  `).join('') || '<tr><td colspan="5" class="empty">No partners yet</td></tr>';

  const opts = rows.map((p) => `<option value="${p.id}">${p.name}</option>`).join('');
  ['driverPartnerSelect', 'vehiclePartnerSelect'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = '<option value="">-- none --</option>' + opts;
  });
}
window.deletePartner = async (id) => { await jdel(`${API}/partners/${id}`); toast('Partner removed'); refreshPartners(); };
async function savePartnerForm(form, force) {
  const body = Object.fromEntries(new FormData(form).entries());
  if (force) body.force = true;
  try {
    await jpost(`${API}/partners`, body);
    form.reset();
    toast('Partner saved');
    refreshPartners();
  } catch (err) {
    if (err.status === 409) {
      const proceed = confirm(err.message + '\n\nClick OK to save anyway, or Cancel to go back and edit.');
      if (proceed) return savePartnerForm(form, true);
    } else {
      toast(err.message);
    }
  }
}
document.getElementById('partnerForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  await savePartnerForm(e.target, false);
});

async function refreshDrivers() {
  const rows = await jget(`${API}/drivers`);
  document.getElementById('driverTableBody').innerHTML = rows.map((d) => `
    <tr>
      <td>${d.name}</td>
      <td>${d.phone || '-'}</td>
      <td>${d.vehicle_code
        ? `${d.vehicle_code} <span class="hint">(${d.vehicle_master_type}, ${d.seating_capacity} seats)</span>`
        : (`${d.vehicle_type || ''} ${d.vehicle_number || ''}`.trim() || '<span class="hint">none</span>')}</td>
      <td>${d.partner_name || '-'}</td>
      <td>${canDelete() ? `<button class="btn danger small" onclick="deleteDriver(${d.id})">Delete</button>` : ''}</td>
    </tr>
  `).join('') || '<tr><td colspan="5" class="empty">No drivers yet</td></tr>';

  const driverOpts = rows.map((d) => `<option value="${d.id}">${d.name}${d.vehicle_code ? ' — ' + d.vehicle_code : ''}</option>`).join('');
  ['tripDriverSelect', 'tourTripDriverSelect'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = '<option value="">-- none --</option>' + driverOpts;
  });
}
window.deleteDriver = async (id) => { await jdel(`${API}/drivers/${id}`); toast('Driver removed'); refreshDrivers(); };
async function saveDriverForm(form, force) {
  const body = Object.fromEntries(new FormData(form).entries());
  if (!body.partner_id) delete body.partner_id;
  if (!body.vehicle_id) delete body.vehicle_id;
  if (force) body.force = true;
  try {
    await jpost(`${API}/drivers`, body);
    form.reset();
    toast('Driver saved');
    refreshDrivers();
  } catch (err) {
    if (err.status === 409) {
      const proceed = confirm(err.message + '\n\nClick OK to save anyway, or Cancel to go back and edit.');
      if (proceed) return saveDriverForm(form, true);
    } else {
      toast(err.message);
    }
  }
}
document.getElementById('driverForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  await saveDriverForm(e.target, false);
});

// --- Operations: Vehicles (masters) ---
async function refreshVehicles() {
  const rows = await jget(`${API}/vehicles`);
  document.getElementById('vehicleTableBody').innerHTML = rows.map((v) => `
    <tr>
      <td><strong>${v.vehicle_code}</strong></td>
      <td style="text-transform:capitalize;">${v.vehicle_type}</td>
      <td>${v.model || '-'}</td>
      <td>${v.seating_capacity}</td>
      <td>${v.registration_number || '-'}</td>
      <td>${v.partner_name || '-'}</td>
      <td class="sticky-actions">
        <button class="btn small" onclick="editVehicle(${v.id})">Edit</button>
        ${canDelete() ? `<button class="btn danger small" onclick="deleteVehicle(${v.id})">Delete</button>` : ''}
      </td>
    </tr>
  `).join('') || '<tr><td colspan="7" class="empty">No vehicles yet</td></tr>';

  const opts = rows.map((v) => `<option value="${v.id}">${v.vehicle_code} · ${v.vehicle_type} (${v.seating_capacity} seats)${v.model ? ' — ' + v.model : ''}</option>`).join('');
  document.getElementById('driverVehicleSelect').innerHTML = '<option value="">-- none --</option>' + opts;
  ['tripVehicleSelect', 'tourTripVehicleSelect'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = '<option value="">-- select vehicle --</option>' + opts;
  });
}
window.deleteVehicle = async (id) => { await jdel(`${API}/vehicles/${id}`); toast('Vehicle removed'); refreshVehicles(); refreshDrivers(); };

async function loadNextVehicleCode() {
  const form = document.getElementById('vehicleForm');
  if (form.dataset.editId) return; // don't touch the code of an existing vehicle mid-edit
  try {
    const type = document.getElementById('vehicleTypeSelect').value;
    const { vehicle_code } = await jget(`${API}/vehicles/next-code?type=${type}`);
    document.getElementById('vehicleCodeField').value = vehicle_code;
  } catch (e) { /* preview only — ignore failures */ }
}
document.getElementById('vehicleTypeSelect').addEventListener('change', loadNextVehicleCode);

const VEHICLE_FORM_FIELDS = ['vehicle_type', 'vehicle_code', 'model', 'seating_capacity', 'registration_number', 'partner_id', 'notes'];
window.editVehicle = async (id) => {
  const rows = await jget(`${API}/vehicles`);
  const v = rows.find((r) => r.id === id);
  if (!v) return;
  const form = document.getElementById('vehicleForm');
  VEHICLE_FORM_FIELDS.forEach((f) => { if (form.elements[f]) form.elements[f].value = v[f] !== null && v[f] !== undefined ? v[f] : ''; });
  form.dataset.editId = id;
  // The code's prefix is tied to the type — lock type editing so the two can't drift apart silently.
  document.getElementById('vehicleTypeSelect').disabled = true;
  document.getElementById('vehicleFormTitle').textContent = `Edit vehicle — ${v.vehicle_code}`;
  document.getElementById('vehicleSubmitBtn').textContent = 'Update Vehicle';
  document.getElementById('vehicleCancelEditBtn').style.display = '';
  form.scrollIntoView({ behavior: 'smooth', block: 'start' });
};
window.cancelEditVehicle = () => {
  const form = document.getElementById('vehicleForm');
  form.reset();
  delete form.dataset.editId;
  document.getElementById('vehicleTypeSelect').disabled = false;
  document.getElementById('vehicleFormTitle').textContent = 'Add vehicle';
  document.getElementById('vehicleSubmitBtn').textContent = 'Save Vehicle';
  document.getElementById('vehicleCancelEditBtn').style.display = 'none';
  loadNextVehicleCode();
};
document.getElementById('vehicleCancelEditBtn').addEventListener('click', (e) => { e.preventDefault(); window.cancelEditVehicle(); });
async function saveVehicleForm(form) {
  const body = Object.fromEntries(new FormData(form).entries());
  if (!body.partner_id) delete body.partner_id;
  const editId = form.dataset.editId;
  try {
    if (editId) {
      delete body.vehicle_code;
      await jput(`${API}/vehicles/${editId}`, body);
      toast('Vehicle updated');
      window.cancelEditVehicle();
    } else {
      await jpost(`${API}/vehicles`, body);
      form.reset();
      toast('Vehicle saved');
      loadNextVehicleCode();
    }
    refreshVehicles();
    refreshDrivers();
  } catch (err) {
    if (err.status === 409) toast(err.data && err.data.message || err.message);
    else toast(err.message);
  }
}
document.getElementById('vehicleForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  await saveVehicleForm(e.target);
});

// --- Operations: Transport Planning (shuttle/trip manifests) ---
function capacityBadge(count, capacity) {
  if (!capacity) return String(count);
  return `<span class="pill ${count > capacity ? 'pending' : 'paid'}">${count}/${capacity}</span>`;
}
function tripStatusPill(status) {
  const cls = status === 'completed' ? 'completed' : status === 'cancelled' ? 'pending' : status === 'in_progress' ? 'in_progress' : 'not_started';
  return `<span class="pill ${cls}">${(status || '').replace('_', ' ')}</span>`;
}

async function refreshTransportTrips() {
  const rows = await jget(`${API}/transport?pre_tour_id=none`);
  document.getElementById('tripTableBody').innerHTML = rows.map((t) => `
    <tr>
      <td>${t.trip_date || '-'}</td>
      <td>${t.depart_time || '-'}</td>
      <td>${t.from_location} → ${t.to_location}</td>
      <td>${t.purpose || '-'}</td>
      <td>${t.vehicle_code ? `${t.vehicle_code} <span class="hint">(${t.vehicle_type})</span>` : '<span class="hint">unassigned</span>'}</td>
      <td>${t.driver_name || '-'}</td>
      <td>${capacityBadge(Number(t.passenger_count), t.seating_capacity)}</td>
      <td>${tripStatusPill(t.status)}</td>
      <td class="sticky-actions">
        <button class="btn small" onclick="manageTripPassengers(${t.id}, '${(t.from_location + ' → ' + t.to_location).replace(/'/g, '')}')">Passengers</button>
        <button class="btn small" onclick="editTrip(${t.id})">Edit</button>
        ${canDelete() ? `<button class="btn danger small" onclick="deleteTrip(${t.id})">Delete</button>` : ''}
      </td>
    </tr>
  `).join('') || '<tr><td colspan="9" class="empty">No trips planned yet</td></tr>';
}
window.deleteTrip = async (id) => {
  await jdel(`${API}/transport/${id}`);
  toast('Trip removed');
  refreshTransportTrips();
  if (currentTripId === id) { currentTripId = null; document.getElementById('tripPassengerCard').style.display = 'none'; }
};

const TRIP_FORM_FIELDS = ['trip_date', 'depart_time', 'from_location', 'to_location', 'purpose', 'vehicle_id', 'driver_id', 'status', 'notes'];
window.editTrip = async (id) => {
  const rows = await jget(`${API}/transport?pre_tour_id=none`);
  const t = rows.find((r) => r.id === id);
  if (!t) return;
  const form = document.getElementById('tripForm');
  TRIP_FORM_FIELDS.forEach((f) => { if (form.elements[f]) form.elements[f].value = t[f] !== null && t[f] !== undefined ? t[f] : ''; });
  form.dataset.editId = id;
  document.getElementById('tripFormTitle').textContent = 'Edit trip';
  document.getElementById('tripSubmitBtn').textContent = 'Update Trip';
  document.getElementById('tripCancelEditBtn').style.display = '';
  form.scrollIntoView({ behavior: 'smooth', block: 'start' });
};
window.cancelEditTrip = () => {
  const form = document.getElementById('tripForm');
  form.reset();
  delete form.dataset.editId;
  document.getElementById('tripFormTitle').textContent = 'Add trip';
  document.getElementById('tripSubmitBtn').textContent = 'Save Trip';
  document.getElementById('tripCancelEditBtn').style.display = 'none';
};
document.getElementById('tripCancelEditBtn').addEventListener('click', (e) => { e.preventDefault(); window.cancelEditTrip(); });
async function saveTripForm(form) {
  const body = Object.fromEntries(new FormData(form).entries());
  if (!body.driver_id) delete body.driver_id;
  const editId = form.dataset.editId;
  try {
    if (editId) {
      await jput(`${API}/transport/${editId}`, body);
      toast('Trip updated');
      window.cancelEditTrip();
    } else {
      await jpost(`${API}/transport`, body);
      form.reset();
      toast('Trip saved');
    }
    refreshTransportTrips();
  } catch (err) { toast(err.message); }
}
document.getElementById('tripForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  await saveTripForm(e.target);
});

// Passenger manifest for whichever trip is currently selected for management.
let currentTripId = null;
window.manageTripPassengers = async (id, label) => {
  currentTripId = id;
  document.getElementById('tripPassengerTripLabel').textContent = label;
  document.getElementById('tripPassengerCard').style.display = '';
  await refreshTripPassengers();
  document.getElementById('tripPassengerCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
};
async function refreshTripPassengers() {
  if (!currentTripId) return;
  const trip = await jget(`${API}/transport/${currentTripId}`);
  document.getElementById('tripPassengerTableBody').innerHTML = (trip.passengers || []).map((p) => `
    <tr>
      <td>${p.participant_name || p.host_member_name}</td>
      <td>${p.participant_id ? 'Delegate' : 'Host member'}</td>
      <td>${p.participant_phone || p.host_member_phone || '-'}</td>
      <td>${p.pickup_point || '-'}</td>
      <td>${canDelete() ? `<button class="btn danger small" onclick="removeTripPassenger(${p.id})">Remove</button>` : ''}</td>
    </tr>
  `).join('') || '<tr><td colspan="5" class="empty">No passengers added yet</td></tr>';
}
window.removeTripPassenger = async (passengerId) => {
  await jdel(`${API}/transport/${currentTripId}/passengers/${passengerId}`);
  toast('Passenger removed');
  refreshTripPassengers();
  refreshTransportTrips();
};
document.getElementById('tripPassengerTypeSelect').addEventListener('change', (e) => {
  const isHm = e.target.value === 'host_member';
  document.getElementById('tripPassengerParticipantSelect').style.display = isHm ? 'none' : '';
  document.getElementById('tripPassengerHmSelect').style.display = isHm ? '' : 'none';
});
document.getElementById('tripPassengerForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!currentTripId) { toast('Select a trip first — click "Passengers" on a row below.'); return; }
  const isHm = document.getElementById('tripPassengerTypeSelect').value === 'host_member';
  const body = {
    participant_id: isHm ? null : (document.getElementById('tripPassengerParticipantSelect').value || null),
    host_member_id: isHm ? (document.getElementById('tripPassengerHmSelect').value || null) : null,
    pickup_point: document.getElementById('tripPassengerPickup').value
  };
  if (!body.participant_id && !body.host_member_id) { toast('Choose a delegate or a host member'); return; }
  try {
    await jpost(`${API}/transport/${currentTripId}/passengers`, body);
    document.getElementById('tripPassengerPickup').value = '';
    toast('Passenger added');
    refreshTripPassengers();
    refreshTransportTrips();
  } catch (err) { toast(err.message); }
});

// --- Operations: Pre Tours ---
async function refreshPreTours() {
  const rows = await jget(`${API}/pretours`);
  document.getElementById('tourTableBody').innerHTML = rows.map((t) => `
    <tr>
      <td><strong>${t.name}</strong></td>
      <td>${t.start_date || '-'}${t.end_date ? ' → ' + t.end_date : ''}</td>
      <td>${t.hotel || '-'}</td>
      <td>${t.capacity ? `${t.participant_count}/${t.capacity}` : t.participant_count}</td>
      <td>${t.trip_count}</td>
      <td><span class="pill ${t.status === 'confirmed' || t.status === 'completed' ? 'paid' : t.status === 'cancelled' ? 'pending' : 'not_started'}">${t.status}</span></td>
      <td class="sticky-actions">
        <button class="btn small" onclick="manageTour(${t.id}, '${(t.name || '').replace(/'/g, '')}')">Manage</button>
        <button class="btn small" onclick="editTour(${t.id})">Edit</button>
        ${canDelete() ? `<button class="btn danger small" onclick="deleteTour(${t.id})">Delete</button>` : ''}
      </td>
    </tr>
  `).join('') || '<tr><td colspan="7" class="empty">No pre tours yet</td></tr>';
}
window.deleteTour = async (id) => {
  await jdel(`${API}/pretours/${id}`);
  toast('Pre tour removed');
  refreshPreTours();
  if (currentTourId === id) { currentTourId = null; document.getElementById('tourManageCard').style.display = 'none'; }
};

const TOUR_FORM_FIELDS = ['name', 'start_date', 'end_date', 'hotel', 'capacity', 'price', 'attractions', 'description', 'status', 'notes'];
window.editTour = async (id) => {
  const rows = await jget(`${API}/pretours`);
  const t = rows.find((r) => r.id === id);
  if (!t) return;
  const form = document.getElementById('tourForm');
  TOUR_FORM_FIELDS.forEach((f) => { if (form.elements[f]) form.elements[f].value = t[f] !== null && t[f] !== undefined ? t[f] : ''; });
  form.dataset.editId = id;
  document.getElementById('tourFormTitle').textContent = `Edit pre tour — ${t.name}`;
  document.getElementById('tourSubmitBtn').textContent = 'Update Pre Tour';
  document.getElementById('tourCancelEditBtn').style.display = '';
  form.scrollIntoView({ behavior: 'smooth', block: 'start' });
};
window.cancelEditTour = () => {
  const form = document.getElementById('tourForm');
  form.reset();
  delete form.dataset.editId;
  document.getElementById('tourFormTitle').textContent = 'Add pre tour';
  document.getElementById('tourSubmitBtn').textContent = 'Save Pre Tour';
  document.getElementById('tourCancelEditBtn').style.display = 'none';
};
document.getElementById('tourCancelEditBtn').addEventListener('click', (e) => { e.preventDefault(); window.cancelEditTour(); });
async function saveTourForm(form) {
  const body = Object.fromEntries(new FormData(form).entries());
  const editId = form.dataset.editId;
  try {
    if (editId) {
      await jput(`${API}/pretours/${editId}`, body);
      toast('Pre tour updated');
      window.cancelEditTour();
    } else {
      await jpost(`${API}/pretours`, body);
      form.reset();
      toast('Pre tour saved');
    }
    refreshPreTours();
  } catch (err) { toast(err.message); }
}
document.getElementById('tourForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  await saveTourForm(e.target);
});

// Manage panel (itinerary + signups + transport) for whichever tour is selected.
let currentTourId = null;
window.manageTour = async (id, name) => {
  currentTourId = id;
  document.getElementById('tourManageLabel').textContent = name;
  document.getElementById('tourManageCard').style.display = '';
  await Promise.all([refreshTourItinerary(), refreshTourParticipants(), refreshTourTrips()]);
  document.getElementById('tourManageCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
};

async function refreshTourItinerary() {
  if (!currentTourId) return;
  const rows = await jget(`${API}/pretours/${currentTourId}/itinerary`);
  document.getElementById('tourItinTableBody').innerHTML = rows.map((i) => `
    <tr>
      <td>${i.day_label}</td><td>${i.time_label || '-'}</td><td>${i.title}</td><td>${i.location || '-'}</td>
      <td>${canDelete() ? `<button class="btn danger small" onclick="deleteTourItinItem(${i.id})">Delete</button>` : ''}</td>
    </tr>
  `).join('') || '<tr><td colspan="5" class="empty">No itinerary items yet</td></tr>';
}
window.deleteTourItinItem = async (itemId) => {
  await jdel(`${API}/pretours/itinerary/${itemId}`);
  toast('Itinerary item removed');
  refreshTourItinerary();
};
document.getElementById('tourItinForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!currentTourId) { toast('Click "Manage" on a tour first'); return; }
  const body = Object.fromEntries(new FormData(e.target).entries());
  try {
    await jpost(`${API}/pretours/${currentTourId}/itinerary`, body);
    e.target.reset();
    toast('Itinerary item added');
    refreshTourItinerary();
  } catch (err) { toast(err.message); }
});

async function refreshTourParticipants() {
  if (!currentTourId) return;
  const rows = await jget(`${API}/pretours/${currentTourId}/participants`);
  document.getElementById('tourPartTableBody').innerHTML = rows.map((r) => `
    <tr>
      <td>${r.participant_name || r.host_member_name}</td>
      <td>${r.participant_id ? 'Delegate' : 'Host member'}</td>
      <td>${r.participant_phone || r.host_member_phone || '-'}</td>
      <td><select onchange="updateTourParticipantPayment(${r.id}, this.value)">
        <option value="pending" ${r.payment_status === 'pending' ? 'selected' : ''}>Pending</option>
        <option value="paid" ${r.payment_status === 'paid' ? 'selected' : ''}>Paid</option>
      </select></td>
      <td>${canDelete() ? `<button class="btn danger small" onclick="deleteTourParticipant(${r.id})">Remove</button>` : ''}</td>
    </tr>
  `).join('') || '<tr><td colspan="5" class="empty">No signups yet</td></tr>';
  refreshPreTours(); // keep the signup counts on the tours table fresh
}
window.updateTourParticipantPayment = async (rowId, payment_status) => {
  try { await jput(`${API}/pretours/participants/${rowId}`, { payment_status }); toast('Payment status updated'); } catch (err) { toast(err.message); }
};
window.deleteTourParticipant = async (rowId) => {
  await jdel(`${API}/pretours/participants/${rowId}`);
  toast('Removed from tour');
  refreshTourParticipants();
};
document.getElementById('tourPartTypeSelect').addEventListener('change', (e) => {
  const isHm = e.target.value === 'host_member';
  document.getElementById('tourPartParticipantSelect').style.display = isHm ? 'none' : '';
  document.getElementById('tourPartHmSelect').style.display = isHm ? '' : 'none';
});
document.getElementById('tourPartForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!currentTourId) { toast('Click "Manage" on a tour first'); return; }
  const isHm = document.getElementById('tourPartTypeSelect').value === 'host_member';
  const body = {
    participant_id: isHm ? null : (document.getElementById('tourPartParticipantSelect').value || null),
    host_member_id: isHm ? (document.getElementById('tourPartHmSelect').value || null) : null,
    payment_status: document.getElementById('tourPartPaymentSelect').value
  };
  if (!body.participant_id && !body.host_member_id) { toast('Choose a delegate or a host member'); return; }
  try {
    await jpost(`${API}/pretours/${currentTourId}/participants`, body);
    toast('Added to tour');
    refreshTourParticipants();
  } catch (err) { toast(err.message); }
});

async function refreshTourTrips() {
  if (!currentTourId) return;
  const rows = await jget(`${API}/transport?pre_tour_id=${currentTourId}`);
  document.getElementById('tourTripTableBody').innerHTML = rows.map((t) => `
    <tr>
      <td>${t.trip_date || '-'}</td>
      <td>${t.from_location} → ${t.to_location}</td>
      <td>${t.vehicle_code || '-'}</td>
      <td>${t.driver_name || '-'}</td>
      <td>${capacityBadge(Number(t.passenger_count), t.seating_capacity)}</td>
      <td>${canDelete() ? `<button class="btn danger small" onclick="deleteTourTrip(${t.id})">Delete</button>` : ''}</td>
    </tr>
  `).join('') || '<tr><td colspan="6" class="empty">No transport planned yet</td></tr>';
}
window.deleteTourTrip = async (id) => { await jdel(`${API}/transport/${id}`); toast('Trip removed'); refreshTourTrips(); refreshPreTours(); };
document.getElementById('tourTripForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!currentTourId) { toast('Click "Manage" on a tour first'); return; }
  const body = Object.fromEntries(new FormData(e.target).entries());
  if (!body.driver_id) delete body.driver_id;
  body.pre_tour_id = currentTourId;
  try {
    await jpost(`${API}/transport`, body);
    e.target.reset();
    toast('Trip added');
    refreshTourTrips();
    refreshPreTours();
  } catch (err) { toast(err.message); }
});

// --- Shared, reusable customizable checklist modal ---
// Used by Sponsors (benefit checklist), Guest Speakers (checklist), Guest
// Visitors (offerings), and the goodies/kit handover checklist on
// Participants + Host Members. Quick-add suggestions are drawn live from the
// master checklist templates (managed on the Checklists & Milestones tab —
// see refreshChecklistTemplates() below), not hardcoded here.
const CHECKLIST_BASE = { sponsor: 'sponsors', speaker: 'speakers', guest_visitor: 'guestvisitors', participant: 'participants', host_member: 'hostmembers' };

async function fetchChecklistTemplateLabels(ownerType) {
  try {
    const rows = await jget(`${API}/checklist-templates?owner_type=${encodeURIComponent(ownerType)}`);
    return rows.map((r) => r.label);
  } catch (e) { return []; }
}

let checklistCtx = { ownerType: null, ownerId: null };

window.openChecklistModal = async (ownerType, ownerId) => {
  checklistCtx = { ownerType, ownerId };
  const base = CHECKLIST_BASE[ownerType];
  let titleLabel = '';
  try {
    const owner = await jget(`${API}/${base}/${ownerId}`);
    titleLabel = owner.name || '';
  } catch (e) { /* title just won't show a name */ }
  document.getElementById('checklistModalTitle').textContent = titleLabel ? `Checklist — ${titleLabel}` : 'Checklist';
  document.getElementById('checklistModal').style.display = '';
  await renderChecklistBody();
};
window.closeChecklistModal = () => {
  document.getElementById('checklistModal').style.display = 'none';
  checklistCtx = { ownerType: null, ownerId: null };
};

async function renderChecklistBody() {
  const { ownerType, ownerId } = checklistCtx;
  if (!ownerType || !ownerId) return;
  const base = CHECKLIST_BASE[ownerType];
  const items = await jget(`${API}/${base}/${ownerId}/checklist`);
  const rowsHtml = items.map((it) => `
    <div class="checklist-row status-${it.status}">
      <select onchange="updateChecklistItemStatus(${it.id}, this.value)">
        <option value="pending" ${it.status === 'pending' ? 'selected' : ''}>Pending</option>
        <option value="in_progress" ${it.status === 'in_progress' ? 'selected' : ''}>In progress</option>
        <option value="done" ${it.status === 'done' ? 'selected' : ''}>Done</option>
      </select>
      <span class="checklist-label">${it.label}</span>
      ${canDelete() ? `<button class="btn danger small" onclick="deleteChecklistItem(${it.id})">Delete</button>` : ''}
    </div>
  `).join('') || '<p class="empty">No checklist items yet — add one below.</p>';

  const templates = await fetchChecklistTemplateLabels(ownerType);
  const existingLabels = new Set(items.map((it) => it.label));
  const suggestions = templates.filter((t) => !existingLabels.has(t));

  document.getElementById('checklistModalBody').innerHTML = `
    ${rowsHtml}
    <form onsubmit="return submitChecklistItem(event)" style="margin-top:12px;display:flex;gap:8px;">
      <input name="label" placeholder="Add a checklist item..." required style="flex:1;" />
      <button class="btn gold small" type="submit">Add</button>
    </form>
    ${suggestions.length ? `
      <div style="margin-top:10px;">
        <span class="hint">Quick add suggestions:</span>
        <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:6px;">
          ${suggestions.map((s) => `<button type="button" class="btn outline small" onclick="quickAddChecklistItem('${s.replace(/'/g, "\\'")}')">+ ${s}</button>`).join('')}
        </div>
        <button type="button" class="btn small" style="margin-top:8px;" onclick="quickAddAllChecklistItems()">+ Add all suggested items</button>
      </div>
    ` : ''}
  `;
}

window.updateChecklistItemStatus = async (itemId, status) => {
  try { await jput(`${API}/checklist-items/${itemId}`, { status }); await renderChecklistBody(); refreshOwnerListForChecklist(); }
  catch (err) { toast(err.message); }
};
window.deleteChecklistItem = async (itemId) => {
  await jdel(`${API}/checklist-items/${itemId}`);
  await renderChecklistBody();
  refreshOwnerListForChecklist();
};
window.submitChecklistItem = async (e) => {
  e.preventDefault();
  const { ownerType, ownerId } = checklistCtx;
  const base = CHECKLIST_BASE[ownerType];
  const label = e.target.elements.label.value.trim();
  if (!label) return false;
  try {
    await jpost(`${API}/${base}/${ownerId}/checklist`, { label });
    e.target.reset();
    await renderChecklistBody();
    refreshOwnerListForChecklist();
  } catch (err) { toast(err.message); }
  return false;
};
window.quickAddChecklistItem = async (label) => {
  const { ownerType, ownerId } = checklistCtx;
  const base = CHECKLIST_BASE[ownerType];
  try {
    await jpost(`${API}/${base}/${ownerId}/checklist`, { label });
    await renderChecklistBody();
    refreshOwnerListForChecklist();
  } catch (err) { toast(err.message); }
};
window.quickAddAllChecklistItems = async () => {
  const { ownerType, ownerId } = checklistCtx;
  const base = CHECKLIST_BASE[ownerType];
  try {
    const templates = await fetchChecklistTemplateLabels(ownerType);
    if (!templates.length) { toast('No master checklist template items defined for this category yet — add some from Checklists & Milestones.'); return; }
    await jpost(`${API}/${base}/${ownerId}/checklist/bulk`, { items: templates.map((label) => ({ label })) });
    await renderChecklistBody();
    refreshOwnerListForChecklist();
  } catch (err) { toast(err.message); }
};

// --- Master checklist templates (per category) ---
async function refreshChecklistTemplates() {
  const filterSel = document.getElementById('checklistTemplateFilterSelect');
  if (!filterSel) return;
  const ownerType = filterSel.value || 'sponsor';
  const rows = await jget(`${API}/checklist-templates?owner_type=${encodeURIComponent(ownerType)}`);
  document.getElementById('checklistTemplateTableBody').innerHTML = rows.map((t) => `
    <tr>
      <td>${t.category || '-'}</td>
      <td>${t.label}</td>
      <td>${t.sort_order}</td>
      <td class="sticky-actions">
        <button class="btn small" onclick="editChecklistTemplate(${t.id})">Edit</button>
        ${canDelete() ? `<button class="btn danger small" onclick="deleteChecklistTemplate(${t.id})">Delete</button>` : ''}
      </td>
    </tr>
  `).join('') || '<tr><td colspan="4" class="empty">No template items yet for this category — add one above.</td></tr>';
}
document.getElementById('checklistTemplateFilterSelect')?.addEventListener('change', refreshChecklistTemplates);

document.getElementById('checklistTemplateForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const body = {
    owner_type: form.elements.owner_type.value,
    category: form.elements.category.value,
    sort_order: Number(form.elements.sort_order.value) || 0,
    label: form.elements.label.value.trim()
  };
  if (!body.label) return;
  try {
    if (form.dataset.editId) {
      await jput(`${API}/checklist-templates/${form.dataset.editId}`, body);
      toast('Checklist template item updated.');
      delete form.dataset.editId;
      document.getElementById('checklistTemplateSubmitBtn').textContent = 'Add template item';
      document.getElementById('checklistTemplateCancelEditBtn').style.display = 'none';
    } else {
      await jpost(`${API}/checklist-templates`, body);
      toast('Checklist template item added.');
    }
    form.reset();
    form.elements.owner_type.value = body.owner_type;
    document.getElementById('checklistTemplateFilterSelect').value = body.owner_type;
    await refreshChecklistTemplates();
  } catch (err) { toast(err.message); }
});
document.getElementById('checklistTemplateCancelEditBtn')?.addEventListener('click', () => {
  const form = document.getElementById('checklistTemplateForm');
  form.reset(); delete form.dataset.editId;
  document.getElementById('checklistTemplateSubmitBtn').textContent = 'Add template item';
  document.getElementById('checklistTemplateCancelEditBtn').style.display = 'none';
});
window.editChecklistTemplate = async (id) => {
  const ownerType = document.getElementById('checklistTemplateFilterSelect').value;
  const rows = await jget(`${API}/checklist-templates?owner_type=${encodeURIComponent(ownerType)}`);
  const t = rows.find((r) => r.id === id);
  if (!t) return;
  const form = document.getElementById('checklistTemplateForm');
  form.elements.owner_type.value = t.owner_type;
  form.elements.category.value = t.category || '';
  form.elements.sort_order.value = t.sort_order;
  form.elements.label.value = t.label;
  form.dataset.editId = id;
  document.getElementById('checklistTemplateSubmitBtn').textContent = 'Update template item';
  document.getElementById('checklistTemplateCancelEditBtn').style.display = '';
  form.scrollIntoView({ behavior: 'smooth', block: 'start' });
};
window.deleteChecklistTemplate = async (id) => {
  if (!confirm('Delete this checklist template item? Existing checklists that already used it are unaffected.')) return;
  try {
    await jdel(`${API}/checklist-templates/${id}`);
    await refreshChecklistTemplates();
  } catch (err) { toast(err.message); }
};
// Refreshes whichever admin table shows a checklist progress count, after the
// modal makes a change. Harmless no-op for tabs whose table isn't in the DOM.
function refreshOwnerListForChecklist() {
  const t = checklistCtx.ownerType;
  if (t === 'sponsor') refreshSponsors();
  if (t === 'speaker') refreshSpeakers();
  if (t === 'guest_visitor') refreshGuestVisitors();
}

// --- Sponsors ---
async function refreshSponsors() {
  const rows = await jget(`${API}/sponsors`);
  document.getElementById('sponsorTableBody').innerHTML = rows.map((s) => `
    <tr>
      <td><strong>${s.sponsor_pass_code || '-'}</strong></td>
      <td>${s.name}</td>
      <td>${s.tier || '-'}</td>
      <td>${s.guest_relation_name || '-'}</td>
      <td>${s.checklist_done}/${s.checklist_total}</td>
      <td><span class="pill ${s.status === 'confirmed' ? 'paid' : s.status === 'cancelled' ? 'pending' : 'not_started'}">${s.status}</span></td>
      <td class="sticky-actions">
        <button class="btn small" onclick="editSponsor(${s.id})">Edit</button>
        <button class="btn small" onclick="openChecklistModal('sponsor', ${s.id})">Checklist</button>
        ${canDelete() ? `<button class="btn danger small" onclick="deleteSponsor(${s.id})">Delete</button>` : ''}
      </td>
    </tr>
  `).join('') || '<tr><td colspan="7" class="empty">No sponsors yet</td></tr>';
}
window.deleteSponsor = async (id) => { await jdel(`${API}/sponsors/${id}`); toast('Sponsor deleted'); refreshSponsors(); };

const SPONSOR_FORM_FIELDS = ['name', 'tier', 'contact_person', 'phone', 'email', 'guest_relation_host_member_id', 'status', 'notes'];
window.editSponsor = async (id) => {
  const s = await jget(`${API}/sponsors/${id}`);
  const form = document.getElementById('sponsorForm');
  SPONSOR_FORM_FIELDS.forEach((f) => { if (form.elements[f]) form.elements[f].value = s[f] !== null && s[f] !== undefined ? s[f] : ''; });
  form.dataset.editId = id;
  document.getElementById('sponsorFormTitle').textContent = 'Edit sponsor';
  document.getElementById('sponsorSubmitBtn').textContent = 'Update Sponsor';
  document.getElementById('sponsorCancelEditBtn').style.display = '';
  form.scrollIntoView({ behavior: 'smooth', block: 'start' });
};
document.getElementById('sponsorCancelEditBtn').addEventListener('click', () => {
  const form = document.getElementById('sponsorForm');
  form.reset(); delete form.dataset.editId;
  document.getElementById('sponsorFormTitle').textContent = 'Add sponsor';
  document.getElementById('sponsorSubmitBtn').textContent = 'Save Sponsor';
  document.getElementById('sponsorCancelEditBtn').style.display = 'none';
});
document.getElementById('sponsorForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const body = Object.fromEntries(new FormData(form).entries());
  try {
    if (form.dataset.editId) {
      await jput(`${API}/sponsors/${form.dataset.editId}`, body);
      delete form.dataset.editId;
      form.reset();
      document.getElementById('sponsorFormTitle').textContent = 'Add sponsor';
      document.getElementById('sponsorSubmitBtn').textContent = 'Save Sponsor';
      document.getElementById('sponsorCancelEditBtn').style.display = 'none';
      toast('Sponsor updated');
    } else {
      const res = await jpost(`${API}/sponsors`, body);
      form.reset();
      toast(`Sponsor saved — pass code ${res.sponsor_pass_code}`);
    }
    refreshSponsors();
  } catch (err) { toast(err.message); }
});

// --- Guest Speakers ---
async function refreshSpeakers() {
  const rows = await jget(`${API}/speakers`);
  document.getElementById('speakerTableBody').innerHTML = rows.map((s) => `
    <tr>
      <td>${s.name}${s.designation ? ' <span class="hint">(' + s.designation + ')</span>' : ''}</td>
      <td>${s.session_type}</td>
      <td style="white-space:normal;max-width:260px;">${s.topic || '-'}</td>
      <td>${s.guest_relation_name || '-'}</td>
      <td>${s.checklist_done}/${s.checklist_total}</td>
      <td><span class="pill ${s.status === 'confirmed' ? 'paid' : s.status === 'cancelled' ? 'pending' : 'not_started'}">${s.status}</span></td>
      <td class="sticky-actions">
        <button class="btn small" onclick="editSpeaker(${s.id})">Edit</button>
        <button class="btn small" onclick="openChecklistModal('speaker', ${s.id})">Checklist</button>
        ${canDelete() ? `<button class="btn danger small" onclick="deleteSpeaker(${s.id})">Delete</button>` : ''}
      </td>
    </tr>
  `).join('') || '<tr><td colspan="7" class="empty">No guest speakers yet</td></tr>';
}
window.deleteSpeaker = async (id) => { await jdel(`${API}/speakers/${id}`); toast('Speaker deleted'); refreshSpeakers(); };

const SPEAKER_FORM_FIELDS = ['name', 'designation', 'organization', 'phone', 'email', 'topic', 'session_type', 'guest_relation_host_member_id', 'status', 'notes'];
window.editSpeaker = async (id) => {
  const s = await jget(`${API}/speakers/${id}`);
  const form = document.getElementById('speakerForm');
  SPEAKER_FORM_FIELDS.forEach((f) => { if (form.elements[f]) form.elements[f].value = s[f] !== null && s[f] !== undefined ? s[f] : ''; });
  form.dataset.editId = id;
  document.getElementById('speakerFormTitle').textContent = 'Edit guest speaker';
  document.getElementById('speakerSubmitBtn').textContent = 'Update Speaker';
  document.getElementById('speakerCancelEditBtn').style.display = '';
  form.scrollIntoView({ behavior: 'smooth', block: 'start' });
};
document.getElementById('speakerCancelEditBtn').addEventListener('click', () => {
  const form = document.getElementById('speakerForm');
  form.reset(); delete form.dataset.editId;
  document.getElementById('speakerFormTitle').textContent = 'Add guest speaker';
  document.getElementById('speakerSubmitBtn').textContent = 'Save Speaker';
  document.getElementById('speakerCancelEditBtn').style.display = 'none';
});
document.getElementById('speakerForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const body = Object.fromEntries(new FormData(form).entries());
  try {
    if (form.dataset.editId) {
      await jput(`${API}/speakers/${form.dataset.editId}`, body);
      delete form.dataset.editId;
      form.reset();
      document.getElementById('speakerFormTitle').textContent = 'Add guest speaker';
      document.getElementById('speakerSubmitBtn').textContent = 'Save Speaker';
      document.getElementById('speakerCancelEditBtn').style.display = 'none';
      toast('Speaker updated');
    } else {
      await jpost(`${API}/speakers`, body);
      form.reset();
      toast('Speaker saved');
    }
    refreshSpeakers();
  } catch (err) { toast(err.message); }
});

// --- Guest Visitors ---
async function refreshGuestVisitors() {
  const rows = await jget(`${API}/guestvisitors`);
  document.getElementById('gvTableBody').innerHTML = rows.map((g) => `
    <tr>
      <td>${g.name}${g.designation ? ' <span class="hint">(' + g.designation + ')</span>' : ''}</td>
      <td>${g.category || '-'}</td>
      <td>${g.organization || '-'}</td>
      <td>${g.visit_date || '-'}</td>
      <td>${g.guest_relation_name || '-'}</td>
      <td>${g.checklist_done}/${g.checklist_total}</td>
      <td><span class="pill ${g.status === 'confirmed' ? 'paid' : g.status === 'cancelled' ? 'pending' : 'not_started'}">${g.status}</span></td>
      <td class="sticky-actions">
        <button class="btn small" onclick="editGv(${g.id})">Edit</button>
        <button class="btn small" onclick="openChecklistModal('guest_visitor', ${g.id})">Offerings</button>
        ${canDelete() ? `<button class="btn danger small" onclick="deleteGv(${g.id})">Delete</button>` : ''}
      </td>
    </tr>
  `).join('') || '<tr><td colspan="8" class="empty">No guest visitors yet</td></tr>';
}
window.deleteGv = async (id) => { await jdel(`${API}/guestvisitors/${id}`); toast('Guest visitor deleted'); refreshGuestVisitors(); };

const GV_FORM_FIELDS = ['name', 'designation', 'organization', 'phone', 'email', 'category', 'visit_date', 'guest_relation_host_member_id', 'status', 'notes'];
window.editGv = async (id) => {
  const g = await jget(`${API}/guestvisitors/${id}`);
  const form = document.getElementById('gvForm');
  GV_FORM_FIELDS.forEach((f) => { if (form.elements[f]) form.elements[f].value = g[f] !== null && g[f] !== undefined ? g[f] : ''; });
  form.dataset.editId = id;
  document.getElementById('gvFormTitle').textContent = 'Edit guest visitor';
  document.getElementById('gvSubmitBtn').textContent = 'Update Guest Visitor';
  document.getElementById('gvCancelEditBtn').style.display = '';
  form.scrollIntoView({ behavior: 'smooth', block: 'start' });
};
document.getElementById('gvCancelEditBtn').addEventListener('click', () => {
  const form = document.getElementById('gvForm');
  form.reset(); delete form.dataset.editId;
  document.getElementById('gvFormTitle').textContent = 'Add guest visitor';
  document.getElementById('gvSubmitBtn').textContent = 'Save Guest Visitor';
  document.getElementById('gvCancelEditBtn').style.display = 'none';
});
document.getElementById('gvForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const body = Object.fromEntries(new FormData(form).entries());
  try {
    if (form.dataset.editId) {
      await jput(`${API}/guestvisitors/${form.dataset.editId}`, body);
      delete form.dataset.editId;
      form.reset();
      document.getElementById('gvFormTitle').textContent = 'Add guest visitor';
      document.getElementById('gvSubmitBtn').textContent = 'Save Guest Visitor';
      document.getElementById('gvCancelEditBtn').style.display = 'none';
      toast('Guest visitor updated');
    } else {
      await jpost(`${API}/guestvisitors`, body);
      form.reset();
      toast('Guest visitor saved');
    }
    refreshGuestVisitors();
  } catch (err) { toast(err.message); }
});

// --- Accommodation: Hotels + Room Assignments ---
async function refreshHotels() {
  const rows = await jget(`${API}/hotels`);
  document.getElementById('hotelTableBody').innerHTML = rows.map((h) => `
    <tr>
      <td><strong>${h.name}</strong></td>
      <td style="white-space:normal;max-width:220px;">${h.address || '-'}</td>
      <td>${h.contact_person || '-'}${h.phone ? ' <span class="hint">' + h.phone + '</span>' : ''}</td>
      <td>${h.occupant_count} occupant(s) / ${h.room_count} room(s)</td>
      <td class="sticky-actions">
        <button class="btn small" onclick="editHotel(${h.id})">Edit</button>
        ${canDelete() ? `<button class="btn danger small" onclick="deleteHotel(${h.id})">Delete</button>` : ''}
      </td>
    </tr>
  `).join('') || '<tr><td colspan="5" class="empty">No hotels yet</td></tr>';

  const opts = rows.map((h) => `<option value="${h.id}">${h.name}</option>`).join('');
  const sel = document.getElementById('roomHotelSelect');
  if (sel) sel.innerHTML = '<option value="">-- select hotel --</option>' + opts;
}
window.deleteHotel = async (id) => { await jdel(`${API}/hotels/${id}`); toast('Hotel removed'); refreshHotels(); refreshRooms(); };

const HOTEL_FORM_FIELDS = ['name', 'address', 'contact_person', 'phone', 'notes'];
window.editHotel = async (id) => {
  const rows = await jget(`${API}/hotels`);
  const h = rows.find((r) => r.id === id);
  if (!h) return;
  const form = document.getElementById('hotelForm');
  HOTEL_FORM_FIELDS.forEach((f) => { if (form.elements[f]) form.elements[f].value = h[f] !== null && h[f] !== undefined ? h[f] : ''; });
  form.dataset.editId = id;
  document.getElementById('hotelFormTitle').textContent = 'Edit hotel';
  document.getElementById('hotelSubmitBtn').textContent = 'Update Hotel';
  document.getElementById('hotelCancelEditBtn').style.display = '';
  form.scrollIntoView({ behavior: 'smooth', block: 'start' });
};
document.getElementById('hotelCancelEditBtn').addEventListener('click', () => {
  const form = document.getElementById('hotelForm');
  form.reset(); delete form.dataset.editId;
  document.getElementById('hotelFormTitle').textContent = 'Add hotel';
  document.getElementById('hotelSubmitBtn').textContent = 'Save Hotel';
  document.getElementById('hotelCancelEditBtn').style.display = 'none';
});
document.getElementById('hotelForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const body = Object.fromEntries(new FormData(form).entries());
  try {
    if (form.dataset.editId) {
      await jput(`${API}/hotels/${form.dataset.editId}`, body);
      delete form.dataset.editId;
      form.reset();
      document.getElementById('hotelFormTitle').textContent = 'Add hotel';
      document.getElementById('hotelSubmitBtn').textContent = 'Save Hotel';
      document.getElementById('hotelCancelEditBtn').style.display = 'none';
      toast('Hotel updated');
    } else {
      await jpost(`${API}/hotels`, body);
      form.reset();
      toast('Hotel saved');
    }
    refreshHotels();
  } catch (err) { toast(err.message); }
});

async function refreshRooms() {
  const rows = await jget(`${API}/rooms`);
  document.getElementById('roomTableBody').innerHTML = rows.map((r) => `
    <tr>
      <td>${r.hotel_name}</td>
      <td>${r.room_number}</td>
      <td style="text-transform:capitalize;">${r.room_type || '-'}</td>
      <td>${r.participant_name ? r.participant_name + ' <span class="hint">(delegate' + (r.participant_code ? ' · ' + r.participant_code : '') + ')</span>' : (r.host_member_name ? r.host_member_name + ' <span class="hint">(host member)</span>' : '-')}</td>
      <td>${r.check_in || '-'}</td>
      <td>${r.check_out || '-'}</td>
      <td>${canDelete() ? `<button class="btn danger small" onclick="deleteRoom(${r.id})">Delete</button>` : ''}</td>
    </tr>
  `).join('') || '<tr><td colspan="7" class="empty">No room assignments yet</td></tr>';
}
window.deleteRoom = async (id) => { await jdel(`${API}/rooms/${id}`); toast('Room assignment removed'); refreshRooms(); refreshHotels(); };

document.getElementById('roomOccupantTypeSelect').addEventListener('change', (e) => {
  const isParticipant = e.target.value === 'participant';
  document.getElementById('roomParticipantSelect').style.display = isParticipant ? '' : 'none';
  document.getElementById('roomHmSelect').style.display = isParticipant ? 'none' : '';
});

document.getElementById('roomForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const body = Object.fromEntries(new FormData(form).entries());
  const occupantType = document.getElementById('roomOccupantTypeSelect').value;
  if (occupantType === 'participant') {
    body.participant_id = document.getElementById('roomParticipantSelect').value || null;
  } else {
    body.host_member_id = document.getElementById('roomHmSelect').value || null;
  }
  try {
    await jpost(`${API}/rooms`, body);
    form.reset();
    toast('Room assignment saved');
    refreshRooms();
    refreshHotels();
  } catch (err) { toast(err.message); }
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

// --- Settings: one-click host club data import (super_admin only) ---
document.getElementById('seedHostDataBtn').addEventListener('click', async () => {
  const btn = document.getElementById('seedHostDataBtn');
  const out = document.getElementById('seedHostDataResult');
  btn.disabled = true;
  btn.textContent = 'Importing...';
  out.textContent = '';
  try {
    const summary = await jpost(`${API}/admin/seed-host-data`, {});
    out.innerHTML = `Host members: ${summary.membersInserted} added, ${summary.membersUpdated} updated.<br>` +
      `Committees: ${summary.committeesCreated} created, ${summary.membershipsCreated} memberships added.<br>` +
      `Itinerary: ${summary.itineraryResult}.`;
    toast('Import complete');
    refreshHostMembers();
    refreshCommittees();
    refreshItinerary();
  } catch (err) {
    out.textContent = 'Import failed: ' + err.message;
    toast(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Import Host Members & Committees Now';
  }
});

document.getElementById('bulkCreateLoginsBtn').addEventListener('click', async () => {
  if (!confirm('Create a login for every host member with a mobile number on file, using that number as username and "pass123" as password? Members who already have a login are skipped.')) return;
  const btn = document.getElementById('bulkCreateLoginsBtn');
  const out = document.getElementById('bulkCreateLoginsResult');
  btn.disabled = true;
  btn.textContent = 'Creating logins...';
  out.textContent = '';
  try {
    const summary = await jpost(`${API}/auth/users/bulk-create-host-logins`, {});
    const lines = [`Created ${summary.created.length} login(s) with password "${summary.default_password}":`];
    summary.created.forEach((c) => lines.push(`  • ${c.name} — username ${c.username}`));
    if (summary.skipped.length) {
      lines.push(`\nSkipped ${summary.skipped.length}:`);
      summary.skipped.forEach((s) => lines.push(`  • ${s.name} — ${s.reason}`));
    }
    out.textContent = lines.join('\n');
    toast(`${summary.created.length} login(s) created`);
    refreshHostMembers();
    refreshUsersAdmin();
  } catch (err) {
    out.textContent = 'Failed: ' + err.message;
    toast(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Create Logins for All Host Members';
  }
});

// --- Settings: user management (super_admin only) ---
function userBadge(status) {
  const cls = status === 'approved' ? 'paid' : status === 'pending' ? 'partial' : 'pending';
  return `<span class="pill ${cls}">${status}</span>`;
}

async function refreshUsersAdmin() {
  if (!CURRENT_USER || CURRENT_USER.role !== 'super_admin') return;
  let users;
  try {
    users = await jget(`${API}/auth/users`);
  } catch (e) {
    return;
  }
  const pending = users.filter((u) => u.status === 'pending');
  document.getElementById('pendingUsersBody').innerHTML = pending.map((u) => `
    <tr>
      <td>${u.username}</td><td>${u.email || '-'}</td>
      <td>${new Date(u.created_at).toLocaleString()}</td>
      <td>
        <button class="btn gold small" onclick="approveUser(${u.id})">Approve</button>
        <button class="btn danger small" onclick="rejectUser(${u.id})">Reject</button>
      </td>
    </tr>
  `).join('') || '<tr><td colspan="4" class="empty">No pending requests</td></tr>';

  document.getElementById('allUsersBody').innerHTML = users.map((u) => `
    <tr>
      <td>${u.username}</td><td>${u.email || '-'}</td><td>${u.role}</td>
      <td>${u.host_member_name || '<span class="hint">-</span>'}</td>
      <td>${userBadge(u.status)}</td>
      <td>${new Date(u.created_at).toLocaleDateString()}</td>
      <td>${u.id === CURRENT_USER.id ? '<span class="hint">(you)</span>' : `<button class="btn danger small" onclick="deleteUser(${u.id})">Delete</button>`}</td>
    </tr>
  `).join('') || '<tr><td colspan="7" class="empty">No logins yet</td></tr>';
}
window.approveUser = async (id) => { await jput(`${API}/auth/users/${id}/approve`, {}); toast('Approved'); refreshUsersAdmin(); };
window.rejectUser = async (id) => { await jput(`${API}/auth/users/${id}/reject`, {}); toast('Rejected'); refreshUsersAdmin(); };
window.deleteUser = async (id) => { if (!confirm('Delete this login?')) return; await jdel(`${API}/auth/users/${id}`); toast('Login removed'); refreshUsersAdmin(); };

// Show/hide + require the host-member picker only when creating a host_member login.
const createUserRoleSelect = document.getElementById('createUserRoleSelect');
const createUserHmField = document.getElementById('createUserHmField');
const createUserHmSelect = document.getElementById('createUserHmSelect');
if (createUserRoleSelect) {
  createUserRoleSelect.addEventListener('change', () => {
    const isHostMember = createUserRoleSelect.value === 'host_member';
    createUserHmField.style.display = isHostMember ? '' : 'none';
    if (createUserHmSelect) createUserHmSelect.required = isHostMember;
  });
}

document.getElementById('createUserForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const body = Object.fromEntries(fd.entries());
  if (body.role !== 'host_member') delete body.host_member_id;
  else if (!body.host_member_id) { toast('Choose which host member this login belongs to.'); return; }
  try {
    await jpost(`${API}/auth/users`, body);
    e.target.reset();
    createUserHmField.style.display = 'none';
    toast('Login created');
    refreshUsersAdmin();
    refreshHostMembers();
  } catch (err) { toast(err.message); }
});

document.getElementById('changePasswordForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  try {
    await jput(`${API}/auth/me/password`, Object.fromEntries(fd.entries()));
    e.target.reset();
    toast('Password updated');
  } catch (err) { toast(err.message); }
});

function refreshStatsDependents() { /* hook for cross-tab refresh if needed */ }

// --- Init ---
function loadAllData() {
  refreshClubs();
  refreshRegs();
  loadNextRegNumber();
  refreshParts();
  refreshMediaAdmin();
  refreshHappeningsAdmin();
  refreshItinerary();
  refreshHostMembers();
  refreshHostPayments();
  refreshCommittees();
  refreshAssignmentDropdowns();
  refreshAssignments();
  refreshTasks();
  refreshChecklistTemplates();
  refreshPartners();
  refreshDrivers();
  refreshVehicles();
  loadNextVehicleCode();
  refreshTransportTrips();
  refreshPreTours();
  refreshHotels();
  refreshRooms();
  refreshSponsors();
  refreshSpeakers();
  refreshGuestVisitors();
  if (CURRENT_USER && CURRENT_USER.role === 'super_admin') refreshUsersAdmin();
}

tryResumeSession();
