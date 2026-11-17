// Dashboard controller: state, data loading and rendering of all panels.

import { fetchCatalog, fetchDataset, fetchGeo } from './api.js';
import { fmtCompactParts, fmtDelta, fmtNumber, fmtValue, periodLabel, shortName, timeLabel, dateLabel } from './format.js';
import { initTheme, tokens } from './theme.js';
import { lineOption, mapOption, quantileScale, rankOption } from './charts.js';

const $ = (sel) => document.querySelector(sel);

function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (k in node) node[k] = v;
    else node.setAttribute(k, v);
  }
  node.append(...children.filter((c) => c !== null && c !== undefined));
  return node;
}

/** How far back the "long" comparison goes, per frequency. */
const LONG_OFFSET = { år: 10, kvartal: 4, månad: 12 };
/** Counts that add up across regions: comparing Sverige with a kommun on one axis is meaningless. */
const ADDITIVE_UNITS = new Set(['invånare', 'lägenheter']);

const state = {
  catalog: [],
  data: {},
  errors: {},
  selected: null,
  lan: null,
  kommun: null,
  period: {}, // dataset id -> period index
  lineMode: 'values',
  rankView: 'chart',
  legend: {}, // dataset id -> {seriesName: visible}
  zoom: {}, // dataset id -> [start, end]
};

const geo = { lan: null, kommuner: null, registered: new Set(), aspect: {} };
const charts = {};
let rankRows = [];

// ---------------------------------------------------------------------------
// URL hash: #dataset/lan/kommun so a reload keeps the view
// ---------------------------------------------------------------------------

function readHash() {
  const [id, lan, kommun] = decodeURIComponent(location.hash.slice(1)).split('/');
  state.selected = id || null;
  state.lan = /^\d{2}$/.test(lan ?? '') ? lan : null;
  state.kommun = /^\d{4}$/.test(kommun ?? '') ? kommun : null;
}

function writeHash() {
  const parts = [state.selected, state.lan, state.kommun].filter(Boolean);
  history.replaceState(null, '', `#${parts.join('/')}`);
}

// ---------------------------------------------------------------------------
// Data helpers
// ---------------------------------------------------------------------------

const current = () => state.data[state.selected];
const metaOf = (id) => state.catalog.find((d) => d.id === id);

function byCode(ds) {
  ds._byCode ??= Object.fromEntries(ds.regions.map((r) => [r.code, r]));
  return ds._byCode;
}

function periodIndex(ds) {
  const i = state.period[ds.id];
  return i == null || i >= ds.periods.length ? ds.periods.length - 1 : i;
}

function lastValue(values) {
  for (let i = values.length - 1; i >= 0; i--) if (Number.isFinite(values[i])) return { value: values[i], index: i };
  return { value: null, index: -1 };
}

function headlineSeries(ds) {
  // Regional: Sverige. National: the first series (e.g. "Totalt", "Årsförändring").
  return ds.kind === 'regional' ? ds.series['00'] : ds.series[ds.seriesInfo[0].key];
}

function toIndex(values) {
  const base = values.find(Number.isFinite);
  return values.map((v) => (Number.isFinite(v) && base ? (v / base) * 100 : null));
}

/** Keep the selection valid for the dataset being shown. */
function normalizeSelection(ds) {
  if (ds.kind === 'national') return;
  const codes = byCode(ds);
  if (state.lan && !codes[state.lan]) state.lan = null;
  if (state.kommun && (!codes[state.kommun] || ds.level !== 'kommun' || codes[state.kommun].parent !== state.lan)) {
    state.kommun = null;
  }
}

function peerRegions(ds) {
  if (ds.level === 'kommun' && state.lan) return ds.regions.filter((r) => r.level === 'kommun' && r.parent === state.lan);
  return ds.regions.filter((r) => r.level === 'lan');
}

function nationalVisible(ds) {
  const sel = state.legend[ds.id];
  return ds.seriesInfo.filter((s) => (sel ? sel[s.label] !== false : s.default));
}

// ---------------------------------------------------------------------------
// Geo
// ---------------------------------------------------------------------------

function latitudeAspect(features) {
  let min = 90;
  let max = -90;
  const walk = (c) => {
    if (typeof c[0] === 'number') {
      min = Math.min(min, c[1]);
      max = Math.max(max, c[1]);
    } else c.forEach(walk);
  };
  features.forEach((f) => walk(f.geometry.coordinates));
  return Math.cos((((min + max) / 2) * Math.PI) / 180);
}

function registerMap(name, features) {
  if (geo.registered.has(name)) return;
  echarts.registerMap(name, { type: 'FeatureCollection', features });
  geo.aspect[name] = latitudeAspect(features);
  geo.registered.add(name);
}

function mapFor(ds) {
  if (ds.level === 'kommun' && state.lan) {
    const name = `kommuner-${state.lan}`;
    const features = geo.kommuner.features.filter((f) => f.properties.code.startsWith(state.lan));
    registerMap(name, features);
    return { name, codes: features.map((f) => f.properties.code), kommunView: true };
  }
  return { name: 'lan', codes: geo.lan.features.map((f) => f.properties.code), kommunView: false };
}

// ---------------------------------------------------------------------------
// Charts (lazy init + events)
// ---------------------------------------------------------------------------

function chart(id) {
  if (charts[id]) return charts[id];
  const node = document.getElementById(id);
  const c = echarts.init(node);
  new ResizeObserver(() => c.resize()).observe(node);
  charts[id] = c;

  if (id === 'map') c.on('click', (p) => selectRegion(p.name));
  if (id === 'rank') c.on('click', (p) => rankRows[p.dataIndex] && selectRegion(rankRows[p.dataIndex].code));
  if (id === 'line') {
    c.getZr().on('click', (e) => {
      const ds = current();
      if (!ds || !c.containPixel('grid', [e.offsetX, e.offsetY])) return;
      const [x] = c.convertFromPixel('grid', [e.offsetX, e.offsetY]);
      const idx = Math.max(0, Math.min(ds.periods.length - 1, Math.round(x)));
      setPeriod(idx);
    });
    c.on('datazoom', () => {
      const dz = c.getOption().dataZoom?.[0];
      if (dz && state.selected) state.zoom[state.selected] = [dz.start, dz.end];
    });
    c.on('legendselectchanged', (e) => {
      const ds = current();
      if (!ds) return;
      state.legend[ds.id] = { ...e.selected };
      renderStats(ds);
      if (ds.kind === 'national') renderNationalTable(ds);
    });
  }
  return c;
}

// ---------------------------------------------------------------------------
// Interaction
// ---------------------------------------------------------------------------

function selectDataset(id) {
  if (state.selected === id) return;
  state.selected = id;
  render();
}

function selectRegion(code) {
  const ds = current();
  if (!ds || ds.kind !== 'regional') return;
  const r = byCode(ds)[code];
  if (!r) return;
  if (r.level === 'riket') {
    state.lan = null;
    state.kommun = null;
  } else if (r.level === 'lan') {
    const toggleOff = state.lan === code && ds.level === 'lan';
    state.lan = toggleOff ? null : code;
    state.kommun = null;
  } else {
    state.lan = r.parent;
    state.kommun = state.kommun === code ? null : code;
  }
  render();
}

let periodFrame = 0;
function setPeriod(idx) {
  const ds = current();
  if (!ds) return;
  state.period[ds.id] = idx;
  cancelAnimationFrame(periodFrame);
  periodFrame = requestAnimationFrame(render);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderTabs() {
  const nav = $('#tabs');
  if (!nav.children.length) {
    for (const meta of state.catalog) {
      nav.append(
        h(
          'button',
          { class: 'tab', type: 'button', role: 'tab', id: `tab-${meta.id}`, onclick: () => selectDataset(meta.id) },
          h('span', { class: 'tab-title' }, meta.shortTitle),
          h('span', { class: 'tab-value' }, '…'),
          h('span', { class: 'tab-sub' }, 'Hämtar…'),
        ),
      );
    }
  }
  for (const meta of state.catalog) {
    const btn = document.getElementById(`tab-${meta.id}`);
    const ds = state.data[meta.id];
    const err = state.errors[meta.id];
    btn.setAttribute('aria-selected', String(meta.id === state.selected));
    btn.classList.toggle('is-loading', !ds && !err);
    btn.classList.toggle('is-error', Boolean(err));
    const [, value, sub] = btn.children;
    if (ds) {
      const { value: v, index } = lastValue(headlineSeries(ds));
      const parts = fmtCompactParts(v, ds);
      value.replaceChildren(parts.num, ' ', h('span', { class: 'tab-unit' }, parts.unit));
      const where = ds.kind === 'regional' ? 'Sverige' : ds.seriesInfo[0].label;
      sub.textContent = `${where} · ${periodLabel(ds.periods[index])}`;
    } else if (err) {
      value.textContent = 'Kunde inte hämtas';
      sub.textContent = 'Klicka för att försöka igen';
    }
  }
}

function renderDescription(meta, ds) {
  const desc = $('#desc');
  desc.replaceChildren(meta.description, ' Källa: SCB, ');
  meta.sources.forEach((s, i) => {
    if (i) desc.append(', ');
    desc.append(h('a', { href: s.url, target: '_blank', rel: 'noopener' }, s.table));
  });
  if (ds?.scbUpdated) desc.append(` · senast uppdaterad av SCB ${dateLabel(ds.scbUpdated)}`);
  desc.append('.');
}

function renderPeriodControl(ds) {
  const idx = periodIndex(ds);
  const input = $('#period');
  input.max = String(ds.periods.length - 1);
  input.value = String(idx);
  input.setAttribute('aria-valuetext', periodLabel(ds.periods[idx]));
  $('#period-label').textContent = periodLabel(ds.periods[idx]);
}

function renderBreadcrumb(ds) {
  const nav = $('#breadcrumb');
  nav.replaceChildren();
  if (ds.kind === 'national') {
    nav.append(h('span', { class: 'current' }, 'Sverige'), h('span', { class: 'muted small' }, ' – statistiken finns bara för hela riket'));
    return;
  }
  const codes = byCode(ds);
  const trail = ['00', state.lan, state.kommun].filter(Boolean);
  trail.forEach((code, i) => {
    if (i) nav.append(h('span', { class: 'sep', 'aria-hidden': 'true' }, '›'));
    const name = codes[code]?.name ?? code;
    if (i === trail.length - 1) nav.append(h('span', { class: 'current', 'aria-current': 'location' }, name));
    else nav.append(h('button', { type: 'button', onclick: () => selectRegion(code) }, name));
  });
}

function statTile(label, value, sub, { delta = false } = {}) {
  return h(
    'div',
    { class: 'stat' },
    h('span', { class: 'stat-label' }, label),
    h('span', { class: `stat-value${delta ? ' is-delta' : ''}` }, value),
    sub ? h('span', { class: 'stat-sub' }, sub) : null,
  );
}

function deltaTile(ds, values, i, j, label) {
  if (j < 0 || j === i) return statTile(label, '–', 'Ingen jämförelse tillgänglig', { delta: true });
  const d = fmtDelta(values[i], values[j], ds);
  const arrow = !d ? '' : d.dir === 'up' ? '▲ ' : d.dir === 'down' ? '▼ ' : '■ ';
  return statTile(`Jämfört med ${periodLabel(ds.periods[j])}`, d ? arrow + d.text : '–', label, { delta: true });
}

function renderStats(ds) {
  const box = $('#stats');
  const i = periodIndex(ds);
  const p = ds.periods;
  const longJ = i >= LONG_OFFSET[ds.frequency] ? i - LONG_OFFSET[ds.frequency] : 0;
  const tiles = [];

  if (ds.kind === 'regional') {
    const codes = byCode(ds);
    const focus = state.kommun || state.lan || '00';
    const values = ds.series[focus];
    tiles.push(statTile(codes[focus].name, fmtValue(values[i], ds), periodLabel(p[i])));
    tiles.push(deltaTile(ds, values, i, i - 1, 'Föregående period'));
    tiles.push(deltaTile(ds, values, i, longJ, ds.frequency === 'år' ? 'Längre sikt' : 'Samma period året innan'));

    if (focus === '00') {
      const top = ds.regions
        .filter((r) => r.level === 'lan' && Number.isFinite(ds.series[r.code][i]))
        .sort((a, b) => ds.series[b.code][i] - ds.series[a.code][i])[0];
      tiles.push(statTile('Högst bland länen', top ? shortName(top.name) : '–', top ? fmtValue(ds.series[top.code][i], ds) : ''));
    } else {
      const focusRegion = codes[focus];
      const peers = ds.regions
        .filter((r) => r.level === focusRegion.level && (r.level === 'lan' || r.parent === focusRegion.parent))
        .filter((r) => Number.isFinite(ds.series[r.code][i]))
        .sort((a, b) => ds.series[b.code][i] - ds.series[a.code][i]);
      const pos = peers.findIndex((r) => r.code === focus) + 1;
      const group = focusRegion.level === 'kommun' ? `kommuner i ${codes[focusRegion.parent].name}` : 'län';
      tiles.push(statTile('Placering, högst först', pos ? `${pos} av ${peers.length}` : '–', group));
    }
  } else {
    const primary = nationalVisible(ds)[0] ?? ds.seriesInfo[0];
    const values = ds.series[primary.key];
    tiles.push(statTile(primary.label, fmtValue(values[i], ds), periodLabel(p[i])));
    tiles.push(deltaTile(ds, values, i, i - 1, 'Föregående period'));
    tiles.push(deltaTile(ds, values, i, longJ, 'Samma period året innan'));
    let maxI = 0;
    values.forEach((v, k) => {
      if (Number.isFinite(v) && v > values[maxI]) maxI = k;
    });
    tiles.push(statTile(`Högsta sedan ${periodLabel(p[0])}`, fmtValue(values[maxI], ds), periodLabel(p[maxI])));
  }
  box.replaceChildren(...tiles);
}

function renderMap(ds) {
  const t = tokens();
  const i = periodIndex(ds);
  const codes = byCode(ds);
  const { name, codes: mapCodes, kommunView } = mapFor(ds);
  const valueOf = (code) => ds.series[code]?.[i] ?? null;
  const scale = quantileScale(mapCodes.map(valueOf), t.ramp);
  const selectedCode = kommunView ? state.kommun : state.lan;

  chart('map').setOption(
    mapOption({
      ds,
      mapName: name,
      codes: mapCodes,
      valueOf,
      nameOf: (code) => codes[code]?.name ?? code,
      selectedCode,
      selectedColor: kommunView ? t.series[2] : t.series[1],
      scale,
      aspectScale: geo.aspect[name],
      t,
    }),
    true,
  );

  const where = kommunView ? `kommun i ${codes[state.lan].name}` : 'län';
  $('#map-title').textContent = `${ds.title} per ${where}, ${periodLabel(ds.periods[i])}`;
  $('#map-back').hidden = !state.lan;
  $('#map-hint').textContent =
    ds.level === 'kommun'
      ? kommunView
        ? 'Klicka på en kommun för att jämföra den med länet och riket.'
        : 'Klicka på ett län för att se dess kommuner.'
      : 'Klicka på ett län för att jämföra det med riket. Statistiken finns bara per län.';

  $('#map-legend').replaceChildren(
    h('div', { class: 'swatches', 'aria-hidden': 'true' }, ...t.ramp.map((c) => h('span', { style: `background:${c}` }))),
    h(
      'div',
      { class: 'ends' },
      h('span', {}, `Lägst ${fmtValue(scale.min, ds)}`),
      h('span', {}, 'sju lika stora grupper'),
      h('span', {}, `Högst ${fmtValue(scale.max, ds)}`),
    ),
  );
}

function renderLine(ds) {
  const t = tokens();
  const i = periodIndex(ds);
  // Index mode only makes sense for counts (population, dwellings); rates and prices compare directly.
  const indexable = ds.kind === 'regional' && ADDITIVE_UNITS.has(ds.unit);
  const indexMode = indexable && state.lineMode === 'index';
  let series;
  let legendSelected;

  if (ds.kind === 'regional') {
    const codes = byCode(ds);
    let entries = [{ code: '00', color: t.series[0] }];
    if (state.lan) entries.push({ code: state.lan, color: t.series[1] });
    if (state.kommun) entries.push({ code: state.kommun, color: t.series[2] });
    const additive = ADDITIVE_UNITS.has(ds.unit);
    if (!indexMode && additive) entries = [entries.at(-1)];
    series = entries.map((e) => ({
      name: shortName(codes[e.code].name),
      color: e.color,
      data: indexMode ? toIndex(ds.series[e.code]) : ds.series[e.code],
    }));

    $('#line-title').textContent = indexMode
      ? `${ds.title}, index (${periodLabel(ds.periods[0])} = 100)`
      : `${ds.title} över tid (${ds.unit})`;
    $('#line-hint').textContent =
      !indexMode && additive && (state.lan || state.kommun)
        ? 'Visar vald region. Välj Index för att jämföra utvecklingen med riket.'
        : 'Klicka i diagrammet för att välja period.';
  } else {
    series = ds.seriesInfo.map((s, k) => ({ name: s.label, color: t.series[k % t.series.length], data: ds.series[s.key] }));
    legendSelected = state.legend[ds.id] ?? Object.fromEntries(ds.seriesInfo.map((s) => [s.label, s.default]));
    $('#line-title').textContent = `${ds.title} över tid (${ds.unit})`;
    $('#line-hint').textContent = 'Klicka på serierna ovanför diagrammet för att visa/dölja dem. Klicka i diagrammet för att välja period.';
  }

  for (const btn of document.querySelectorAll('#line-mode button')) {
    btn.setAttribute('aria-pressed', String(btn.dataset.mode === state.lineMode));
  }
  $('#line-mode').hidden = !indexable;

  const n = ds.periods.length;
  const zoom = state.zoom[ds.id] ?? [n > 240 ? 100 - (240 / n) * 100 : 0, 100];

  chart('line').setOption(
    lineOption({
      ds,
      series,
      periodIdx: i,
      indexMode,
      // Direct labels at line ends; on narrow screens the legend alone is clearer.
      endLabels: ds.kind === 'regional' && series.length > 1 && window.innerWidth > 640,
      legendSelected,
      zoom,
      t,
    }),
    true,
  );
}

function renderRank(ds) {
  const t = tokens();
  const i = periodIndex(ds);
  const codes = byCode(ds);
  const kommunView = ds.level === 'kommun' && state.lan;
  const selectedCode = kommunView ? state.kommun : state.lan;
  const selectedColor = kommunView ? t.series[2] : t.series[1];

  rankRows = peerRegions(ds)
    .map((r) => ({ code: r.code, name: shortName(r.name), value: ds.series[r.code][i] }))
    .filter((r) => Number.isFinite(r.value))
    .sort((a, b) => b.value - a.value)
    .map((r) => ({ ...r, selected: r.code === selectedCode, color: r.code === selectedCode ? selectedColor : t.ramp[4] }));

  const riket = ds.series['00'][i];
  const reference = !ADDITIVE_UNITS.has(ds.unit) && Number.isFinite(riket) ? { value: riket, label: `Sverige ${fmtNumber(riket, ds.decimals)}` } : null;

  const where = kommunView ? `kommun i ${codes[state.lan].name}` : 'län';
  $('#rank-title').textContent = `${ds.title} per ${where}, ${periodLabel(ds.periods[i])} – högst först`;
  $('#rank-view').hidden = false;

  const showTable = state.rankView === 'table';
  for (const btn of document.querySelectorAll('#rank-view button')) {
    btn.setAttribute('aria-pressed', String(btn.dataset.view === state.rankView));
  }
  $('#rank').hidden = showTable;
  $('#rank-table').hidden = !showTable;

  if (showTable) {
    renderRankTable(ds, i);
  } else {
    $('#rank').style.height = `${Math.max(160, rankRows.length * 24 + (reference ? 40 : 20))}px`;
    const c = chart('rank');
    c.resize();
    c.setOption(rankOption({ ds, rows: rankRows, reference, t }), true);
  }
}

function renderRankTable(ds, i) {
  const prev = i > 0 ? i - 1 : null;
  const head = h(
    'tr',
    {},
    h('th', {}, '#'),
    h('th', {}, 'Region'),
    h('th', { class: 'num' }, `${periodLabel(ds.periods[i])} (${ds.unit})`),
    h('th', { class: 'num' }, prev != null ? `Förändring mot ${periodLabel(ds.periods[prev])}` : 'Förändring'),
  );
  const row = (code, name, rank, selected) => {
    const values = ds.series[code];
    const d = prev != null ? fmtDelta(values[i], values[prev], ds) : null;
    return h(
      'tr',
      { class: selected ? 'is-selected' : '' },
      h('td', {}, rank),
      h('td', {}, h('button', { type: 'button', onclick: () => selectRegion(code) }, name)),
      h('td', { class: 'num' }, fmtNumber(values[i], ds.decimals)),
      h('td', { class: 'num' }, d ? d.text : '–'),
    );
  };
  const body = h('tbody', {}, row('00', 'Sverige', '', false), ...rankRows.map((r, k) => row(r.code, r.name, String(k + 1), r.selected)));
  $('#rank-table').replaceChildren(h('table', { class: 'data' }, h('thead', {}, head), body));
}

function renderNationalTable(ds) {
  const visible = nationalVisible(ds);
  const i = periodIndex(ds);
  $('#rank-title').textContent = 'Senaste perioderna';
  $('#rank-view').hidden = true;
  $('#rank').hidden = true;
  $('#rank-table').hidden = false;

  const start = Math.max(0, ds.periods.length - 16);
  const idxs = [];
  for (let k = ds.periods.length - 1; k >= start; k--) idxs.push(k);
  if (!idxs.includes(i)) idxs.push(i);

  const head = h('tr', {}, h('th', {}, 'Period'), ...visible.map((s) => h('th', { class: 'num' }, `${s.label} (${ds.unit})`)));
  const rows = idxs.map((k) =>
    h(
      'tr',
      { class: k === i ? 'is-selected' : '' },
      h('td', {}, periodLabel(ds.periods[k])),
      ...visible.map((s) => h('td', { class: 'num' }, fmtNumber(ds.series[s.key][k], ds.decimals))),
    ),
  );
  $('#rank-table').replaceChildren(h('table', { class: 'data' }, h('thead', {}, head), h('tbody', {}, ...rows)));
}

function renderStatus(meta) {
  const status = $('#status');
  const err = state.errors[meta.id];
  status.replaceChildren(
    err ? `Kunde inte hämta "${meta.title}" från SCB: ${err} ` : `Hämtar ${meta.title.toLowerCase()} från SCB…`,
    err ? h('button', { class: 'btn', type: 'button', onclick: () => loadDataset(meta.id) }, 'Försök igen') : null,
  );
}

function render() {
  renderTabs();
  const meta = metaOf(state.selected);
  if (!meta) return;
  const ds = state.data[meta.id];
  renderDescription(meta, ds);

  const ready = Boolean(ds && geo.lan);
  $('#grid').hidden = !ready;
  $('.filters').hidden = !ready;
  $('#status').hidden = ready;
  if (!ready) {
    renderStatus(meta);
    writeHash();
    return;
  }

  normalizeSelection(ds);
  $('#grid').classList.toggle('is-national', ds.kind === 'national');
  renderPeriodControl(ds);
  renderBreadcrumb(ds);
  renderStats(ds);
  if (ds.kind === 'regional') {
    renderMap(ds);
    renderRank(ds);
  } else {
    renderNationalTable(ds);
  }
  renderLine(ds);
  writeHash();
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

function updateFetchedLabel() {
  const done = state.catalog.filter((d) => state.data[d.id] || state.errors[d.id]).length;
  const failed = Object.keys(state.errors).length;
  const label = $('#fetched');
  if (done < state.catalog.length) {
    label.textContent = `Hämtar data från SCB… (${done}/${state.catalog.length})`;
    return;
  }
  const times = Object.values(state.data).map((d) => d.fetchedAt).sort();
  label.textContent = `Live-data från SCB · hämtad kl. ${timeLabel(times.at(-1))}${failed ? ` · ${failed} kunde inte hämtas` : ''}`;
}

async function loadDataset(id) {
  delete state.errors[id];
  if (id === state.selected) render();
  try {
    state.data[id] = await fetchDataset(id);
  } catch (err) {
    state.errors[id] = err.message;
  }
  updateFetchedLabel();
  if (id === state.selected) render();
  else renderTabs();
}

function wireControls() {
  $('#period').addEventListener('input', (e) => setPeriod(Number(e.target.value)));
  $('#map-back').addEventListener('click', () => selectRegion('00'));
  for (const btn of document.querySelectorAll('#line-mode button')) {
    btn.addEventListener('click', () => {
      state.lineMode = btn.dataset.mode;
      const ds = current();
      if (ds) renderLine(ds);
    });
  }
  for (const btn of document.querySelectorAll('#rank-view button')) {
    btn.addEventListener('click', () => {
      state.rankView = btn.dataset.view;
      const ds = current();
      if (ds) renderRank(ds);
    });
  }
  $('#tabs').addEventListener('click', (e) => {
    const tab = e.target.closest('.tab');
    const id = tab?.id.replace('tab-', '');
    if (id && state.errors[id]) loadDataset(id);
  });
  // Arrow keys move between dataset tabs.
  $('#tabs').addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const ids = state.catalog.map((d) => d.id);
    const next = ids[(ids.indexOf(state.selected) + (e.key === 'ArrowRight' ? 1 : ids.length - 1)) % ids.length];
    selectDataset(next);
    document.getElementById(`tab-${next}`).focus();
  });
}

async function boot() {
  readHash();
  initTheme($('#theme-toggle'), render);
  wireControls();

  try {
    const [catalog, lan, kommuner] = await Promise.all([fetchCatalog(), fetchGeo('lan'), fetchGeo('kommuner')]);
    for (const fc of [lan, kommuner]) for (const f of fc.features) f.properties.name = f.properties.code;
    geo.lan = lan;
    geo.kommuner = kommuner;
    registerMap('lan', lan.features);
    state.catalog = catalog;
  } catch (err) {
    $('#status').hidden = false;
    $('#status').textContent = `Kunde inte starta dashboarden: ${err.message}. Kör backend med "uvicorn backend.app.main:app".`;
    $('#grid').hidden = true;
    $('.filters').hidden = true;
    return;
  }

  if (!metaOf(state.selected)) state.selected = state.catalog[0].id;
  render();
  updateFetchedLabel();
  // Fetch everything in parallel; each panel renders as soon as its data arrives.
  state.catalog.forEach((d) => loadDataset(d.id));
}

boot();
