const $ = id => document.getElementById(id);
const state = { lang: 'en', month: null, index: 'NDVI', plot: null, sort: { k: 'plot_id', d: 1 }, q: '' };
let META, GEO, STATS, map, layer, legend;
const D = {}, PLOT_BY_ID = {}, LAYERS = {}, charts = {};
let shownStats = [];

const NUM_STATS = ['mean', 'min', 'max', 'std', 'pixels'];
const num = v => (v === '' || v == null || isNaN(v)) ? null : +v;

const t = (k, v = {}) => {
  let s = (I18N[state.lang][k] ?? I18N.en[k] ?? k);
  for (const x in v) s = s.split('{' + x + '}').join(v[x]);
  return s;
};

// ---------- helpers ----------
const loc = () => ({ en: 'en-IN', hi: 'hi-IN', gu: 'gu-IN' }[state.lang]);
const mLong = k => new Date(+k.slice(0, 4), +k.slice(5) - 1, 1).toLocaleString(loc(), { month: 'long', year: 'numeric' });
const mShort = k => new Date(+k.slice(0, 4), +k.slice(5) - 1, 1).toLocaleString(loc(), { month: 'short' });
const idxMeta = () => META.indices.find(i => i.name === state.index);
const val = (m, idx, pid) => { const r = D[m]?.[idx]?.[pid]; return r ? r.mean : null; };
const fmt = (v, d = 3) => v == null ? '' : (+v).toFixed(d);
const months = () => Object.keys(META.months);
const cssVar = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
function themeCharts() {
  Chart.defaults.color = cssVar('--muted');
  Chart.defaults.borderColor = cssVar('--line');
  Chart.defaults.font.family = 'Inter, "Noto Sans Devanagari", "Noto Sans Gujarati", sans-serif';
}

const STOPS = ['#440154', '#3b528b', '#21908d', '#5dc863', '#fde725'];
const hex = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
function colorAt(x) {
  x = Math.max(0, Math.min(1, x));
  const n = STOPS.length - 1, i = Math.min(n - 1, Math.floor(x * n)), f = x * n - i;
  const a = hex(STOPS[i]), b = hex(STOPS[i + 1]);
  return 'rgb(' + a.map((v, k) => Math.round(v + (b[k] - v) * f)).join(',') + ')';
}
function colorFor(v) {
  if (v == null) return null;
  const r = idxMeta().range;
  return colorAt((v - r[0]) / (r[1] - r[0]));
}

async function csv(url) {
  const txt = await (await fetch(url)).text();
  return Papa.parse(txt, { header: true, skipEmptyLines: true }).data;
}

function download(name, rows, cols) {
  const esc = v => {
    if (v == null) return '';
    v = String(v);
    return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  };
  const text = [cols.join(',')].concat(rows.map(r => cols.map(c => esc(r[c])).join(','))).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['\ufeff' + text], { type: 'text/csv' }));
  a.download = name;
  a.click();
}

function selectPlot(pid, zoom) {
  state.plot = pid;
  renderAll();
  if (zoom && LAYERS[pid]) map.fitBounds(LAYERS[pid].getBounds(), { maxZoom: 19, padding: [40, 40] });
}

function fail(msg) {
  document.body.innerHTML = '<p style="padding:20px;font-family:sans-serif">' + msg + '</p>';
}

// ---------- init ----------
async function init() {
  const missing = [];
  if (typeof L === 'undefined') missing.push('Leaflet (map)');
  if (typeof Chart === 'undefined') missing.push('Chart.js');
  if (typeof Papa === 'undefined') missing.push('PapaParse');
  if (typeof I18N === 'undefined') missing.push('i18n.js file');
  if (missing.length) { fail('Could not load: ' + missing.join(', ') + '. Check internet connection and that i18n.js is in the same folder as index.html.'); return; }

  try {
    [META, GEO, STATS] = await Promise.all([
      fetch('data/meta.json').then(r => r.json()),
      fetch('data/plots.geojson').then(r => r.json()),
      csv('data/zonal_stats.csv')
    ]);
  } catch (e) {
    fail('Data not found. Open the site through http://localhost:8888 or http://localhost:8000 (not by double-click) and check the data folder. Error: ' + e.message);
    return;
  }
  STATS.forEach(r => {
    r.plot_id = +r.plot_id;
    NUM_STATS.forEach(k => r[k] = num(r[k]));
    ((D[r.month] ??= {})[r.index] ??= {})[r.plot_id] = r;
  });
  GEO.features.forEach(f => PLOT_BY_ID[f.properties.plot_id] = f.properties);

  const ms = months();
  state.month = ms[ms.length - 1];

  try { const th = localStorage.getItem('theme'); if (th) document.documentElement.dataset.theme = th; } catch (e) {}

  const groups = {};
  META.indices.forEach(i => (groups[i.group] ??= []).push(i));
  $('index').innerHTML = Object.entries(groups).map(([g, list]) =>
    `<optgroup label="${g}">` + list.map(i => `<option value="${i.name}">${i.label}</option>`).join('') + '</optgroup>').join('');
  $('index').value = state.index;

  $('lang').onchange = e => { state.lang = e.target.value; applyLang(); };
  $('month').onchange = e => { state.month = e.target.value; renderAll(); };
  $('index').onchange = e => { state.index = e.target.value; renderAll(); };
  $('theme').onclick = () => {
    const n = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = n;
    try { localStorage.setItem('theme', n); } catch (e) {}
    renderAll();
  };
  $('calendar').onclick = e => {
    const td = e.target.closest('td[data-p]');
    if (!td) return;
    if (td.dataset.m) { state.month = td.dataset.m; $('month').value = state.month; }
    selectPlot(+td.dataset.p, true);
  };
  $('statsTable').onclick = e => {
    const th = e.target.closest('th[data-k]');
    if (th) {
      const k = th.dataset.k;
      state.sort = { k, d: state.sort.k === k ? -state.sort.d : 1 };
      renderStats();
      return;
    }
    const tr = e.target.closest('tr[data-p]');
    if (tr) selectPlot(+tr.dataset.p, true);
  };
  $('search').oninput = e => { state.q = e.target.value; renderStats(); };
  $('dlStats').onclick = () => download(`zonal_${state.month}_${state.index}.csv`, shownStats,
    ['month', 'plot_id', 'farm', 'type', 'index', 'mean', 'min', 'max', 'std', 'pixels', 'sensor', 'mode']);

  initMap();
  applyLang();
}

function fillMonthSelect() {
  $('month').innerHTML = months().map(m =>
    `<option value="${m}">${mLong(m)}${META.months[m].mode === 'radar_only' ? ' (radar)' : ''}</option>`).join('');
  $('month').value = state.month;
}

function applyLang() {
  document.documentElement.lang = state.lang;
  document.querySelectorAll('[data-i18n]').forEach(e => e.textContent = t(e.dataset.i18n));
  document.querySelectorAll('[data-i18n-ph]').forEach(e => e.placeholder = t(e.dataset.i18nPh));
  fillMonthSelect();
  renderAll();
}

// ---------- analysis ----------
function prevClear(m) {
  const ms = months();
  for (let i = ms.indexOf(m) - 1; i >= 0; i--) if (META.months[ms[i]].mode === 'optical') return ms[i];
  return null;
}
function prevWithData(m, idx) {
  const ms = months();
  for (let i = ms.indexOf(m) - 1; i >= 0; i--) if (avgIdx(ms[i], idx) != null) return ms[i];
  return null;
}
function farmIds() { return GEO.features.map(f => f.properties).filter(p => p.type === 'farm'); }
function avgIdx(m, idx) {
  const v = farmIds().map(p => val(m, idx, p.plot_id)).filter(x => x != null);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}
function calc(m) {
  const info = META.months[m], farms = farmIds();
  const out = { info, optical: info.mode === 'optical', farms: farms.length, places: GEO.features.length - farms.length, wet: 0, dry: 0, high: 0, stress: 0, bare: 0, mid: 0, n: 0, avg: null, pm: null };
  farms.forEach(p => {
    const v = val(m, 'SoilWetness_rel', p.plot_id);
    if (v == null) return;
    if (v >= 0.66) out.wet++; else if (v <= 0.33) out.dry++;
  });
  if (out.optical) {
    out.pm = prevClear(m);
    const rows = farms.map(p => ({ v: val(m, 'NDVI', p.plot_id), pv: out.pm ? val(out.pm, 'NDVI', p.plot_id) : null })).filter(r => r.v != null);
    out.n = rows.length;
    if (rows.length) {
      const sorted = rows.map(r => r.v).sort((a, b) => b - a);
      const cut = sorted[Math.max(0, Math.ceil(rows.length * 0.25) - 1)];
      let sum = 0;
      rows.forEach(r => {
        sum += r.v;
        if (r.v < 0.2) out.bare++;
        else if (r.pv != null && r.pv - r.v >= 0.15) out.stress++;
        else if (r.v >= cut && r.v > 0.5) out.high++;
        else out.mid++;
      });
      out.avg = sum / rows.length;
    }
  }
  return out;
}

// ---------- KPI cards ----------
function kpi(icon, label, value, sub, cls) {
  return `<div class="kpi ${cls || ''}"><div class="ic">${icon}</div><div class="lb">${label}</div><div class="vl">${value}</div><div class="sb">${sub || ''}</div></div>`;
}
function renderKpis() {
  const m = state.month, c = calc(m), im = idxMeta();
  const cur = avgIdx(m, state.index), pm = prevWithData(m, state.index);
  let sub = '';
  if (cur != null && pm) {
    const dlt = cur - avgIdx(pm, state.index);
    sub = `<span class="${dlt >= 0 ? 'up' : 'down'}">${dlt >= 0 ? '▲' : '▼'} ${Math.abs(dlt).toFixed(3)}</span> ${t('k_vs', { prev: mShort(pm) })}`;
  }
  const cards = [kpi('🗺️', t('k_plots'), GEO.features.length, t('k_plots_sub', { f: c.farms, p: c.places }))];
  cards.push(kpi('🌿', `${t('k_avg')} · ${im.name}`, cur == null ? '–' : cur.toFixed(3), sub, 'good'));
  if (c.optical) {
    cards.push(kpi('🌱', t('k_high'), c.high, t('k_of', { n: c.n }), 'good'));
    cards.push(kpi('⚠️', t('k_stress'), c.stress, t('k_of', { n: c.n }), 'warn'));
    cards.push(kpi('🟫', t('k_bare'), c.bare, t('k_of', { n: c.n }), 'sand'));
  } else {
    cards.push(kpi('💧', t('k_wet'), c.wet, t('k_of', { n: c.farms }), 'blue'));
    cards.push(kpi('🏜️', t('k_dry'), c.dry, t('k_of', { n: c.farms }), 'sand'));
  }
  cards.push(kpi('🛰️', t('k_mode'), c.optical ? t('k_mode_opt') : t('k_mode_radar'),
    t('k_imgs', { s2: c.info.s2_images, s1: c.info.s1_images }), 'blue'));
  $('kpis').innerHTML = cards.join('');
}

// ---------- map ----------
function styleFn(f) {
  const p = f.properties;
  const c = colorFor(val(state.month, state.index, p.plot_id));
  const sel = p.plot_id === state.plot;
  return {
    fillColor: c || '#bbbbbb', fillOpacity: c ? 0.82 : 0.35,
    color: sel ? '#ff2d2d' : '#1b1b1b', weight: sel ? 3.5 : 1,
    dashArray: p.type === 'place' ? '4' : null
  };
}

function initMap() {
  map = L.map('map');
  const sat = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19, attribution: 'Esri' });
  const osm = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' });
  sat.addTo(map);
  L.control.layers({ Satellite: sat, Map: osm }).addTo(map);
  layer = L.geoJSON(GEO, {
    style: styleFn,
    onEachFeature: (f, l) => {
      LAYERS[f.properties.plot_id] = l;
      l.on('click', () => selectPlot(f.properties.plot_id, false));
      l.on('mouseover', () => l.setStyle({ weight: 3, color: '#ffeb3b' }));
      l.on('mouseout', () => layer.resetStyle(l));
      l.bindTooltip(() => {
        const p = f.properties, v = val(state.month, state.index, p.plot_id);
        return `<b>${p.farm}</b>: ${v == null ? '-' : v.toFixed(3)}`;
      }, { sticky: true });
    }
  }).addTo(map);
  map.fitBounds(layer.getBounds());
  legend = L.control({ position: 'bottomright' });
  legend.onAdd = () => { const d = L.DomUtil.create('div', 'legend'); d.id = 'legend'; return d; };
  legend.addTo(map);
}

function renderMap() {
  layer.setStyle(styleFn);
  const r = idxMeta().range;
  $('legend').innerHTML = `<b>${idxMeta().label}</b><div class="bar" style="background:linear-gradient(to right,${STOPS.join(',')})"></div><div class="lr"><span>${r[0]}</span><span>${r[1]}</span></div>`;
}

// ---------- calendar ----------
function renderCalendar() {
  const ms = months();
  const plots = GEO.features.map(f => f.properties).sort((a, b) => a.plot_id - b.plot_id);
  let h = '<table class="cal"><thead><tr><th></th>' + ms.map(m => `<th>${mShort(m)}</th>`).join('') + '</tr></thead><tbody>';
  plots.forEach(p => {
    h += `<tr class="${p.type === 'place' ? 'place' : ''} ${p.plot_id === state.plot ? 'selp' : ''}"><td class="lab" data-p="${p.plot_id}">${p.farm}</td>`;
    ms.forEach(m => {
      const v = val(m, state.index, p.plot_id), c = colorFor(v);
      const sel = m === state.month ? ' selm' : '';
      if (v == null) h += `<td class="na${sel}" data-p="${p.plot_id}" data-m="${m}"></td>`;
      else h += `<td class="${sel.trim()}" style="background:${c}" data-p="${p.plot_id}" data-m="${m}" title="${p.farm} ${m}: ${v.toFixed(3)}"></td>`;
    });
    h += '</tr>';
  });
  $('calendar').innerHTML = h + '</tbody></table>';
  const r = idxMeta().range;
  $('calLegend').innerHTML = `<span>${r[0]}</span><div class="bar" style="background:linear-gradient(to right,${STOPS.join(',')})"></div><span>${r[1]}</span><span>· ${idxMeta().label}</span>`;
}

// ---------- stats table ----------
function renderStats() {
  let rows = Object.values(D[state.month]?.[state.index] || {});
  const q = state.q.trim().toLowerCase();
  if (q) rows = rows.filter(r => String(r.farm).toLowerCase().includes(q));
  const { k, d } = state.sort;
  rows.sort((a, b) => {
    const x = a[k], y = b[k];
    if (x == null && y == null) return 0;
    if (x == null) return 1;
    if (y == null) return -1;
    return (x > y ? 1 : x < y ? -1 : 0) * d;
  });
  shownStats = rows;
  if (!rows.length) { $('statsTable').innerHTML = `<p class="note" style="padding:10px">${t('no_data')}</p>`; return; }
  const heads = [['plot_id', 'th_farm'], ['type', 'th_type'], ['mean', 'mean'], ['min', 'min'], ['max', 'max'], ['std', 'std'], ['pixels', 'pixels']];
  let h = '<table><thead><tr>' + heads.map(([k2, lab]) =>
    `<th class="sortable" data-k="${k2}">${t(lab)}${k === k2 ? (d > 0 ? ' ▲' : ' ▼') : ''}</th>`).join('') + '</tr></thead><tbody>';
  rows.forEach(r => {
    const c = colorFor(r.mean);
    h += `<tr data-p="${r.plot_id}" class="${r.plot_id === state.plot ? 'selrow' : ''}"><td>${r.farm}</td><td>${t(r.type)}</td>` +
      `<td>${c ? `<span class="dot" style="background:${c}"></span>` : ''}${fmt(r.mean)}</td>` +
      `<td>${fmt(r.min)}</td><td>${fmt(r.max)}</td><td>${fmt(r.std)}</td><td>${r.pixels ?? ''}</td></tr>`;
  });
  $('statsTable').innerHTML = h + '</tbody></table>';
}

// ---------- summary ----------
function renderSummary() {
  const m = state.month, c = calc(m);
  let text = '';
  if (c.optical) {
    if (!c.n) text = t('no_data');
    else {
      text = t('sum_opt', { month: mLong(m), n: c.n, avg: c.avg.toFixed(2), high: c.high, stress: c.stress, bare: c.bare, mid: c.mid, prev: c.pm ? mLong(c.pm) : '-' });
      if (c.wet + c.dry > 0) text += ' ' + t('sum_wet', { wet: c.wet, dry: c.dry });
    }
  } else {
    text = t('sum_radar', { month: mLong(m), n: c.farms, wet: c.wet, dry: c.dry });
  }
  $('summary').textContent = text;
  const b = $('modeBadge');
  b.textContent = c.optical ? t('mode_opt') : t('mode_radar');
  b.className = 'badge' + (c.optical ? '' : ' radar');
}

// ---------- charts ----------
function killChart(k) { if (charts[k]) { charts[k].destroy(); charts[k] = null; } }

function renderTrend() {
  killChart('trend');
  const ms = months(), im = idxMeta();
  charts.trend = new Chart($('chartTrend'), {
    type: 'line',
    data: {
      labels: ms.map(mShort),
      datasets: [
        { label: `${im.label} (${t('k_avg')})`, data: ms.map(m => avgIdx(m, state.index)), borderColor: '#2e7d32', backgroundColor: 'rgba(46,125,50,.15)', fill: true, tension: 0.3, pointRadius: 4 }
      ]
    },
    options: { maintainAspectRatio: false }
  });
}

function renderPlot() {
  killChart('idx');
  const pid = state.plot;
  if (!pid) { $('plotInfo').innerHTML = `<div class="hint"><div class="big">👆</div>${t('hint')}</div>`; return; }
  const p = PLOT_BY_ID[pid], ms = months(), im = idxMeta(), m = state.month;
  const chips = [];
  const add = (lab, v, d = 2) => { if (v != null) chips.push(`<span class="chip">${lab} <b>${(+v).toFixed(d)}</b></span>`); };
  add('NDVI', val(m, 'NDVI', pid)); add('NDMI', val(m, 'NDMI', pid));
  add(t('c_wet'), val(m, 'SoilWetness_rel', pid)); add('LST °C', val(m, 'LST', pid), 1);
  $('plotInfo').innerHTML = `<div class="plotTitle">${p.farm}</div><div class="sub">${t(p.type)} · ${t('area')}: ${p.area_ha} ha · ${mLong(m)}</div><div class="chips">${chips.join('')}</div>`;
  charts.idx = new Chart($('chartIdx'), {
    type: 'line',
    data: { labels: ms.map(mShort), datasets: [{ label: im.label, data: ms.map(x => val(x, state.index, pid)), spanGaps: false, tension: 0.3, borderColor: '#2e7d32', backgroundColor: 'rgba(46,125,50,.18)', fill: true, pointRadius: 4 }] },
    options: { maintainAspectRatio: false }
  });
}

function renderAll() {
  themeCharts();
  renderKpis(); renderMap(); renderCalendar(); renderStats();
  renderSummary(); renderTrend(); renderPlot();
  if ($('chatPanel') && !$('chatPanel').hidden) chatLabels();
}

// ---------- chatbot ----------
const CHAT = {
  en: { title: 'Farm assistant', ph: 'Ask a farming question...', hello: 'Ask me about crops, soil, irrigation, pests or diseases. Use 📷 to add a photo of a leaf or crop.', wait: 'Thinking...', err: 'Error: ' },
  hi: { title: 'कृषि सहायक', ph: 'खेती से जुड़ा सवाल पूछें...', hello: 'फसल, मिट्टी, सिंचाई, कीट या रोग के बारे में पूछें। पत्ती या फसल की फोटो के लिए 📷 दबाएँ।', wait: 'सोच रहा हूँ...', err: 'त्रुटि: ' },
  gu: { title: 'ખેતી સહાયક', ph: 'ખેતી અંગે પ્રશ્ન પૂછો...', hello: 'પાક, જમીન, સિંચાઈ, જીવાત કે રોગ વિશે પૂછો. પાન કે પાકનો ફોટો માટે 📷 દબાવો.', wait: 'વિચારી રહ્યો છું...', err: 'ભૂલ: ' }
};
const chat = { history: [], image: null, busy: false, greeted: false };
const ct = k => CHAT[state.lang][k];

function chatLabels() {
  $('chatTitle').textContent = '🌾 ' + ct('title');
  $('chatInput').placeholder = ct('ph');
  if (!chat.greeted) { addMsg('bot', ct('hello')); chat.greeted = true; }
}
function addMsg(who, text, imgSrc) {
  const d = document.createElement('div');
  d.className = 'msg ' + who;
  if (imgSrc) { const i = document.createElement('img'); i.src = imgSrc; d.appendChild(i); }
  const s = document.createElement('span'); s.textContent = text; d.appendChild(s);
  $('chatLog').appendChild(d);
  $('chatLog').scrollTop = 1e9;
  return d;
}
function shrinkImage(file) {
  return new Promise((ok, bad) => {
    const img = new Image(), url = URL.createObjectURL(file);
    img.onload = () => {
      const k = Math.min(1, 1024 / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      const url2 = c.toDataURL('image/jpeg', 0.85);
      URL.revokeObjectURL(url);
      ok({ mime: 'image/jpeg', data: url2.split(',')[1], src: url2 });
    };
    img.onerror = bad;
    img.src = url;
  });
}
function chatContext() {
  const m = state.month;
  let s = `Month: ${m}.`;
  if (state.plot) {
    const p = PLOT_BY_ID[state.plot];
    s += ` Selected plot: ${p.farm} (${p.type}, ${p.area_ha} ha).`;
    ['NDVI', 'NDMI', 'SoilWetness_rel', 'LST'].forEach(i => {
      const v = val(m, i, state.plot);
      if (v != null) s += ` ${i}=${(+v).toFixed(2)}.`;
    });
    if (META.months[m].mode !== 'optical') s += ' (cloudy month, radar only)';
  }
  return s;
}
async function sendChat() {
  if (chat.busy) return;
  const text = $('chatInput').value.trim();
  if (!text && !chat.image) return;
  chat.busy = true;
  const img = chat.image;
  addMsg('user', text, img && img.src);
  chat.history.push({ role: 'user', text: text || '(photo)' });
  $('chatInput').value = ''; chat.image = null; $('chatPrev').innerHTML = '';
  const wait = addMsg('bot', ct('wait'));
  try {
    const r = await fetch('/.netlify/functions/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: chat.history, lang: state.lang, context: chatContext(),
        image: img ? { mime: img.mime, data: img.data } : null
      })
    });
    const raw = await r.text();
    let d;
    try { d = JSON.parse(raw); } catch (e2) { throw new Error(r.status + ' ' + raw.slice(0, 120)); }
    if (!r.ok) throw new Error(d.error || r.status);
    wait.querySelector('span').textContent = d.reply;
    chat.history.push({ role: 'model', text: d.reply });
  } catch (e) {
    wait.querySelector('span').textContent = ct('err') + e.message;
    chat.history.pop();
  }
  chat.busy = false;
  $('chatLog').scrollTop = 1e9;
}
$('chatBtn').onclick = () => { $('chatPanel').hidden = !$('chatPanel').hidden; if (!$('chatPanel').hidden) chatLabels(); };
$('chatClose').onclick = () => $('chatPanel').hidden = true;
$('chatSend').onclick = sendChat;
$('chatInput').onkeydown = e => { if (e.key === 'Enter') sendChat(); };
$('chatFile').onchange = async e => {
  const f = e.target.files[0];
  if (!f) return;
  chat.image = await shrinkImage(f);
  $('chatPrev').innerHTML = `<img src="${chat.image.src}">`;
  e.target.value = '';
};

init();