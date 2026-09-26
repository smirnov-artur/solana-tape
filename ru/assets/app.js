/* Solana Tape — RU strings; logic identical to ../../assets/app.js.
   No libraries, no CDN. Charts are hand-drawn on canvas so the ink can carry
   meaning: age fades it, an outlier presses it into the paper in red. */

'use strict';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const NBSP = ' ';
const REDUCED = matchMedia('(prefers-reduced-motion: reduce)');

let DATA = null;
let TRACKS = {};
let Z = 3;
let HERO = 'network_tps';
const CHARTS = [];

/* ── formatting ─────────────────────────────────────────────────────────── */

function group(n, digits = 0) {
  const fixed = Math.abs(n) < 1 && n !== 0 && digits === 0 ? n.toFixed(3) : n.toFixed(digits);
  const [whole, frac] = fixed.split('.');
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, NBSP) + (frac ? ',' + frac : '');
}

function compact(n) {
  const a = Math.abs(n);
  if (a >= 1e12) return (n / 1e12).toFixed(2).replace('.', ',') + ' трлн';
  if (a >= 1e9) return (n / 1e9).toFixed(2).replace('.', ',') + ' млрд';
  if (a >= 1e6) return (n / 1e6).toFixed(2).replace('.', ',') + ' млн';
  if (a >= 1e3) return group(n, 0);
  return group(n, a < 10 ? 2 : 1);
}

function fmt(value, unit) {
  if (value === null || value === undefined) return '—';
  switch (unit) {
    case 'USD': return '$' + compact(value);
    case '%': case '%/yr': return group(value, 2);
    case 'tx/s': return group(value, 1);
    case 'ms': return group(value, 1);
    case 'slot/s': return group(value, 3);
    case 'SOL': return compact(value);
    case 'tx': case 'tx/day': return compact(value);
    case 'state': return String(value);
    default: return typeof value === 'number' ? group(value, Number.isInteger(value) ? 0 : 2)
      : String(value);
  }
}

function ago(seconds) {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return s + ' с назад';
  if (s < 3600) return Math.floor(s / 60) + ' мин назад';
  if (s < 86400) return Math.floor(s / 3600) + ' ч ' + Math.floor((s % 3600) / 60) + ' мин назад';
  return Math.floor(s / 86400) + ' дн назад';
}

function clock(ts) {
  const d = new Date(ts * 1000);
  return d.toISOString().slice(11, 16) + ' UTC';
}

function day(ts) {
  return new Date(ts * 1000).toISOString().slice(0, 10);
}

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

/* ── theme ──────────────────────────────────────────────────────────────── */

let probe = null;
function resolve(token) {
  if (!probe) {
    probe = el('span');
    probe.style.cssText = 'position:absolute;width:0;height:0;visibility:hidden';
    document.body.append(probe);
  }
  probe.style.color = `var(${token})`;
  return getComputedStyle(probe).color;
}

function ink() {
  return {
    ink: resolve('--ink'), old: resolve('--ink-old'), signal: resolve('--signal'),
    rule: resolve('--ink-13'), band: resolve('--ink-08'), paper: resolve('--paper-2'),
    faint: resolve('--ink-42'), cool: resolve('--cool'),
  };
}

function setTheme(mode) {
  document.documentElement.dataset.theme = mode;
  try { localStorage.setItem('tape-theme', mode); } catch (e) { /* private mode */ }
  $$('[data-theme-set]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.themeSet === mode)));
  requestAnimationFrame(redrawAll);
}

/* ── chart engine ───────────────────────────────────────────────────────── */

function niceTicks(min, max, count) {
  const span = (max - min) || Math.abs(max) || 1;
  const raw = span / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm >= 5 ? 10 : norm >= 2 ? 5 : norm >= 1 ? 2 : 1) * mag;
  const out = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 0.01; v += step) out.push(v);
  return out;
}

function drawTrace(canvas, opts) {
  const dpr = Math.min(devicePixelRatio || 1, 2);
  const rect = canvas.getBoundingClientRect();
  const W = Math.max(1, Math.round(rect.width));
  const H = Math.max(1, Math.round(rect.height));
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  const g = canvas.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, H);

  const c = ink();
  const hero = !!opts.hero;
  const padL = hero ? 14 : 8;
  const padR = hero ? 62 : 46;
  const padT = hero ? 26 : 12;
  const padB = hero ? 26 : 16;
  const w = W - padL - padR;
  const h = H - padT - padB;
  if (w <= 4 || h <= 4) return null;

  const t = opts.t, v = opts.v, band = opts.band || [];
  const n = v.length;
  const flags = opts.flags || [];

  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < n; i++) {
    const value = v[i];
    if (typeof value !== 'number') continue;
    if (value < lo) lo = value;
    if (value > hi) hi = value;
    const b = band[i];
    if (b && b.mean !== null && b.sd) {
      lo = Math.min(lo, b.mean - Z * b.sd);
      hi = Math.max(hi, b.mean + Z * b.sd);
    }
  }
  if (!isFinite(lo)) return null;
  if (hi === lo) { hi += 1; lo -= 1; }
  const pad = (hi - lo) * 0.12;
  lo -= pad; hi += pad;

  const X = (i) => padL + (n === 1 ? w / 2 : (i / (n - 1)) * w);
  const Y = (value) => padT + h - ((value - lo) / (hi - lo)) * h;

  g.save();
  g.translate(0.5, 0.5);
  g.strokeStyle = c.band;
  g.lineWidth = 1;
  const ticks = niceTicks(lo, hi, hero ? 5 : 3);
  g.beginPath();
  ticks.forEach((value) => {
    const y = Math.round(Y(value));
    g.moveTo(padL, y); g.lineTo(padL + w, y);
  });
  const vLines = hero ? 8 : 4;
  for (let k = 0; k <= vLines; k++) {
    const x = Math.round(padL + (k / vLines) * w);
    g.moveTo(x, padT); g.lineTo(x, padT + h);
  }
  g.stroke();
  g.restore();

  const hasBand = band.some((b) => b && b.mean !== null);
  if (hasBand) {
    g.beginPath();
    let started = false;
    for (let i = 0; i < n; i++) {
      const b = band[i];
      if (!b || b.mean === null) continue;
      const y = Y(b.mean + Z * b.sd);
      started ? g.lineTo(X(i), y) : (g.moveTo(X(i), y), started = true);
    }
    for (let i = n - 1; i >= 0; i--) {
      const b = band[i];
      if (!b || b.mean === null) continue;
      g.lineTo(X(i), Y(b.mean - Z * b.sd));
    }
    g.closePath();
    g.fillStyle = c.band;
    g.fill();

    g.beginPath();
    let m = false;
    for (let i = 0; i < n; i++) {
      const b = band[i];
      if (!b || b.mean === null) continue;
      const y = Y(b.mean);
      m ? g.lineTo(X(i), y) : (g.moveTo(X(i), y), m = true);
    }
    g.setLineDash([2, 4]);
    g.strokeStyle = c.faint;
    g.lineWidth = 1;
    g.stroke();
    g.setLineDash([]);
  }

  const grad = g.createLinearGradient(padL, 0, padL + w, 0);
  grad.addColorStop(0, c.old);
  grad.addColorStop(0.55, c.old);
  grad.addColorStop(1, c.ink);
  g.strokeStyle = grad;
  g.lineWidth = hero ? 1.4 : 1.15;
  g.lineJoin = 'round';
  g.lineCap = 'round';
  g.beginPath();
  let pen = false;
  for (let i = 0; i < n; i++) {
    if (typeof v[i] !== 'number') { pen = false; continue; }
    const x = X(i), y = Y(v[i]);
    pen ? g.lineTo(x, y) : (g.moveTo(x, y), pen = true);
  }
  g.stroke();

  g.strokeStyle = c.signal;
  g.lineWidth = hero ? 2.4 : 1.9;
  for (let i = 0; i < n; i++) {
    if (!flags[i] || typeof v[i] !== 'number') continue;
    g.beginPath();
    const from = Math.max(0, i - 1);
    if (typeof v[from] === 'number') g.moveTo(X(from), Y(v[from]));
    else g.moveTo(X(i), Y(v[i]));
    g.lineTo(X(i), Y(v[i]));
    const to = Math.min(n - 1, i + 1);
    if (typeof v[to] === 'number') g.lineTo(X(to), Y(v[to]));
    g.stroke();

    g.fillStyle = c.signal;
    g.fillRect(Math.round(X(i)) - 0.5, padT - (hero ? 10 : 7), 1.5, hero ? 7 : 5);
  }

  for (let i = n - 1; i >= 0; i--) {
    if (typeof v[i] !== 'number') continue;
    g.fillStyle = flags[i] ? c.signal : c.ink;
    g.beginPath();
    g.arc(X(i), Y(v[i]), hero ? 3 : 2.2, 0, Math.PI * 2);
    g.fill();
    break;
  }

  g.fillStyle = c.faint;
  g.font = `${hero ? 11 : 10}px PlexMono, ui-monospace, monospace`;
  g.textBaseline = 'middle';
  g.textAlign = 'left';
  ticks.forEach((value) => {
    const y = Y(value);
    if (y < padT - 2 || y > padT + h + 2) return;
    g.fillText(opts.short ? opts.short(value) : fmt(value, opts.unit), padL + w + 7, y);
  });
  if (hero && t && t.length === n) {
    g.textBaseline = 'top';
    const fit = Math.max(2, Math.min(vLines / 2 + 1, Math.floor(w / 78)));
    for (let k = 0; k < fit; k++) {
      const i = Math.min(n - 1, Math.round((k / (fit - 1)) * (n - 1)));
      g.textAlign = k === 0 ? 'left' : k === fit - 1 ? 'right' : 'center';
      g.fillText(clock(t[i]), X(i), padT + h + 7);
    }
  }

  return { X, Y, padL, padT, w, h, n };
}

function register(canvas, build) {
  CHARTS.push({ canvas, build });
  build();
}

function redrawAll() { CHARTS.forEach((c) => c.build()); }

/* ── outliers, recomputed in the browser at the chosen threshold ────────── */

function flagsFor(track, z) {
  const out = new Array(track.v.length).fill(false);
  const hits = [];
  for (let i = 0; i < track.v.length; i++) {
    const b = track.band && track.band[i];
    const value = track.v[i];
    if (!b || b.mean === null || !b.sd || typeof value !== 'number') continue;
    const score = (value - b.mean) / b.sd;
    if (Math.abs(score) >= z) {
      out[i] = true;
      hits.push({ track, i, z: score, value, mean: b.mean, sd: b.sd, at: track.t[i] });
    }
  }
  return { flags: out, hits };
}

function allHits(z) {
  const hits = [];
  Object.values(TRACKS).forEach((track) => { hits.push(...flagsFor(track, z).hits); });
  hits.sort((a, b) => (b.at - a.at) || (Math.abs(b.z) - Math.abs(a.z)));
  return hits;
}

/* ── RU labels: an explicit override wins over the JSON's own (English) label,
   so translation never depends on matching that text exactly ─────────────── */

const LABEL = {
  tps: 'Транзакций/с', non_vote_tps: 'Без голосований/с', slot_time_ms: 'Время слота, мс',
  skipped_slot_rate: 'Пропуск слотов, %', validators_active: 'Активных валидаторов',
  tx_per_day: 'Транзакций в день', health: 'Состояние', slot_rate: 'Скорость слотов',
  leaders_in_window: 'Лидеров в окне', epoch_progress: 'Прогресс эпохи',
  price_usd: 'Цена SOL', market_cap: 'Капитализация', stablecoin_supply: 'Предложение стейблкоинов',
  dex_volume_24h: 'Объём DEX за 24ч', chain_fees_24h: 'Комиссии сети за 24ч',
  median_priority_fee: 'Медианная приоритетная комиссия', supply_circulating: 'В обороте',
  inflation_rate: 'Инфляция', tx_count_total: 'Всего транзакций',
  dex_volume_24h_change: 'Изменение объёма DEX за 24ч', volume_24h: 'Объём за 24ч',
  price_change_24h: 'Изменение цены за 24ч', validators_delinquent: 'Делинквентных валидаторов',
  nakamoto: 'Коэффициент Накамото', staked_share: 'Доля застейканного',
  stake_top10_share: 'Доля топ-10 по стейку', commission_weighted: 'Средняя комиссия',
  slot: 'Абсолютный слот', block_height: 'Высота блока', epoch: 'Эпоха',
  epoch_slot_index: 'Слот в эпохе', epoch_slots: 'Слотов в эпохе',
  p90_priority_fee: 'Комиссия, 90-й перцентиль', base_fee_lamports: 'Базовая комиссия за подпись',
  supply_total: 'Общее предложение', stake_active: 'Активный стейк', stake_delinquent: 'Делинквентный стейк',
  stake_top100_share: 'Доля топ-100 по стейку', commission_median: 'Медианная комиссия',
  client_versions: 'Используемые версии клиентов', tvl_usd: 'TVL в DeFi',
  chain_fees_24h_change: 'Изменение комиссий сети за 24ч',
  network_tps: 'Транзакций/с (сеть)', network_slot_time: 'Время слота (сеть)', network_non_vote_tps: 'Без голосований/с (сеть)',
};

/* ── source/note/endpoint/gap text comes straight from the JSON (machine-generated
   by the Python collector, English) — translate it once here, at ingestion, so every
   renderer downstream (readout note, source popover, source table, log line, chart
   title, gap card) gets RU text without touching each call site. Numbers inside a few
   notes are live (change every cron run): those go through a regex + RU number
   grouping instead of a fixed string, so a refreshed data file keeps translating. */
const numRu = s => group(parseFloat(String(s).replace(/,/g, '')));
const SRC = {
  'Solana protocol constant': 'константа протокола Solana',
  'derived from getVoteAccounts': 'вычислено из getVoteAccounts',
  'derived from getVoteAccounts and getSupply': 'вычислено из getVoteAccounts и getSupply',
  'Solana JSON-RPC stake x Stakewiz version': 'Solana JSON-RPC (стейк) × версия из Stakewiz',
  'measured: difference of getEpochInfo.transactionCount': 'измерено: разность getEpochInfo.transactionCount',
  'own history': 'собственная история',
};
const ENDPOINT_TXT = { 'fixed protocol parameter': 'фиксированный параметр протокола', 'own history': 'собственная история' };
const NOTE_PATTERNS = [
  [/^leader slots ([\d,]+) vs blocks ([\d,]+) over ([\d,]+) slots$/, (a, b, c) => `лидерских слотов ${numRu(a)} против блоков ${numRu(b)} из ${numRu(c)}`],
  [/^median over (\d+) recent slots$/, a => `медиана за ${numRu(a)} последних слотов`],
  [/^([\d,]+) transactions over ([\d.]+) h of collected history$/, (a, b) => `${numRu(a)} транзакций за ${b.replace('.', ',')} ч собранной истории`],
  [/^sample clock derived from getBlockTime on the newest sample stepped back by (\d+) s per sample$/, a => `метка времени — getBlockTime самой новой выборки, дальше шаг ${numRu(a)} с назад на каждую выборку`],
];
const NOTE = {
  'mean over the last 300 s of samples, votes included': 'среднее за последние 300 с выборок, с учётом голосований',
  'consensus votes excluded': 'голоса консенсуса не учитываются',
  'design target 400 ms': 'целевой показатель протокола — 400 мс',
  'not fetched: a protocol constant, stated so it is not mistaken for a reading': 'не запрашивается: константа протокола, показана, чтобы не спутать с показанием',
  'a validator that has not voted in the recent slot window': 'валидатор, не проголосовавший в недавнем окне слотов',
  'fewest validators holding more than 1/3 of active stake': 'наименьшее число валидаторов, держащих более 1/3 активного стейка',
};
function trNote(s) {
  if (!s) return s;
  for (const [re, f] of NOTE_PATTERNS) { const m = re.exec(s); if (m) return f(...m.slice(1)); }
  return NOTE[s] || s;
}
const GAP_LABEL = { daily_active_addresses: 'дневные активные адреса' };
const GAP_REASON = {
  daily_active_addresses: 'ни один публичный эндпоинт не отдаёт это без API-ключа: JSON-RPC-нода не может ' +
    'агрегировать аккаунты по блокам, а индексаторы, которые это умеют (Dune, Flipside, Artemis, Solscan Pro), ' +
    'требуют регистрации ключа. Вместо этого показаны транзакции в день, измеренные по накопительному ончейн-счётчику — как и указано.',
};
function translateData(data) {
  const fix = (o) => {
    if (!o) return;
    if (o.source) o.source = SRC[o.source] || o.source;
    if (o.endpoint) o.endpoint = ENDPOINT_TXT[o.endpoint] || o.endpoint;
    if (o.note) o.note = trNote(o.note);
  };
  Object.values(data.metrics || {}).forEach(fix);
  Object.values(data.external || {}).forEach(fix);
  (data.anomalies || []).forEach(fix);
  (data.gaps || []).forEach((g) => { g.reason = GAP_REASON[g.metric] || g.reason; });
}

/* ── build the page ─────────────────────────────────────────────────────── */

function buildTracks() {
  TRACKS = {};
  Object.entries(DATA.external || {}).forEach(([key, block]) => {
    TRACKS[key] = {
      id: key, label: LABEL[key] || block.label, unit: block.unit, source: block.source,
      endpoint: block.endpoint, step: block.step, note: block.note,
      t: block.t, v: block.v, band: block.band || [],
    };
  });
  const own = DATA.series || {};
  Object.entries(own.keys || {}).forEach(([key, column]) => {
    const meta = DATA.metrics[key] || {};
    if (column.filter((x) => typeof x === 'number').length < 4) return;
    TRACKS['own_' + key] = {
      id: 'own_' + key, label: LABEL[key] || meta.label || key, unit: meta.unit || '',
      source: meta.source || 'own history', endpoint: meta.endpoint || 'data/history',
      step: DATA.run.interval_minutes + ' мин', t: own.t, v: column,
      band: (own.bands || {})[key] || [],
    };
  });
}

function metric(key) { return (DATA.metrics || {})[key] || null; }

function readout(key, opts = {}) {
  const m = metric(key);
  const node = el('div', 'readout');
  node.append(el('span', 'readout__k', opts.label || LABEL[key] || (m && m.label) || key));
  const value = el('span', 'readout__v');
  if (!m || m.value === null) {
    node.classList.add('readout--gap');
    value.textContent = '—';
  } else {
    value.textContent = opts.text ? opts.text(m.value) : fmt(m.value, m.unit);
    if (m.unit && !['state'].includes(m.unit)) {
      value.append(el('span', 'readout__u', opts.unit || m.unit));
    }
  }
  node.append(value);
  const note = (!m || m.value === null) ? (m && m.error) || 'нет источника' : (opts.note || (m && m.note));
  if (note) node.append(el('span', 'readout__n', note));
  if (opts.alert) node.classList.add('readout--alert');
  if (m) attachSource(node, m);
  return node;
}

function attachSource(node, m) {
  node.tabIndex = 0;
  node.dataset.source = '1';
  const show = () => showPopover(node, m);
  node.addEventListener('pointerenter', show);
  node.addEventListener('focus', show);
  node.addEventListener('pointerleave', hidePopover);
  node.addEventListener('blur', hidePopover);
}

let popTimer = null;
function showPopover(anchor, m) {
  const pop = $('#src-popover');
  pop.innerHTML = '';
  const dl = el('dl');
  const add = (k, v) => { dl.append(el('dt', null, k), el('dd', null, v)); };
  add('источник', m.source || '—');
  add('конечная точка', m.endpoint || '—');
  add('снято', m.captured_at || '—');
  if (m.note) add('примечание', m.note);
  if (m.error) add('пробел', m.error);
  pop.append(dl);
  pop.hidden = false;
  const r = anchor.getBoundingClientRect();
  const top = scrollY + r.bottom + 8;
  pop.style.top = top + 'px';
  pop.style.left = Math.max(8, Math.min(scrollX + r.left, scrollX + innerWidth - pop.offsetWidth - 12)) + 'px';
  clearTimeout(popTimer);
}
function hidePopover() {
  clearTimeout(popTimer);
  popTimer = setTimeout(() => { $('#src-popover').hidden = true; }, 120);
}

/* hero */

function renderHero() {
  const track = TRACKS[HERO];
  const canvas = $('#hero-canvas');
  if (!track) { $('#hero-meta').textContent = 'этого ряда нет в последнем снимке'; return; }
  const { flags, hits } = flagsFor(track, Z);

  let map = null;
  const build = () => { map = drawTrace(canvas, { t: track.t, v: track.v, band: track.band,
    flags, unit: track.unit, hero: true }); };
  const existing = CHARTS.find((c) => c.canvas === canvas);
  if (existing) { existing.build = build; build(); } else { register(canvas, build); }

  canvas.setAttribute('aria-label',
    `${track.label} за ${track.v.length} показаний, ${hits.length} аномалий за порогом ${Z} сигма`);
  const span = track.t.length ? (track.t[track.t.length - 1] - track.t[0]) / 3600 : 0;
  $('#hero-meta').textContent =
    `${track.label}, ${track.unit} · ${track.v.length} показаний, раз в ${track.step} ` +
    `· ${span.toFixed(1).replace('.', ',')} ч ленты · ${hits.length} за порогом ${Z.toFixed(1).replace('.', ',')}σ`;
  $('.chart--hero .src').onclick = (e) => {
    e.stopPropagation();
    showPopover(e.target, { source: track.source, endpoint: track.endpoint,
      captured_at: DATA.generated_at, note: track.note });
    clearTimeout(popTimer);
  };

  const read = $('#hero-read');
  let index = -1;
  const point = (clientX) => {
    if (!map) return;
    const r = canvas.getBoundingClientRect();
    const rel = (clientX - r.left - map.padL) / map.w;
    index = Math.max(0, Math.min(track.v.length - 1, Math.round(rel * (track.v.length - 1))));
    paint();
  };
  const paint = () => {
    if (index < 0 || typeof track.v[index] !== 'number') { read.hidden = true; return; }
    read.hidden = false;
    $('#hero-read-v').textContent = fmt(track.v[index], track.unit) + ' ' + track.unit;
    const b = track.band[index];
    const z = b && b.sd ? ((track.v[index] - b.mean) / b.sd).toFixed(2).replace('.', ',') + 'σ' : 'полосы ещё нет';
    $('#hero-read-t').textContent = `${clock(track.t[index])} · ${z}`;
  };
  canvas.onpointermove = (e) => point(e.clientX);
  canvas.onpointerleave = () => { read.hidden = true; index = -1; };
  canvas.tabIndex = 0;
  canvas.onkeydown = (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    if (index < 0) index = track.v.length - 1;
    index = Math.max(0, Math.min(track.v.length - 1, index + (e.key === 'ArrowRight' ? 1 : -1)));
    paint();
  };
}

function renderReadouts() {
  const box = $('#hero-readouts');
  box.innerHTML = '';
  const alerts = new Set(allHits(Z).filter((h) => h.i === h.track.v.length - 1)
    .map((h) => h.track.id));
  [['tps', {}], ['non_vote_tps', {}], ['slot_time_ms', {}], ['skipped_slot_rate', {}],
   ['validators_active', {}], ['tx_per_day', {}]].forEach(([key, opts]) => {
    box.append(readout(key, { ...opts, alert: alerts.has('network_' + key) }));
  });
}

/* epoch */

function renderEpoch() {
  const info = { epoch: metric('epoch'), progress: metric('epoch_progress'),
    index: metric('epoch_slot_index'), total: metric('epoch_slots'),
    slot: metric('slot'), rate: metric('slot_rate'), height: metric('block_height') };
  $('#epoch-no').textContent = info.epoch && info.epoch.value !== null ? info.epoch.value : '—';

  const facts = $('#epoch-facts');
  facts.innerHTML = '';
  const add = (k, value, note) => {
    const wrap = el('div');
    wrap.append(el('dt', null, k));
    const dd = el('dd', null, value);
    if (note) dd.append(el('small', null, note));
    wrap.append(dd);
    facts.append(wrap);
  };
  const rate = info.rate && info.rate.value ? info.rate.value : null;
  const base = info.index && info.index.value !== null ? info.index.value : null;
  const total = info.total && info.total.value ? info.total.value : null;
  const captured = Date.parse(DATA.generated_at) / 1000;

  add('Слот', info.slot && info.slot.value !== null ? group(info.slot.value) : '—',
    'получено из getEpochInfo');
  add('Высота блока', info.height && info.height.value !== null ? group(info.height.value) : '—');
  add('Слотов осталось', base !== null && total ? group(total - base) : '—',
    rate ? `осталось примерно ${((total - base) / rate / 3600).toFixed(1).replace('.', ',')} ч при текущей скорости` : null);
  add('Измеренная скорость слотов', rate ? group(rate, 3) + ' слот/с' : '—',
    'из getRecentPerformanceSamples');

  const measured = $('#epoch-measured');
  const projected = $('#epoch-projected');
  const pen = $('#epoch-pen');
  if (base === null || !total) { measured.style.width = '0'; return; }
  const measuredPct = (base / total) * 100;
  measured.style.width = measuredPct + '%';
  $('#epoch-bar').setAttribute('aria-label',
    `Эпоха ${info.epoch ? info.epoch.value : ''}, ${measuredPct.toFixed(2).replace('.', ',')}% пройдено на момент замера`);

  const tick = () => {
    const elapsed = Date.now() / 1000 - captured;
    const projectedSlots = rate ? Math.min(total, base + elapsed * rate) : base;
    const pct = (projectedSlots / total) * 100;
    projected.style.width = pct + '%';
    pen.style.left = pct + '%';
  };
  tick();
  if (!REDUCED.matches && rate) setInterval(tick, 400);
}

/* margin notes */

function renderLog() {
  const list = $('#anomaly-list');
  list.innerHTML = '';
  const hits = allHits(Z).slice(0, 12);
  if (!hits.length) {
    const li = el('li', 'log__empty',
      `За порогом ${Z.toFixed(1).replace('.', ',')}σ в собранном окне ничего нет. Снизьте порог, ` +
      'чтобы увидеть близкие случаи, или зайдите после следующего запуска.');
    list.append(li);
    return;
  }
  hits.forEach((hit) => {
    const li = el('li', 'log__item');
    if (Math.abs(hit.z) < 3) li.classList.add('is-quiet');
    const what = el('p', 'log__what');
    what.append(document.createTextNode(hit.z > 0 ? 'Выше коридора: ' : 'Ниже коридора: '));
    what.append(el('b', null, hit.track.label));
    what.append(document.createTextNode(
      ` — ${fmt(hit.value, hit.track.unit)}${hit.track.unit ? ' ' + hit.track.unit : ''} ` +
      `против скользящей средней ${fmt(hit.mean, hit.track.unit)}` +
      (hit.mean ? ` (отклонение ${((hit.value - hit.mean) / hit.mean * 100).toFixed(1).replace('.', ',')}%).` : '.')));
    li.append(what);
    li.append(el('p', 'log__z', (hit.z > 0 ? '+' : '') + hit.z.toFixed(2).replace('.', ',') + 'σ'));
    li.append(el('p', 'log__meta',
      `${day(hit.at)} ${clock(hit.at)} · ${hit.track.source} · σ ${fmt(hit.sd, hit.track.unit)} ` +
      `по ${DATA.anomaly_config.window} показаниям до этой точки`));
    li.addEventListener('click', () => {
      if (!TRACKS[hit.track.id]) return;
      if (hit.track.id.startsWith('network_')) {
        HERO = hit.track.id;
        $$('[data-series]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.series === HERO)));
        renderHero();
        $('#tape').scrollIntoView({ behavior: REDUCED.matches ? 'auto' : 'smooth', block: 'start' });
      }
    });
    list.append(li);
  });
}

/* tiles and small multiples */

function tiles(target, keys) {
  const box = $(target);
  box.innerHTML = '';
  keys.forEach((key) => box.append(readout(key)));
}

function panel(trackId, title) {
  const track = TRACKS[trackId];
  const fig = el('figure', 'card');
  const cap = el('figcaption', 'card__h');
  cap.append(el('span', null, title));
  if (!track) {
    cap.append(el('span', 'panel__v', '—'));
    fig.append(cap, el('p', 'card__note', 'в этом снимке нет такого ряда'));
    return fig;
  }
  const last = [...track.v].reverse().find((x) => typeof x === 'number');
  const { flags, hits } = flagsFor(track, Z);
  const value = el('span', 'panel__v', fmt(last, track.unit));
  if (flags[flags.length - 1]) value.classList.add('is-alert');
  cap.append(value);
  fig.append(cap);
  const canvas = el('canvas');
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', `${title}: ${track.v.length} показаний, ${hits.length} аномалий`);
  fig.append(canvas);
  const note = el('p', 'card__note',
    `${track.source} · одно показание каждые ${track.step} · ${hits.length} за порогом ${Z.toFixed(1).replace('.', ',')}σ`);
  fig.append(note);
  requestAnimationFrame(() => register(canvas, () => drawTrace(canvas,
    { t: track.t, v: track.v, band: track.band, flags, unit: track.unit,
      short: track.unit === 'USD' ? (x) => '$' + compact(x) : null })));
  return fig;
}

function renderPanels() {
  const net = $('#net-panels');
  net.innerHTML = '';
  net.append(panel('network_slot_time', 'Время слота, мс'));
  net.append(panel('network_non_vote_tps', 'Транзакции без голосования в секунду'));
  if (TRACKS.own_skipped_slot_rate) net.append(panel('own_skipped_slot_rate', 'Пропущенные слоты, %'));

  const eco = $('#eco-panels');
  eco.innerHTML = '';
  eco.append(panel('price_usd', 'Цена SOL, 90 дней'));
  eco.append(panel('tvl_usd', 'TVL DeFi, 90 дней'));
  eco.append(panel('dex_volume_24h', 'Объём DEX в день, 90 дней'));
  eco.append(panel('chain_fees_24h', 'Комиссии сети в день, 90 дней'));
}

/* validators */

function renderValidators() {
  tiles('#val-tiles', ['validators_active', 'validators_delinquent', 'nakamoto',
    'staked_share', 'stake_top10_share', 'commission_weighted']);

  const field = $('#validator-field');
  field.innerHTML = '';
  const active = (metric('validators_active') || {}).value || 0;
  const late = (metric('validators_delinquent') || {}).value || 0;
  const top = (DATA.tables.top_validators || []).length;
  for (let i = 0; i < active; i++) {
    const mark = el('i');
    if (i < top) mark.dataset.big = '1';
    field.append(mark);
  }
  for (let i = 0; i < late; i++) {
    const mark = el('i');
    mark.dataset.late = '1';
    field.append(mark);
  }
  field.setAttribute('aria-label',
    `${active} активных валидаторов и ${late} делинквентных, одна отметка на каждый`);
  $('#field-note').textContent =
    `${group(active)} голосуют, ${group(late)} делинквентны. Делинквентный валидатор недавно ` +
    'перестал голосовать; отметки берутся из того же запроса, что и счётчики.';

  const canvas = $('#lorenz-canvas');
  const buckets = DATA.tables.stake_buckets || [];
  const top12 = DATA.tables.top_validators || [];
  if (top12.length) {
    register(canvas, () => {
      const cumulative = [];
      let sum = 0;
      top12.forEach((row) => { sum += row.share; cumulative.push(sum); });
      const v = [0, ...cumulative];
      drawTrace(canvas, { t: v.map((_, i) => i), v, band: [], flags: [], unit: '%',
        short: (x) => x.toFixed(0) + '%' });
    });
  }

  const body = $('#validator-table tbody');
  body.innerHTML = '';
  top12.forEach((row, i) => {
    const tr = el('tr');
    tr.append(el('td', 'rank', String(i + 1)));
    const who = el('td');
    if (row.name) who.textContent = row.name;
    else { who.className = 'anon'; who.textContent = row.vote.slice(0, 6) + '…' + row.vote.slice(-4); }
    tr.append(who);
    tr.append(el('td', 'num', group(row.stake)));
    tr.append(el('td', 'num', row.share.toFixed(2).replace('.', ',') + '%'));
    tr.append(el('td', 'num', row.commission + '%'));
    body.append(tr);
  });

  const bars = $('#commission-bars');
  bars.innerHTML = '';
  const hist = DATA.tables.commission_hist || [];
  const max = Math.max(1, ...hist.map((r) => r.validators));
  hist.forEach((row) => {
    const bar = el('div', 'bar');
    bar.append(el('span', 'bar__t', row.bucket));
    const track = el('span', 'bar__track');
    const fill = el('span', 'bar__fill');
    fill.style.width = (row.validators / max * 100).toFixed(1) + '%';
    track.append(fill);
    bar.append(track);
    bar.append(el('span', 'bar__n', group(row.validators)));
    bars.append(bar);
  });

  if (buckets.length) {
    const card = $('#validator-field').closest('.card');
    const note = el('p', 'card__note',
      'По размеру: ' + buckets.filter((b) => b.validators)
        .map((b) => `${b.bucket} — ${b.validators}`).join(' · '));
    card.append(note);
  }
}

/* upgrades */

function renderUpgrades() {
  const rel = $('#releases');
  rel.innerHTML = '';
  (DATA.upgrades.releases || []).forEach((r) => {
    const li = el('li');
    const a = el('a', null, r.tag);
    a.href = r.url; a.rel = 'noreferrer';
    li.append(a);
    if (r.prerelease) li.append(el('span', 'tag', 'пререлиз'));
    li.append(el('span', 'when', r.published_at ? r.published_at.slice(0, 10) : 'не опубликовано'));
    rel.append(li);
  });
  if (!rel.children.length) rel.append(el('li', 'card__note', 'GitHub не ответил в этом запуске.'));

  const simd = $('#simd');
  simd.innerHTML = '';
  (DATA.upgrades.simd || []).forEach((p) => {
    const li = el('li');
    const a = el('a', null, `SIMD #${p.number} — ${p.title}`);
    a.href = p.url; a.rel = 'noreferrer';
    li.append(a);
    li.append(el('span', 'when', 'обновлено ' + (p.updated_at || '').slice(0, 10)));
    simd.append(li);
  });
  if (!simd.children.length) simd.append(el('li', 'card__note', 'GitHub не ответил в этом запуске.'));

  const box = $('#versions');
  box.innerHTML = '';
  const versions = DATA.tables.client_versions || [];
  const c = ink();
  versions.forEach((row, i) => {
    const span = el('span');
    span.style.flex = `${Math.max(row.share, 0.6)} 0 0`;
    const shade = 0.72 - i * 0.075;
    span.style.background = `color-mix(in oklab, var(--ink) ${Math.max(10, shade * 100).toFixed(0)}%, var(--paper-2))`;
    span.style.color = i < 3 ? 'var(--paper-2)' : 'var(--ink)';
    span.title = `${row.version} — ${row.share}% активного стейка`;
    span.textContent = row.share >= 6 ? `${row.version} ${row.share}%` : '';
    box.append(span);
  });
  void c;
}

/* gaps and sources */

function renderGaps() {
  const box = $('#gaps');
  box.innerHTML = '';
  (DATA.gaps || []).forEach((gap) => {
    const card = el('div', 'gap-card');
    card.append(el('h3', null, GAP_LABEL[gap.metric] || gap.metric.replace(/_/g, ' ')));
    card.append(el('p', null, gap.reason));
    if (gap.tried && gap.tried.length) {
      const ul = el('ul');
      gap.tried.forEach((x) => ul.append(el('li', null, x)));
      card.append(ul);
    }
    box.append(card);
  });
}

function renderSources() {
  const body = $('#source-table tbody');
  body.innerHTML = '';
  Object.entries(DATA.metrics).forEach(([key, m]) => {
    const tr = el('tr');
    if (m.value === null) tr.classList.add('is-gap');
    tr.append(el('td', null, LABEL[key] || m.label || key));
    const value = el('td', 'num');
    value.textContent = m.value === null ? '—' : fmt(m.value, m.unit) + (m.unit ? ' ' + m.unit : '');
    tr.append(value);
    tr.append(el('td', null, m.source || '—'));
    tr.append(el('td', 'ep', m.error ? m.error : (m.endpoint || '—')));
    tr.append(el('td', 'ep', (m.captured_at || '').replace('T', ' ').replace('Z', '')));
    body.append(tr);
  });
}

/* freshness: the pen is either writing or lifted */

function renderFreshness() {
  const captured = Date.parse(DATA.generated_at) / 1000;
  const interval = (DATA.run.interval_minutes || 30) * 60;
  const pen = $('#pen-state');
  const tick = () => {
    const age = Date.now() / 1000 - captured;
    $('#capture-ago').textContent = ago(age);
    const stale = age > interval * 2.5;
    pen.dataset.state = stale ? 'lifted' : 'writing';
    $('#pen-text').textContent = stale
      ? 'перо поднято — последний запуск старше двух интервалов'
      : `перо опущено — собирается каждые ${DATA.run.interval_minutes} мин`;
  };
  tick();
  setInterval(tick, 1000);
  $('#run-line').textContent =
    `запуск ${DATA.generated_at} · ${DATA.run.ok}/${DATA.run.requests} запросов отвечено · ` +
    `${DATA.run.duration_ms} мс · ${Object.keys(DATA.metrics).length} метрик · ` +
    `${DATA.anomaly_count} аномалий при пороге сборщика ${DATA.anomaly_config.z_threshold}σ`;
}

/* ── wiring ─────────────────────────────────────────────────────────────── */

function wire() {
  $$('[data-theme-set]').forEach((b) => b.addEventListener('click', () => setTheme(b.dataset.themeSet)));

  $$('[data-series]').forEach((b) => b.addEventListener('click', () => {
    HERO = b.dataset.series;
    $$('[data-series]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    renderHero();
  }));

  const z = $('#z-input');
  z.addEventListener('input', () => {
    Z = parseFloat(z.value);
    $('#z-out').textContent = Z.toFixed(1).replace('.', ',') + ' σ';
    renderHero();
    renderLog();
    renderReadouts();
    renderPanels();
  });

  addEventListener('keydown', (e) => { if (e.key === 'Escape') { $('#src-popover').hidden = true; } });

  let resizeTimer = null;
  addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(redrawAll, 140);
  });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (document.documentElement.dataset.theme === 'auto') requestAnimationFrame(redrawAll);
  });
}

function reveal() {
  if (REDUCED.matches || !('IntersectionObserver' in window)) return;
  const io = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      entry.target.classList.add('is-in');
      io.unobserve(entry.target);
    });
  }, { rootMargin: '0px 0px -12% 0px' });
  const staged = $$('section .card, section .tiles, .gap-card, .table--sources');
  staged.forEach((node) => { node.classList.add('reveal'); io.observe(node); });
  setTimeout(() => staged.forEach((node) => node.classList.add('is-in')), 4000);
}

async function main() {
  try {
    const stored = localStorage.getItem('tape-theme');
    if (stored) setTheme(stored); else setTheme('auto');
  } catch (e) { setTheme('auto'); }

  let response;
  try {
    response = await fetch('../data/latest.json', { cache: 'no-cache' });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    DATA = await response.json();
    translateData(DATA);
  } catch (err) {
    $('#pen-text').textContent = 'файл с данными не читается: ' + err.message;
    $('#pen-state').dataset.state = 'lifted';
    return;
  }

  Z = DATA.anomaly_config.z_threshold;
  $('#z-input').value = Z;
  $('#z-out').textContent = Z.toFixed(1).replace('.', ',') + ' σ';

  buildTracks();
  if (!TRACKS[HERO]) HERO = Object.keys(TRACKS)[0];
  wire();
  renderHero();
  renderReadouts();
  renderEpoch();
  renderLog();
  tiles('#net-tiles', ['health', 'slot_time_ms', 'skipped_slot_rate', 'slot_rate',
    'leaders_in_window', 'epoch_progress']);
  tiles('#eco-tiles', ['price_usd', 'market_cap', 'stablecoin_supply', 'dex_volume_24h',
    'chain_fees_24h', 'median_priority_fee', 'supply_circulating', 'inflation_rate']);
  tiles('#grow-tiles', ['tx_per_day', 'tx_count_total', 'dex_volume_24h_change',
    'volume_24h', 'price_change_24h']);
  renderPanels();
  renderValidators();
  renderUpgrades();
  renderGaps();
  renderSources();
  renderFreshness();
  reveal();
}

main();
