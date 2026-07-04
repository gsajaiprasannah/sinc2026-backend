const API = ((window.SINC_CONFIG && window.SINC_CONFIG.API_BASE_URL) || '/api').replace(/\/$/, '');

// Separate token key from admin.js so a host-member login and an admin
// login can coexist in the same browser without clobbering each other.
const TOKEN_KEY = 'sinc_host_token';
let CURRENT_USER = null;

function getToken() { return localStorage.getItem(TOKEN_KEY) || ''; }
function setToken(t) { if (t) localStorage.setItem(TOKEN_KEY, t); else localStorage.removeItem(TOKEN_KEY); }

function authHeaders(extra) {
  const h = Object.assign({}, extra || {});
  const t = getToken();
  if (t) h['Authorization'] = 'Bearer ' + t;
  return h;
}

let toastTimer = null;
function toast(msg, durationMs) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), durationMs || 2200);
}

class UnauthorizedError extends Error {}
function handleUnauthorized() {
  setToken('');
  CURRENT_USER = null;
  showAuthGate();
  toast('Your session expired — please log in again.');
}

async function jget(url) {
  const r = await fetch(url, { headers: authHeaders() });
  if (r.status === 401) { handleUnauthorized(); throw new UnauthorizedError('Please log in again.'); }
  if (!r.ok) {
    const text = await r.text();
    try { throw new Error(JSON.parse(text).error || text); } catch (parseErr) {
      if (parseErr instanceof SyntaxError) throw new Error(text);
      throw parseErr;
    }
  }
  return r.json();
}
async function jput(url, body) {
  const r = await fetch(url, { method: 'PUT', headers: authHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify(body) });
  if (r.status === 401) { handleUnauthorized(); throw new UnauthorizedError('Please log in again.'); }
  const text = await r.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; }
  catch (e) {
    throw new Error(!r.ok
      ? `Server returned HTTP ${r.status} instead of JSON — the backend may not have this endpoint deployed yet.`
      : 'Server returned an unexpected (non-JSON) response.');
  }
  if (!r.ok) { const err = new Error(data.error || `Request failed (HTTP ${r.status})`); err.data = data; err.status = r.status; throw err; }
  return data;
}

// --- Auth ---
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
  document.getElementById('whoami').textContent = CURRENT_USER ? CURRENT_USER.username : '';
  loadMe();
}

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
    if (data.user.role !== 'host_member') {
      throw new Error('This login is not a host member account. Admins should use admin.html instead.');
    }
    setToken(data.token);
    CURRENT_USER = data.user;
    e.target.reset();
    showApp();
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
    if (user.role !== 'host_member') { handleUnauthorized(); return; }
    CURRENT_USER = user;
    showApp();
  } catch (e) {
    showAuthGate();
  }
}

// --- Main data load ---
const STATUS_LABEL = { not_started: 'Not started', in_progress: 'In progress', completed: 'Completed', pending: 'Pending', done: 'Done' };

async function loadMe() {
  let data;
  try {
    data = await jget(`${API}/host/me`);
  } catch (err) {
    if (err instanceof UnauthorizedError) return;
    document.getElementById('profileBody').innerHTML = `<p class="hint" style="color:var(--red);">${err.message}</p>`;
    return;
  }
  renderProfile(data.profile);
  renderPayment(data.profile);
  renderCommittees(data.committeeTasks || []);
  renderCommitteeChecklists(data.committeeChecklists);
  renderAssignments(data.assignments);
  renderTasks(data.tasks);
  renderGuestRelations(data.guestRelations);
  renderGoodiesChecklist(data.goodiesChecklist);
}

function renderProfile(p) {
  document.getElementById('profileBody').innerHTML = `
    <p><strong>${p.name}</strong>${p.designation ? ' — ' + p.designation : ''}</p>
    <p class="hint">${[p.company, p.category].filter(Boolean).join(' · ') || '-'}</p>
    <p class="hint">${[p.phone, p.email].filter(Boolean).join(' · ') || '-'}</p>
  `;
}

function renderPayment(p) {
  document.getElementById('paymentBody').innerHTML = `
    <p><span class="pill ${p.payment_status}">${p.payment_status}</span> &nbsp; ₹${p.payment_amount}</p>
    <p class="hint">${p.payment_mode ? 'Paid via ' + p.payment_mode : 'No payment mode on file yet'}${p.payment_date ? ' on ' + new Date(p.payment_date).toLocaleDateString() : ''}</p>
    <p class="hint">Contact the admin team if this doesn't look right — payment records are managed from the admin panel.</p>
  `;
}

function renderCommittees(committees) {
  document.getElementById('myCommitteesBody').innerHTML = (committees || []).map((c) => `
    <div style="margin-bottom:14px;padding-bottom:12px;border-bottom:1px solid var(--line);">
      <p style="margin:0 0 4px;"><strong>${c.name}</strong></p>
      ${c.description ? `<p class="hint" style="margin:0 0 8px;white-space:pre-wrap;">${c.description}</p>` : ''}
      ${(c.tasks && c.tasks.length) ? c.tasks.map((t) => `
        <div class="checklist-row status-${t.my_status || 'pending'}">
          <select onchange="updateMyCommitteeTaskStatus(${t.completion_id}, this.value)">
            <option value="pending" ${t.my_status === 'pending' ? 'selected' : ''}>Pending</option>
            <option value="done" ${t.my_status === 'done' ? 'selected' : ''}>Done</option>
          </select>
          <span class="checklist-label">
            ${Number(t.is_milestone) ? '<span class="pill double" style="margin-right:4px;">Milestone</span>' : ''}${t.title}${t.due_date ? ' <span class="hint">(due ' + t.due_date + ')</span>' : ''}
          </span>
          <span class="hint">${t.done_count}/${t.total_members} members done</span>
        </div>
      `).join('') : '<p class="hint">No checklist items or milestones posted for this committee yet.</p>'}
    </div>
  `).join('') || '<p class="hint">You are not yet assigned to a committee.</p>';
}
window.updateMyCommitteeTaskStatus = async (completionId, status) => {
  try { await jput(`${API}/host/committee-tasks/${completionId}`, { status }); toast('Status updated'); loadMe(); }
  catch (err) { if (!(err instanceof UnauthorizedError)) toast(err.message); }
};

function renderAssignments(rows) {
  document.getElementById('myAssignmentsBody').innerHTML = (rows || []).map((a) => `
    <tr>
      <td>${a.participant_name}<br><span class="hint">${a.participant_code || ''}</span></td>
      <td>${a.club_name || '-'}<br><span class="hint">${a.reg_number || ''}</span></td>
      <td>${a.role ? `<span class="pill ${String(a.role).toLowerCase() === 'spoc' ? 'double' : 'single'}">${a.role}</span>` : '<span class="hint">-</span>'}</td>
      <td>${a.travel_mode ? a.travel_mode + (a.travel_number ? ' · ' + a.travel_number : '') : '-'}${a.arrival_point ? '<br><span class="hint">' + a.arrival_point + '</span>' : ''}</td>
      <td>
        <select onchange="updateAssignmentStatus(${a.id}, this.value)">
          <option value="not_started" ${a.status === 'not_started' ? 'selected' : ''}>Not started</option>
          <option value="in_progress" ${a.status === 'in_progress' ? 'selected' : ''}>In progress</option>
          <option value="completed" ${a.status === 'completed' ? 'selected' : ''}>Completed</option>
        </select>
      </td>
      <td><input type="text" value="${(a.notes || '').replace(/"/g, '&quot;')}" onchange="updateAssignmentNotes(${a.id}, this.value)" placeholder="Add a note..." /></td>
    </tr>
  `).join('') || '<tr><td colspan="6" class="empty">No delegates assigned to you yet</td></tr>';
}
window.updateAssignmentStatus = async (id, status) => {
  try { await jput(`${API}/host/assignments/${id}`, { status }); toast('Status updated'); }
  catch (err) { if (!(err instanceof UnauthorizedError)) toast(err.message); }
};
window.updateAssignmentNotes = async (id, notes) => {
  try { await jput(`${API}/host/assignments/${id}`, { notes }); toast('Note saved'); }
  catch (err) { if (!(err instanceof UnauthorizedError)) toast(err.message); }
};

function renderTasks(rows) {
  document.getElementById('myTasksBody').innerHTML = (rows || []).map((t) => `
    <tr>
      <td>${t.title}${t.description ? '<br><span class="hint">' + t.description + '</span>' : ''}</td>
      <td>${Number(t.is_milestone) ? '<span class="pill double">Milestone</span>' : '<span class="hint">Checklist</span>'}</td>
      <td>${t.due_date ? new Date(t.due_date).toLocaleDateString() : '-'}</td>
      <td>
        <select onchange="updateTaskStatus(${t.id}, this.value)">
          <option value="pending" ${t.status === 'pending' ? 'selected' : ''}>Pending</option>
          <option value="in_progress" ${t.status === 'in_progress' ? 'selected' : ''}>In progress</option>
          <option value="done" ${t.status === 'done' ? 'selected' : ''}>Done</option>
        </select>
      </td>
    </tr>
  `).join('') || '<tr><td colspan="4" class="empty">No checklist items yet</td></tr>';
}
window.updateTaskStatus = async (id, status) => {
  try { await jput(`${API}/host/tasks/${id}`, { status }); toast('Status updated'); }
  catch (err) { if (!(err instanceof UnauthorizedError)) toast(err.message); }
};

// --- Sponsors I'm the Guest Relation contact for (with their benefit checklist) ---
// opts.showOwner also displays whose item it is (used by the committee
// delivery checklist below, where one committee's list spans many different
// delegates/sponsors/etc.).
function checklistRowsHtml(items, opts) {
  opts = opts || {};
  return (items || []).map((it) => {
    const overdue = it.status !== 'done' && it.due_date && it.due_date.slice(0, 10) < new Date().toISOString().slice(0, 10);
    return `
    <div class="checklist-row status-${it.status}${overdue ? ' row-overdue' : ''}">
      <select onchange="updateHostChecklistStatus(${it.id}, this.value)">
        <option value="pending" ${it.status === 'pending' ? 'selected' : ''}>Pending</option>
        <option value="in_progress" ${it.status === 'in_progress' ? 'selected' : ''}>In progress</option>
        <option value="done" ${it.status === 'done' ? 'selected' : ''}>Done</option>
      </select>
      <span class="checklist-label">
        ${opts.showOwner && it.owner_name ? `<span class="pill single" style="margin-right:6px;">${it.owner_name}</span>` : ''}${it.label}${it.due_date ? ` <span class="hint">(due ${it.due_date.slice(0, 10)})</span>` : ''}
      </span>
      ${overdue ? '<span class="pill overdue">Overdue</span>' : ''}
    </div>
  `;
  }).join('') || '<p class="hint">Nothing on this checklist yet.</p>';
}

// --- What my committee(s) need to deliver, across every category ---
function renderCommitteeChecklists(groups) {
  const card = document.getElementById('committeeChecklistCard');
  if (!groups || !groups.length) { card.style.display = 'none'; return; }
  card.style.display = '';
  document.getElementById('committeeChecklistBody').innerHTML = groups.map((g) => `
    <div style="margin-bottom:14px;padding-bottom:12px;border-bottom:1px solid var(--line);">
      <p style="margin:0 0 6px;"><strong>${g.committee_name}</strong></p>
      ${checklistRowsHtml(g.items, { showOwner: true })}
    </div>
  `).join('');
}

function renderGuestRelations(relations) {
  const card = document.getElementById('sponsorRelationsCard');
  if (!relations || !relations.length) { card.style.display = 'none'; return; }
  card.style.display = '';
  document.getElementById('sponsorRelationsBody').innerHTML = relations.map((r) => `
    <div style="margin-bottom:14px;padding-bottom:12px;border-bottom:1px solid var(--line);">
      <p style="margin:0 0 6px;">
        <span class="pill single" style="margin-right:6px;">${r.kindLabel}</span>
        <strong>${r.name}</strong>${r.subtitle ? ' <span class="hint">(' + r.subtitle + ')</span>' : ''}
      </p>
      ${r.topic ? `<p class="hint" style="margin:0 0 4px;">Topic: ${r.topic}</p>` : ''}
      <p class="hint" style="margin:0 0 8px;">${[r.contact_person, r.phone, r.email].filter(Boolean).join(' · ') || 'No contact details on file'}</p>
      ${checklistRowsHtml(r.checklist)}
    </div>
  `).join('');
}

// --- My kit / souvenir handover checklist ---
function renderGoodiesChecklist(items) {
  document.getElementById('goodiesBody').innerHTML = checklistRowsHtml(items);
}

window.updateHostChecklistStatus = async (id, status) => {
  try { await jput(`${API}/host/checklist/${id}`, { status }); toast('Status updated'); }
  catch (err) { if (!(err instanceof UnauthorizedError)) toast(err.message); }
};

document.getElementById('changePasswordForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  try {
    await jput(`${API}/auth/me/password`, Object.fromEntries(fd.entries()));
    e.target.reset();
    toast('Password updated');
  } catch (err) {
    if (!(err instanceof UnauthorizedError)) toast(err.message);
  }
});

tryResumeSession();
