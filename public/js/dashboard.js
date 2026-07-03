const API = ((window.SINC_CONFIG && window.SINC_CONFIG.API_BASE_URL) || '/api').replace(/\/$/, '');
const MEDIA_ORIGIN = API.replace(/\/api\/?$/, ''); // '' when API is relative, backend origin when API is absolute
const HAS_BACKEND = !!(window.SINC_CONFIG && window.SINC_CONFIG.API_BASE_URL);

function mediaUrl(p) {
  if (!p) return p;
  if (/^https?:\/\//.test(p)) return p;
  return MEDIA_ORIGIN + p;
}

let clubChart, stateChart;
let videoIndex = 0, posterIndex = 0;
let videoTimer = null, posterTimer = null;
let staticDataCache = null;

async function jget(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error('Request failed: ' + url);
  return r.json();
}

async function getStaticData() {
  if (staticDataCache) return staticDataCache;
  staticDataCache = await jget('data/dashboard-data.json');
  return staticDataCache;
}

function fmtMoney(n) {
  return '₹' + Number(n || 0).toLocaleString('en-IN');
}

function renderOverview(s) {
  const cards = [
    { label: 'Total Members (All Clubs)', value: s.totalMembers },
    { label: 'Total Clubs', value: s.totalClubs },
    { label: 'Total Registrations', value: s.totalRegistrations },
    { label: 'Single Registrations', value: s.singleRegs },
    { label: 'Double Registrations', value: s.doubleRegs },
    { label: 'Total Participants (Double = 2)', value: s.totalParticipants },
    { label: 'Amount Collected', value: fmtMoney(s.totalCollected) }
  ];
  document.getElementById('statCards').innerHTML = cards.map((c) => `
    <div class="stat-card">
      <div class="value">${c.value}</div>
      <div class="label">${c.label}</div>
    </div>
  `).join('');
}

function renderClubComparison(rows) {
  const ctx = document.getElementById('clubChart');
  const labels = rows.map((r) => r.name.replace('Skål ', '').replace('Skal ', ''));
  const members = rows.map((r) => r.members_count);
  const regs = rows.map((r) => r.registrations);

  // Horizontal bar chart, sized to the number of clubs, inside a scrollable
  // wrapper (.chart-scroll) — keeps the card a fixed, page-friendly height
  // no matter how many clubs there are, instead of a giant rotated-label bar chart.
  const inner = document.getElementById('clubChartInner');
  const rowHeight = 26;
  inner.style.height = Math.max(rows.length * rowHeight + 30, 200) + 'px';

  if (clubChart) clubChart.destroy();
  clubChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        { label: 'Members', data: members, backgroundColor: '#314691', borderRadius: 3 },
        { label: 'Registrations', data: regs, backgroundColor: '#65A8DE', borderRadius: 3 }
      ]
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: { ticks: { font: { size: 10 } } },
        y: { ticks: { autoSkip: false, font: { size: 10.5 } } }
      },
      plugins: { legend: { position: 'bottom', labels: { font: { size: 11 } } } }
    }
  });

  document.getElementById('clubTableBody').innerHTML = rows.map((r) => `
    <tr>
      <td>${r.name}</td>
      <td>${r.state || '-'}</td>
      <td>${r.members_count}</td>
      <td>${r.registrations}</td>
      <td>${r.participants != null ? r.participants : '-'}</td>
      <td>${fmtMoney(r.collected)}</td>
    </tr>
  `).join('') || '<tr><td colspan="6" class="empty">No club data yet</td></tr>';
}

function renderNationwide(rows) {
  const ctx = document.getElementById('stateChart');
  if (stateChart) stateChart.destroy();
  stateChart = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: rows.map((r) => r.state || 'Unspecified'),
      datasets: [{
        data: rows.map((r) => r.members),
        backgroundColor: ['#314691', '#65A8DE', '#60CDD2', '#C65AD8', '#EDD945', '#70DBF3', '#59595B', '#8cc0e8', '#263875', '#dc2626']
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { position: 'bottom', labels: { font: { size: 10 }, boxWidth: 10 } } }
    }
  });
}

function renderDietary(rows) {
  const el = document.getElementById('dietCards');
  if (!el) return;
  if (!rows || !rows.length) {
    el.innerHTML = '<div class="empty">No dietary data yet.</div>';
    return;
  }
  const total = rows.reduce((sum, r) => sum + (r.count || 0), 0) || 1;
  const classFor = (label) => (
    label === 'Vegetarian' ? 'diet-veg' : label === 'Non-vegetarian' ? 'diet-nonveg' : 'diet-none'
  );
  el.innerHTML = rows.map((r) => `
    <div class="stat-card ${classFor(r.label)}">
      <div class="value">${r.count}</div>
      <div class="label">${r.label} (${Math.round((r.count / total) * 100)}%)</div>
    </div>
  `).join('');
}

function renderHappenings(rows) {
  const el = document.getElementById('happeningsFeed');
  if (!rows.length) {
    el.innerHTML = '<div class="empty">No updates posted yet.</div>';
    return;
  }
  el.innerHTML = rows.map((h) => `
    <div class="feed-item">
      <div class="time">${new Date(h.happened_at.replace(' ', 'T') + 'Z').toLocaleString()}</div>
      <div class="title">${h.title}</div>
      <div class="desc">${h.description || ''}</div>
    </div>
  `).join('');
}

function setupLoop(containerId, items, kind) {
  const el = document.getElementById(containerId);
  if (videoTimer && kind === 'video') clearTimeout(videoTimer);
  if (posterTimer && kind === 'poster') clearTimeout(posterTimer);

  if (!items || items.length === 0) {
    el.innerHTML = `<div class="empty" style="padding:40px 0;${kind === 'video' ? 'color:#fff;' : ''}">No ${kind}s uploaded yet — add some from Admin → Media.</div>`;
    return;
  }

  let idx = kind === 'video' ? videoIndex % items.length : posterIndex % items.length;

  function render() {
    const item = items[idx];
    const mediaTag = kind === 'video'
      ? `<video src="${mediaUrl(item.filename)}" autoplay muted playsinline></video>`
      : `<img src="${mediaUrl(item.filename)}" alt="${item.title || ''}" />`;
    el.innerHTML = `
      ${mediaTag}
      <div class="media-caption">${item.title || ''}</div>
      <div class="media-dots">${items.map((_, i) => `<span class="${i === idx ? 'active' : ''}"></span>`).join('')}</div>
    `;
    if (kind === 'video') {
      const v = el.querySelector('video');
      v.onended = advance;
    } else {
      posterTimer = setTimeout(advance, 6000);
    }
  }

  function advance() {
    idx = (idx + 1) % items.length;
    if (kind === 'video') videoIndex = idx; else posterIndex = idx;
    render();
  }

  render();
}

async function refreshStats() {
  if (HAS_BACKEND) {
    try {
      const [s, clubRows, nationRows, happenRows] = await Promise.all([
        jget(`${API}/stats/overview`),
        jget(`${API}/stats/club-comparison`),
        jget(`${API}/stats/nationwide`),
        jget(`${API}/happenings?limit=30`)
      ]);
      renderOverview(s);
      renderClubComparison(clubRows);
      renderNationwide(nationRows);
      renderHappenings(happenRows);
      // Dietary breakdown is optional/newer — fetch separately so an older
      // backend without this endpoint doesn't break the rest of the dashboard.
      try {
        renderDietary(await jget(`${API}/stats/dietary`));
      } catch (e) {
        console.error('Dietary stats unavailable', e);
      }
      return;
    } catch (e) {
      console.error('Backend fetch failed, falling back to static data', e);
    }
  }
  try {
    const data = await getStaticData();
    renderOverview(data.overview);
    renderClubComparison(data.clubComparison);
    renderNationwide(data.nationwide);
    renderHappenings(data.happenings || []);
    renderDietary(data.dietary || []);
  } catch (e) {
    console.error(e);
  }
}

async function refreshMedia() {
  if (!HAS_BACKEND) {
    setupLoop('videoLoop', [], 'video');
    setupLoop('posterLoop', [], 'poster');
    return;
  }
  try {
    const videos = await jget(`${API}/media?type=video`);
    const posters = await jget(`${API}/media?type=poster`);
    setupLoop('videoLoop', videos.filter((v) => v.active), 'video');
    setupLoop('posterLoop', posters.filter((p) => p.active), 'poster');
  } catch (e) {
    console.error(e);
  }
}

refreshStats();
refreshMedia();
setInterval(refreshStats, 30000);
setInterval(refreshMedia, 5 * 60000); // re-check for newly uploaded media every 5 min without disrupting playback
