'use strict';
/* Pulse: incident-first anomaly alerting for ad campaigns.
   Prototype for the Media.net APM case study (Shubham Meena).
   Everything below runs in the browser: a seeded simulator generates 14 days of hourly
   data for 120 campaigns, and the detection engine turns raw anomalies into a few
   prioritised, explained incidents. */

/* ============================== utilities ============================== */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const esc = s => String(s).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
const money = v => {
  const a = Math.abs(v);
  const s = a >= 1e6 ? (a / 1e6).toFixed(1) + 'M' : a >= 1e4 ? (a / 1e3).toFixed(0) + 'K' : a >= 1e3 ? (a / 1e3).toFixed(1) + 'K' : a.toFixed(0);
  return (v < 0 ? '-' : '') + '$' + s;
};
const num = v => Math.round(v).toLocaleString('en-US');
const pct = (v, d = 0) => (v * 100).toFixed(d) + '%';
const times = v => v.toFixed(1) + '×';

function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
let rnd = mulberry32(1);
function randn() { let u = 0, v = 0; while (!u) u = rnd(); while (!v) v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
function poisson(l) {
  if (l <= 0) return 0;
  if (l > 40) return Math.max(0, Math.round(l + Math.sqrt(l) * randn()));
  const L = Math.exp(-l); let k = 0, p = 1;
  do { k++; p *= rnd(); } while (p > L);
  return k - 1;
}
function median(a) { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }
function erfc(x) {
  const z = Math.abs(x), t = 1 / (1 + 0.5 * z);
  const r = t * Math.exp(-z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
  return x >= 0 ? r : 2 - r;
}
const confOf = z => 1 - 0.5 * erfc(z / Math.SQRT2);
const confTxt = c => c >= 0.999 ? '>99.9%' : pct(c, 1);
const store = {
  get(k, d) { try { const v = localStorage.getItem('pulse.' + k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('pulse.' + k, JSON.stringify(v)); } catch (e) { /* storage unavailable */ } }
};

/* ============================== time axis ============================== */
// 336 hourly buckets. Index 335 = the latest complete hour (Wed 11 Nov 2026, 14:00-15:00).
const H = 336, NOW = 335, START_HOUR = 15;
const hod = i => (i + START_HOUR) % 24;
const dayIdx = i => Math.floor((i + START_HOUR) / 24);
const dayDate = d => new Date(Date.UTC(2026, 10, 11 - (14 - d)));
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dow = i => dayDate(dayIdx(i)).getUTCDay();
const hh = i => String(hod(i)).padStart(2, '0') + ':00';
const dLabel = i => { const d = dayDate(dayIdx(i)); return `${DOW[d.getUTCDay()]} ${d.getUTCDate()} ${MON[d.getUTCMonth()]}`; };
const tLabel = i => `${dLabel(i)}, ${hh(i)}`;
const at = (day, hour) => day * 24 + hour - START_HOUR;
const ago = h => h <= 0 ? 'this hour' : h === 1 ? '1 h ago' : h >= 36 ? `${Math.round(h / 24)} days ago` : `${h} h ago`;
const since = i => NOW - i >= 24 ? dLabel(i) : hh(i);

// Daily traffic shape: morning and evening peaks (mean 1.0)
const HC = (() => { const a = []; for (let h = 0; h < 24; h++) a.push(0.22 + 0.95 * Math.exp(-((h - 11) ** 2) / 16) + 1.15 * Math.exp(-((h - 20.5) ** 2) / 9)); const m = a.reduce((x, y) => x + y) / 24; return a.map(x => x / m); })();

/* ============================== catalogue ============================== */
const ADVERTISERS = [
  ['ShopKart', 'Retail'], ['UrbanThreads', 'Retail'], ['GadgetHub', 'Retail'],
  ['FlyNow', 'Travel'], ['StayWell Hotels', 'Travel'],
  ['PaySure Loans', 'Finance'], ['InsureEasy', 'Finance'],
  ['ZoomAuto', 'Auto'], ['LearnFast', 'Education'], ['CareFirst Clinics', 'Health'],
  ['HomeNest', 'Real estate'], ['QuickBite', 'Food delivery']
];
const SUPPLIES = ['News-Tier1', 'Finance-Blogs', 'Sports-Network', 'Weather-Apps', 'Recipes-Network', 'Tech-Reviews', 'Travel-Guides', 'Local-News'];
const CHANNELS = ['Contextual Search', 'Native', 'Display'];
const THEMES = ['Brand', 'Prospecting', 'Retargeting', 'Lookalike', 'Seasonal', 'Category A', 'Category B', 'Metro', 'Tier-2 cities', 'Competitor', 'Generic', 'App installs', 'Promo'];
const GEOS = ['US', 'UK', 'CA', 'AU', 'IN'];
const METRICS = ['imp', 'clk', 'spend', 'conv'];

function buildCatalogue() {
  rnd = mulberry32(7);
  const cs = []; let id = 1;
  ADVERTISERS.forEach(([adv, vertical], ai) => {
    const n = 7 + Math.floor(rnd() * 7);
    for (let j = 0; j < n; j++) {
      const channel = CHANNELS[Math.floor(rnd() * 3)];
      const budget = Math.round(Math.exp(Math.log(400) + rnd() * Math.log(12)) / 50) * 50;
      const cpc = +(0.25 + rnd() * 1.3).toFixed(2);
      const ctr = channel === 'Contextual Search' ? 0.02 + rnd() * 0.03 : channel === 'Native' ? 0.006 + rnd() * 0.01 : 0.002 + rnd() * 0.004;
      const cvr = 0.025 + rnd() * 0.06;
      cs.push({
        id: 'C' + String(id++).padStart(3, '0'), adv, vertical,
        name: THEMES[j % THEMES.length], channel, geo: GEOS[Math.floor(rnd() * GEOS.length)],
        supply: SUPPLIES[Math.floor(rnd() * SUPPLIES.length)],
        pixel: 'PX-' + (100 + ai * 3 + (n > 10 && j >= n / 2 ? 1 : 0)),
        budget, cpc, ctr, cvr, tcpa: Math.round(cpc / cvr * (0.95 + rnd() * 0.2) * 100) / 100,
        weekend: ['Retail', 'Travel', 'Food delivery'].includes(vertical) ? 1.12 : 0.8
      });
    }
  });
  return cs;
}
const CS = buildCatalogue();
const byAdvTop = (adv, k) => CS.filter(c => c.adv === adv).sort((a, b) => b.budget - a.budget)[k];
function resolveScope(s) {
  if (s.all) return CS;
  if (s.pixelOf) { const p = CS.find(c => c.adv === s.pixelOf).pixel; return CS.filter(c => c.pixel === p); }
  if (s.adv) return CS.filter(c => c.adv === s.adv);
  if (s.supply) return CS.filter(c => c.supply === s.supply);
  if (s.vertical) return CS.filter(c => c.vertical === s.vertical);
  if (s.top) return [byAdvTop(s.top[0], s.top[1])];
  return [];
}

/* ============================== simulator ============================== */
// Ground-truth incidents planted in history: used to backtest precision / recall / time-to-detect.
const HIST_EVENTS = [
  { type: 'PIXEL', scope: { pixelOf: 'QuickBite' }, s: at(8, 10), e: at(8, 15), what: 'Pixel removed in a site release' },
  { type: 'IVT', scope: { supply: 'Weather-Apps' }, s: at(9, 13), e: at(9, 18), what: 'Click-farm traffic on a supply cluster' },
  { type: 'RUNAWAY', scope: { top: ['FlyNow', 0] }, s: at(9, 18), e: at(9, 21), what: 'Daily cap removed by mistake' },
  { type: 'FILL', scope: { supply: 'Recipes-Network' }, s: at(10, 8), e: at(10, 11), what: 'Publisher ad-tag outage' },
  { type: 'CPA', scope: { top: ['LearnFast', 0] }, s: at(10, 15), e: at(10, 20), what: 'Landing page form broken' },
  { type: 'PIXEL', scope: { pixelOf: 'InsureEasy' }, s: at(11, 19), e: at(11, 22), what: 'Tag manager misconfiguration' },
  { type: 'RUNAWAY', scope: { adv: 'GadgetHub' }, s: at(11, 11), e: at(11, 15), what: 'Account-wide bid multiplier typo' },
  { type: 'IVT', scope: { supply: 'Tech-Reviews' }, s: at(12, 20), e: at(12, 23), what: 'Bot traffic burst' },
  { type: 'CPA', scope: { top: ['CareFirst Clinics', 0] }, s: at(12, 10), e: at(12, 14), what: 'Checkout outage' },
  { type: 'FILL', scope: { supply: 'Local-News' }, s: at(13, 9), e: at(13, 12), what: 'Supply partner downtime' }
];
const BT_START = 171, BT_END = 311;
const SEV_RANK = { P1: 0, P2: 1, P3: 2, Info: 3 };
const FAMILY = { PIXEL: 'CONV_ZERO', IVT: 'IVT', RUNAWAY: 'SPEND_HIGH', FILL: 'DELIVERY_DROP', CPA: 'CVR_DROP' };
// A broken checkout can legitimately surface as zero conversions: both are correct diagnoses of a conversion failure.
const ACCEPT = { PIXEL: ['CONV_ZERO'], IVT: ['IVT'], RUNAWAY: ['SPEND_HIGH'], FILL: ['DELIVERY_DROP'], CPA: ['CVR_DROP', 'CONV_ZERO'] };

// Live scenarios (today). Three are running when the page loads; the rest are in the scenario lab.
const SCENARIOS = {
  PIXEL_SHOP: { type: 'PIXEL', scope: { pixelOf: 'ShopKart' }, s: at(14, 11), label: 'Pixel outage', sub: 'ShopKart tag stops firing' },
  IVT_SPORTS: { type: 'IVT', scope: { supply: 'Sports-Network' }, s: at(14, 12), label: 'Bot traffic', sub: 'Invalid clicks on a supply' },
  FATIGUE: { type: 'FATIGUE', scope: { top: ['StayWell Hotels', 0] }, s: at(9, 15), label: 'Creative fatigue', sub: 'Slow CTR decay' },
  RUNAWAY: { type: 'RUNAWAY', scope: { adv: 'HomeNest' }, s: at(14, 12), label: 'Budget runaway', sub: 'HomeNest cap removed' },
  FILL: { type: 'FILL', scope: { supply: 'News-Tier1' }, s: at(14, 13), label: 'Publisher outage', sub: 'News-Tier1 fill drops' },
  CPA: { type: 'CPA', scope: { top: ['InsureEasy', 0] }, s: at(14, 11), label: 'Landing page broken', sub: 'InsureEasy form fails' },
  DELAY: { type: 'DELAY', scope: { all: true }, s: NOW - 1, label: 'Reporting delay', sub: 'Last 2 h data partial' },
  SALE: { type: 'SALE', scope: { vertical: 'Retail' }, s: at(14, 9), label: 'Retail sale surge', sub: 'Planned, expected spike' }
};
const DEFAULT_LIVE = ['PIXEL_SHOP', 'IVT_SPORTS', 'FATIGUE'];

function applyEvent(ev) {
  const cs = resolveScope(ev.scope); const e = ev.e ?? NOW;
  for (const c of cs) for (let i = ev.s; i <= e; i++) {
    switch (ev.type) {
      case 'PIXEL': c.conv[i] = 0; break;
      case 'RUNAWAY': c.clk[i] = Math.round(c.clk[i] * 3); c.spend[i] *= 3; c.imp[i] *= 2.9; c.conv[i] = poisson(c.clk[i] * c.cvr * 0.75); break;
      case 'IVT': { const x = Math.round(c.clk[i] * 0.9); c.clk[i] += x; c.spend[i] += x * c.cpc; c.imp[i] *= 1.04; break; }
      case 'FILL': c.imp[i] = Math.round(c.imp[i] * 0.2); c.clk[i] = Math.round(c.clk[i] * 0.2); c.spend[i] *= 0.2; c.conv[i] = poisson(c.clk[i] * c.cvr); break;
      case 'CPA': c.conv[i] = poisson(c.clk[i] * c.cvr * 0.15); break;
      case 'SALE': c.clk[i] = Math.round(c.clk[i] * 2.2); c.spend[i] *= 2.2; c.imp[i] *= 2.1; c.conv[i] = poisson(c.clk[i] * c.cvr * 1.15); break;
      case 'DELAY': c.clk[i] = Math.round(c.clk[i] * 0.3); c.spend[i] *= 0.3; c.imp[i] = Math.round(c.imp[i] * 0.3); c.conv[i] = Math.round(c.conv[i] * 0.3); break;
      case 'FATIGUE': { const f = 1 - 0.5 * (i - ev.s) / (e - ev.s); c.clk[i] = Math.round(c.clk[i] * f); c.spend[i] *= f; c.conv[i] = poisson(c.clk[i] * c.cvr); break; }
    }
  }
}

function generate(liveKeys) {
  rnd = mulberry32(42);
  for (const c of CS) {
    for (const m of METRICS) c[m] = new Float64Array(H);
    for (let i = 0; i < H; i++) {
      const wk = (dow(i) === 0 || dow(i) === 6) ? c.weekend : 1;
      const lvl = HC[hod(i)] * wk * Math.exp(0.10 * randn());
      const clk = poisson(c.budget / 24 * lvl / c.cpc);
      c.clk[i] = clk;
      c.spend[i] = clk * c.cpc * Math.exp(0.04 * randn());
      c.imp[i] = Math.round(clk / c.ctr * Math.exp(0.06 * randn()));
      c.conv[i] = poisson(clk * c.cvr);
    }
  }
  HIST_EVENTS.forEach(applyEvent);
  liveKeys.forEach(k => applyEvent(SCENARIOS[k]));
  // Baseline: median of the same hour over the previous 7 days (seasonality-aware, robust to past spikes).
  // Conversion rate barely varies by hour, so its baseline is the campaign's 7-day rate (thousands of clicks, far less noisy).
  for (const c of CS) {
    c.cClk = new Float64Array(H + 1); c.cConv = new Float64Array(H + 1);
    for (let i = 0; i < H; i++) { c.cClk[i + 1] = c.cClk[i] + c.clk[i]; c.cConv[i + 1] = c.cConv[i] + c.conv[i]; }
    c.med = {};
    for (const m of METRICS) {
      const arr = new Float64Array(H);
      for (let i = 168; i < H; i++) { const v = []; for (let k = 1; k <= 7; k++) v.push(c[m][i - 24 * k]); arr[i] = median(v); }
      c.med[m] = arr;
    }
  }
}

/* ============================== detection engine ============================== */
const TYPES = {
  CONV_ZERO: { label: 'Conversion tracking loss', dims: ['pixel', 'adv'], metric: 'conv', short: 'Tracking loss' },
  IVT: { label: 'Suspected invalid traffic', dims: ['supply'], metric: 'clk', short: 'Invalid traffic' },
  SPEND_HIGH: { label: 'Spend runaway', dims: ['adv', 'supply'], metric: 'spend', short: 'Spend runaway' },
  DELIVERY_DROP: { label: 'Delivery drop', dims: ['supply', 'adv'], metric: 'imp', short: 'Delivery drop' },
  CVR_DROP: { label: 'Conversion-rate collapse', dims: ['adv'], metric: 'conv', short: 'CVR collapse' },
  FATIGUE: { label: 'Creative fatigue', dims: [], metric: 'ctr', short: 'Creative fatigue' },
  DATA_LAG: { label: 'Reporting delay', dims: [], metric: 'imp', short: 'Data delay' }
};
const DIM_LABEL = { pixel: 'conversion pixel', adv: 'advertiser', supply: 'supply cluster', campaign: 'campaign' };
// Count-based z-score with over-dispersion (od): sd = sqrt(e + (od*e)^2)
const zc = (x, e, od) => (x - e) / Math.sqrt(Math.max(e, 1) + (od * e) ** 2);

// Campaign-level candidates use a looser threshold (0.6k); an incident only fires when the
// aggregated group clears the full threshold k. Grouping adds statistical power.
function cvrBase(c, t) { const a = Math.max(0, t - 191), b = Math.max(1, t - 23); return (c.cConv[b] - c.cConv[a]) / Math.max(c.cClk[b] - c.cClk[a], 1); }
function candidates(c, t, P) {
  const w = P.persist, A = { imp: 0, clk: 0, spend: 0, conv: 0 }, E = { imp: 0, clk: 0, spend: 0, conv: 0, ec: 0 };
  for (let i = t - w + 1; i <= t; i++) for (const m of METRICS) { A[m] += c[m][i]; E[m] += c.med[m][i]; }
  E.ec = A.clk * cvrBase(c, t);                                   // expected conversions for the clicks actually received
  const r = { c, A, E, elig: E.clk >= P.minClicks * w, types: [] };
  if (!r.elig) return r;
  const kc = P.k * 0.6, od = P.od;
  const impR = A.imp / Math.max(E.imp, 1);
  if (impR <= 0.5 && zc(A.imp, E.imp, od) <= -kc) { r.types.push('DELIVERY_DROP'); return r; }
  const ctrR = (A.clk / Math.max(A.imp, 1)) / (E.clk / Math.max(E.imp, 1));
  const eConv = E.ec;
  const cvrR = eConv > 0 ? A.conv / eConv : 1;
  let ivt = false;
  if (ctrR >= 1.6 && zc(A.clk, E.clk * impR, od) >= kc && cvrR <= 0.65) { r.types.push('IVT'); ivt = true; }
  if (!ivt && A.spend / Math.max(E.spend, 1) >= 1.5 && zc(A.clk, E.clk, od) >= kc) r.types.push('SPEND_HIGH');
  if (A.clk >= 0.5 * E.clk && eConv >= 1) {
    if (A.conv === 0) r.types.push('CONV_ZERO');
    else if (!ivt && cvrR <= 0.5 && zc(A.conv, eConv, od / 3) <= -kc) r.types.push('CVR_DROP');   // conversions given clicks: traffic noise already conditioned out
  }
  return r;
}

function aggZ(type, A, E, od) {
  const eConv = E.ec;
  switch (type) {
    case 'SPEND_HIGH': return zc(A.clk, E.clk, od);
    case 'IVT': return zc(A.clk, E.clk * A.imp / Math.max(E.imp, 1), od);
    case 'DELIVERY_DROP': return -zc(A.imp, E.imp, od);
    case 'CONV_ZERO': return A.conv === 0 ? Math.sqrt(eConv) : 0;   // P(0 | Poisson e) = exp(-e)
    case 'CVR_DROP': return -zc(A.conv, eConv, od / 3);
  }
  return 0;
}

function makeIncident(type, dim, val, mem, P, t) {
  const A = { imp: 0, clk: 0, spend: 0, conv: 0 }, E = { imp: 0, clk: 0, spend: 0, conv: 0, ec: 0 };
  mem.forEach(r => { METRICS.forEach(m => { A[m] += r.A[m]; E[m] += r.E[m]; }); E.ec += r.E.ec; });
  const z = aggZ(type, A, E, P.od);
  if (!(z >= P.k + (dim === 'campaign' && type !== 'CVR_DROP' ? 1 : 0))) return null;   // a lone campaign needs stronger evidence (landing-page failures are campaign-scoped by nature)
  const w = P.persist, eConv = E.ec;
  let risk = 0;
  switch (type) {
    case 'CONV_ZERO': risk = A.spend / w; break;                                   // spend flowing with no conversion signal
    case 'SPEND_HIGH': risk = (A.spend - E.spend) / w; break;                      // spend above the norm
    case 'IVT': { const exp = E.clk * A.imp / Math.max(E.imp, 1); risk = Math.max(0, A.clk - exp) * (A.spend / Math.max(A.clk, 1)) / w; break; }
    case 'DELIVERY_DROP': risk = Math.max(0, E.spend - A.spend) / w; break;         // lost delivery (revenue)
    case 'CVR_DROP': risk = A.spend * Math.max(0, 1 - A.conv / Math.max(eConv, 1e-9)) / w; break;
  }
  if (risk < P.minRisk) return null;                                              // materiality floor
  const conf = confOf(z), score = risk * conf;
  const sev = score >= P.p1 ? 'P1' : score >= P.p2 ? 'P2' : 'P3';
  return { key: `${type}|${dim}|${val}`, type, dim, val, members: mem.map(r => r.c), core: mem.length, A, E, z, conf, risk, score, sev, t, eConv };
}

function detectAt(t, P, ctx) {
  const per = CS.map(c => candidates(c, t, P));
  const eligible = per.filter(r => r.elig);
  const cand = {}; Object.keys(TYPES).forEach(k => cand[k] = []);
  per.forEach(r => r.types.forEach(ty => cand[ty].push(r)));

  // Context calendar: an expected surge (sale day) is not an incident if efficiency holds.
  const suppressed = [];
  if (ctx.calendar) {
    cand.SPEND_HIGH = cand.SPEND_HIGH.filter(r => {
      if (r.c.vertical !== 'Retail') return true;
      const cpaA = r.A.spend / Math.max(r.A.conv, 0.5), cpaE = r.E.spend / Math.max(r.E.conv, 0.5);
      if (cpaA <= 1.3 * cpaE) { suppressed.push(r); return false; }
      return true;
    });
  }
  // Data-freshness guard: a simultaneous drop across most supply clusters is a pipeline problem, not 40 incidents.
  let lag = null;
  if (P.freshness) {
    const dd = cand.DELIVERY_DROP, sup = new Set(dd.map(r => r.c.supply));
    if (dd.length >= 0.4 * eligible.length && sup.size >= 5) {
      lag = { campaigns: dd.length, supplies: sup.size, held: dd.length + cand.CONV_ZERO.length + cand.CVR_DROP.length };
      cand.DELIVERY_DROP = []; cand.CONV_ZERO = []; cand.CVR_DROP = [];
    }
  }
  // Group into incidents by shared root-cause dimension, then fall back to single campaigns.
  const incidents = [];
  for (const type of ['CONV_ZERO', 'IVT', 'SPEND_HIGH', 'DELIVERY_DROP', 'CVR_DROP']) {
    const pool = cand[type], used = new Set();
    for (const dim of TYPES[type].dims) {
      const groups = new Map();
      pool.forEach(r => { if (used.has(r.c.id)) return; const v = r.c[dim]; if (!groups.has(v)) groups.set(v, []); groups.get(v).push(r); });
      [...groups.entries()].sort((a, b) => b[1].length - a[1].length).forEach(([v, mem]) => {
        if (mem.length < 2) return;
        // share among campaigns on this entity that are not busy with a different anomaly
        const N = eligible.filter(r => r.c[dim] === v && (r.types.length === 0 || r.types.includes(type))).length;
        if (mem.length / N < 0.5) return;
        const inc = makeIncident(type, dim, v, mem, P, t);
        if (inc) { inc.share = mem.length / N; inc.N = N; incidents.push(inc); mem.forEach(r => used.add(r.c.id)); }
      });
    }
    pool.forEach(r => { if (used.has(r.c.id)) return; const inc = makeIncident(type, 'campaign', r.c.id, [r], P, t); if (inc) incidents.push(inc); });
  }
  // Root-cause clustering: a single-campaign signal on the same pixel / supply / advertiser as a group incident joins it.
  const groups = [], merged = [];
  incidents.sort((a, b) => (a.dim === 'campaign') - (b.dim === 'campaign'));   // groups first (stable: keeps rule priority)
  for (const inc of incidents) {
    if (inc.dim !== 'campaign') {                         // same entity, second signature: one incident, not two
      const g = groups.find(g => g.dim === inc.dim && g.val === inc.val);
      if (g) { inc.members.forEach(c => { if (!g.members.includes(c)) g.members.push(c); }); g.risk += inc.risk; g.score += inc.score; continue; }
      groups.push(inc);
    } else {
      const c = inc.members[0], g = groups.find(g => c[g.dim] === g.val);
      if (g) { if (!g.members.includes(c)) g.members.push(c); continue; }
    }
    merged.push(inc);
  }
  return { incidents: merged, lag, suppressed, eligible: eligible.length, rawSignals: per.reduce((s, r) => s + r.types.length, 0) };
}

function fatigueIncidents(t) {
  const out = [];
  for (const c of CS) {
    let cA = 0, iA = 0, cB = 0, iB = 0;
    for (let i = t - 47; i <= t; i++) { cA += c.clk[i]; iA += c.imp[i]; }
    for (let i = t - 216; i <= t - 72; i++) { cB += c.clk[i]; iB += c.imp[i]; }
    if (cA < 300) continue;
    const r = (cA / iA) / (cB / iB);
    if (r <= 0.75) {
      const lost = Math.max(0, (cB / iB) * iA - cA) / 48 * c.cpc;
      out.push({ key: `FATIGUE|campaign|${c.id}`, type: 'FATIGUE', dim: 'campaign', val: c.id, members: [c], ratio: r, ctrNow: cA / iA, ctrBefore: cB / iB, risk: lost, conf: 0.95, z: null, sev: 'P3', t, score: lost * 0.95 });
    }
  }
  return out;
}

function onsetOf(inc, P) {
  let first = inc.t;
  for (let h = inc.t - 1; h >= inc.t - 24; h--) {
    const hit = inc.members.filter(c => candidates(c, h, P).types.includes(inc.type)).length;
    if (hit < Math.ceil(inc.members.length * 0.5)) break;
    first = h;
  }
  // refine onset inside the persistence window, hour by hour
  const P1h = { ...P, persist: 1 }; let onset = first;
  for (let h = first - 1; h > first - P.persist; h--) {
    const hit = inc.members.filter(c => candidates(c, h, P1h).types.includes(inc.type)).length;
    if (hit < Math.ceil(inc.members.length * 0.5)) break;
    onset = h;
  }
  return { alertedAt: first, onset };
}

/* ============================== backtest ============================== */
function backtest(P) {
  const alerts = [], open = new Map();
  for (let t = BT_START; t <= BT_END; t++) {
    const { incidents } = detectAt(t, P, { calendar: false });
    incidents.sort((a, b) => (a.dim === 'campaign') - (b.dim === 'campaign')).forEach(inc => {
      const ek = inc.dim + '|' + inc.val;                                  // incident identity = root-cause entity (type may be refined)
      const last = open.get(ek);
      if (last && t - last.lastT <= 3) { last.lastT = t; if (inc.type === 'IVT' || inc.type === 'CONV_ZERO') last.type = inc.type; if (SEV_RANK[inc.sev] < SEV_RANK[last.sev]) last.sev = inc.sev; return; }
      if (inc.dim === 'campaign') {                                         // part of an open group incident? then it is the same incident
        const c = inc.members[0];
        const g = [...open.values()].find(o => o.dim !== 'campaign' && t - o.lastT <= 3 && c[o.dim] === o.val);
        if (g) return;
      }
      const a = { key: ek, dim: inc.dim, val: inc.val, type: inc.type, first: t, lastT: t, ids: new Set(inc.members.map(c => c.id)), sev: inc.sev, n: inc.members.length };
      if (inc.dim !== 'campaign') {                                         // retroactively fold singles that fired just before the group formed
        for (let j = alerts.length - 1; j >= 0; j--) {
          const o = alerts[j];
          if (o.dim === 'campaign' && t - o.first <= 3 && CS.find(c => c.id === o.val)[inc.dim] === inc.val) { inc.members.forEach(c => a.ids.add(c.id)); a.ids.add(o.val); if (o.first < a.first) a.first = o.first; alerts.splice(j, 1); open.delete(o.key); }
        }
      }
      open.set(ek, a); alerts.push(a);
    });
  }
  const truth = HIST_EVENTS.map(e => ({ ...e, ids: new Set(resolveScope(e.scope).map(c => c.id)), hit: null, hitSev: null }));
  let tp = 0;
  alerts.forEach(a => {
    const m = truth.find(e => a.first >= e.s && a.first <= e.e + P.persist + 1 && [...a.ids].some(id => e.ids.has(id)));
    a.match = m || null;
    if (m) { tp++; if (ACCEPT[m.type].includes(a.type) && (m.hit === null || a.first < m.hit)) { m.hit = a.first; m.hitSev = a.sev; m.hitType = a.type; } }
  });
  const det = truth.filter(e => e.hit !== null);
  const ttd = det.map(e => e.hit - e.s + 1).sort((x, y) => x - y);
  // Naive baseline: static rule "any metric moves >30% vs the same hour yesterday".
  let naive = 0, naiveTP = 0;
  for (let t = BT_START; t <= BT_END; t++) for (const c of CS) {
    if (c.clk[t - 24] < 10) continue;
    let fire = false;
    for (const m of METRICS) { const b = c[m][t - 24]; if (b > 0 && Math.abs(c[m][t] / b - 1) > 0.3) { fire = true; break; } }
    if (fire) { naive++; if (truth.some(e => t >= e.s && t <= e.e && e.ids.has(c.id))) naiveTP++; }
  }
  const days = (BT_END - BT_START + 1) / 24;
  return {
    alerts, truth, tp, precision: alerts.length ? tp / alerts.length : 1, recall: det.length / truth.length,
    ttdMed: ttd.length ? ttd[(ttd.length - 1) >> 1] : null, perWeek: alerts.length / days * 7,
    naivePerWeek: naive / days * 7, naivePrecision: naive ? naiveTP / naive : 0, days
  };
}

/* ============================== app state ============================== */
const DEFAULT_P = { k: 3.5, persist: 2, minClicks: 8, od: 0.15, p1: 600, p2: 100, minRisk: 25, freshness: true };
const S = {
  P: { ...DEFAULT_P }, calendar: false, live: [...DEFAULT_LIVE],
  status: {}, log: [], fb: store.get('fb', {}), sel: null, tab: 'live', res: null, bt: null, curve: null,
  ack: {}
};
let chart = null, btChart = null;

function recompute() {
  generate(S.live);
  let r = detectAt(NOW, S.P, { calendar: S.calendar });
  if (r.lag) {   // latest hours are partial: judge everything on the last complete hour, keep the lag notice
    const lag = r.lag, raw = r.rawSignals;
    r = detectAt(NOW - 2, S.P, { calendar: S.calendar });
    r.lag = lag; r.rawSignals = raw; r.evalAt = NOW - 2;
  }
  r.incidents.forEach(inc => Object.assign(inc, onsetOf(inc, S.P)));
  const fat = fatigueIncidents(NOW).map(f => ({ ...f, alertedAt: NOW, onset: NOW - 47 }));
  let list = [...r.incidents, ...fat];
  if (r.lag) list.unshift({ key: 'DATA_LAG|all|all', type: 'DATA_LAG', dim: 'all', val: 'all', members: [], risk: 0, score: 0, conf: 0.99, sev: 'Info', t: NOW, alertedAt: NOW, onset: NOW - 1, lag: r.lag });
  const rank = { P1: 0, P2: 1, P3: 2, Info: 3 };
  list.sort((a, b) => rank[a.sev] - rank[b.sev] || b.score - a.score);
  // naive comparison for today: static ±30% vs same hour yesterday
  let naive = 0;
  for (let t = NOW - 23; t <= NOW; t++) for (const c of CS) {
    if (c.clk[t - 24] < 10) continue;
    for (const m of METRICS) { const b = c[m][t - 24]; if (b > 0 && Math.abs(c[m][t] / b - 1) > 0.3) { naive++; break; } }
  }
  S.res = { ...r, list, naive };
  if (!S.sel || !list.find(i => i.key === S.sel)) S.sel = list[0] ? list[0].key : null;
  render();
}

/* ============================== narrative ============================== */
function incTitle(inc) {
  const m = inc.members, c0 = m[0];
  switch (inc.type) {
    case 'CONV_ZERO': return inc.dim === 'pixel' ? `Conversion tracking down on ${inc.val} (${c0.adv})` : inc.dim === 'adv' ? `Conversion tracking down across ${inc.val}` : `Zero conversions: ${c0.adv} · ${c0.name}`;
    case 'IVT': return inc.dim === 'supply' ? `Suspected invalid traffic from ${inc.val}` : `Suspected invalid traffic: ${c0.adv} · ${c0.name}`;
    case 'SPEND_HIGH': return inc.dim === 'adv' ? `Spend runaway across ${inc.val}` : inc.dim === 'supply' ? `Spend surge on ${inc.val}` : `Spend runaway: ${c0.adv} · ${c0.name}`;
    case 'DELIVERY_DROP': return inc.dim === 'supply' ? `Delivery collapsed on ${inc.val}` : inc.dim === 'adv' ? `Delivery collapsed across ${inc.val}` : `Delivery drop: ${c0.adv} · ${c0.name}`;
    case 'CVR_DROP': return inc.dim === 'adv' ? `Conversion rate collapsed across ${inc.val}` : `Conversion rate collapsed: ${c0.adv} · ${c0.name}`;
    case 'FATIGUE': return `Creative fatigue: ${c0.adv} · ${c0.name}`;
    case 'DATA_LAG': return 'Reporting delay: latest 2 hours incomplete';
  }
}
function rootCause(inc) {
  const A = inc.A, E = inc.E;
  switch (inc.type) {
    case 'CONV_ZERO': return inc.dim === 'pixel' ? `Every affected campaign shares pixel ${inc.val}. Traffic is normal, so demand did not vanish: the conversion tag most likely stopped firing (site release, tag-manager change).` : `Clicks are normal but conversions stopped. Most likely a tracking or checkout problem rather than a demand problem.`;
    case 'IVT': return `CTR jumped while conversion rate fell${inc.dim === 'supply' ? `, and only on campaigns served by ${inc.val}` : ''}. Real users who click more also convert more; this pattern points to bots or click farms.`;
    case 'SPEND_HIGH': return inc.dim === 'adv' ? `${inc.members.length} of ${inc.N} ${inc.val} campaigns spiked at the same hour. A simultaneous jump across one account points to an account-level budget, cap or bid change, not organic demand.` : `Spend is far above the same-hour norm while conversions are not keeping pace.`;
    case 'DELIVERY_DROP': return inc.dim === 'supply' ? `Only campaigns on ${inc.val} lost delivery; other supply clusters are normal. Points to a publisher-side outage (ad tag, fill, partner downtime), not the advertisers.` : `Impressions fell sharply versus the same hour on previous days.`;
    case 'CVR_DROP': return `Traffic and CTR are normal but conversion rate fell sharply. Typical causes: broken landing page, form or checkout, or an out-of-stock offer.`;
    case 'FATIGUE': return `CTR has decayed steadily over several days at stable delivery. Classic creative fatigue: the audience has seen the ad too often.`;
    case 'DATA_LAG': return `Most campaigns across ${inc.lag.supplies} supply clusters dropped at the same moment. A cross-platform simultaneous drop is a reporting/ingestion delay, not ${inc.lag.campaigns} real incidents.`;
  }
}
function evidence(inc) {
  const A = inc.A, E = inc.E, w = S.P.persist, out = [];
  const eConv = inc.eConv;
  switch (inc.type) {
    case 'CONV_ZERO':
      out.push(`Conversions: <b>0</b> in the last ${w} h; ${num(eConv)} expected from current clicks (P &lt; ${Math.exp(-eConv).toExponential(0)}).`);
      out.push(`Clicks: ${num(A.clk)} vs ${num(E.clk)} normal (${pct(A.clk / E.clk)}), so traffic is healthy.`);
      break;
    case 'IVT': {
      const ctrR = (A.clk / A.imp) / (E.clk / E.imp), cvrR = A.conv / Math.max(eConv, 1e-9);
      out.push(`CTR: <b>${times(ctrR)}</b> the same-hour norm (z = ${inc.z.toFixed(1)}).`);
      out.push(`Conversion rate: <b>${pct(cvrR)}</b> of normal; conversions flat while clicks jumped.`);
      out.push(`Impressions: ${pct(A.imp / E.imp)} of normal, so the extra clicks did not come from extra reach.`);
      break;
    }
    case 'SPEND_HIGH':
      out.push(`Spend: <b>${money(A.spend / w)}/h</b> vs ${money(E.spend / w)}/h normal (${times(A.spend / E.spend)}, z = ${inc.z.toFixed(1)}).`);
      out.push(`Cost per conversion: ${money(A.spend / Math.max(A.conv, 1))} vs ${money(E.spend / Math.max(E.conv, 1))} normal.`);
      break;
    case 'DELIVERY_DROP':
      out.push(`Impressions: <b>${pct(A.imp / E.imp)}</b> of the same-hour norm (z = ${(-inc.z).toFixed(1)}).`);
      out.push(`Lost delivery: ${money(inc.risk)}/h of spend not served.`);
      break;
    case 'CVR_DROP':
      out.push(`Conversions: <b>${num(A.conv)}</b> vs ${num(eConv)} expected for this traffic (${pct(A.conv / eConv)}, z = ${(-inc.z).toFixed(1)}).`);
      out.push(`Clicks: ${pct(A.clk / E.clk)} of normal; CTR stable.`);
      break;
    case 'FATIGUE':
      out.push(`CTR last 48 h: <b>${pct(inc.ctrNow, 2)}</b> vs ${pct(inc.ctrBefore, 2)} the week before (${pct(1 - inc.ratio)} lower).`);
      out.push(`Delivery steady, so this is engagement decay, not a reach problem.`);
      break;
    case 'DATA_LAG':
      out.push(`${inc.lag.campaigns} campaigns on ${inc.lag.supplies} of ${SUPPLIES.length} supply clusters dropped in the same hour.`);
      out.push(`${inc.lag.held} raw signals held back until the data is complete.`);
      break;
  }
  if (inc.core > 1 && inc.N) out.push(`${inc.core} of ${inc.N} eligible campaigns on this ${DIM_LABEL[inc.dim]} show the pattern; merged into one incident${inc.members.length > inc.core ? `, plus ${inc.members.length - inc.core} related campaign${inc.members.length - inc.core === 1 ? '' : 's'} with a weaker signal` : ''}.`);
  return out;
}
function ruledOut(inc) {
  const o = [];
  if (inc.type === 'CONV_ZERO') { o.push('Delivery problem: impressions and clicks are normal.'); o.push('Platform-wide tracking issue: other pixels are converting normally.'); }
  if (inc.type === 'IVT') { o.push('Genuine demand spike: conversions did not rise with clicks.'); o.push('Advertiser-side change: other supply clusters for the same advertisers are normal.'); }
  if (inc.type === 'SPEND_HIGH') { o.push(S.calendar ? 'Planned event: no calendar entry for this advertiser today.' : 'Planned event: no context-calendar entry for today.'); o.push('Data error: clicks and impressions rose consistently with spend.'); }
  if (inc.type === 'DELIVERY_DROP') { o.push('Reporting delay: other supply clusters are reporting normally.'); o.push('Budget exhaustion: campaigns are below their daily pace.'); }
  if (inc.type === 'CVR_DROP') { o.push('Invalid traffic: CTR is normal.'); o.push('Pixel outage: conversions are low but not zero.'); }
  if (inc.type === 'FATIGUE') o.push('Delivery or bidding change: impressions are stable.');
  if (inc.type === 'DATA_LAG') o.push('Real outage: no single supply, advertiser or pixel explains the drop.');
  return o;
}
function actionsFor(inc) {
  const n = inc.members.length, scope = n > 1 ? `${n} campaigns` : 'this campaign';
  switch (inc.type) {
    case 'CONV_ZERO': return [
      { id: 'bid', label: 'Switch to manual CPC', sub: 'Stops smart bidding from collapsing bids while blind', change: `Bidding on ${scope} switches from target-CPA to manual CPC at the last 7-day average CPC. Auto-reverts when conversions resume.` },
      { id: 'notify', label: 'Notify advertiser', sub: `Send pixel ${inc.dim === 'pixel' ? inc.val : ''} diagnostics`, change: 'Email + in-app message to the advertiser with the pixel ID, last fire time and a tag-checker link.' }];
    case 'IVT': return [
      { id: 'excl', label: `Exclude ${inc.dim === 'supply' ? inc.val : 'source'}`, sub: 'For affected campaigns, 24 h', change: `Supply cluster ${inc.val} is excluded for ${scope} for 24 h. Traffic quality team reviews before re-enabling.` },
      { id: 'refund', label: 'Open IVT claim', sub: 'Auto-attach click evidence', change: 'Creates an invalid-traffic review ticket with click logs, CTR/CVR evidence and the estimated invalid spend for credit.' }];
    case 'SPEND_HIGH': return [
      { id: 'cap', label: 'Cap at 110% of plan', sub: 'Keeps campaigns live', change: `Daily budget on ${scope} is capped at 110% of the planned daily budget for the rest of today.` },
      { id: 'pause', label: `Pause ${scope}`, sub: 'Hard stop', change: `${scope} paused immediately. One-click resume from the audit log.` }];
    case 'DELIVERY_DROP': return [
      { id: 'shift', label: 'Shift budget to healthy supply', sub: 'Protect today\'s delivery', change: `Unspent budget on ${scope} is re-allocated to the other supply clusters these campaigns already run on.` },
      { id: 'page', label: 'Page supply-partner ops', sub: 'Open a partner ticket', change: `Pages the partner-operations on-call for ${inc.val} with the drop chart attached.` }];
    case 'CVR_DROP': return [
      { id: 'pause', label: 'Pause campaign', sub: 'Stop paying for dead clicks', change: `${scope} paused until the landing page passes a health check.` },
      { id: 'lp', label: 'Run landing-page check', sub: 'Synthetic test of the form', change: 'Runs a synthetic visit + form submit on the landing page and attaches the result to this incident.' }];
    case 'FATIGUE': return [
      { id: 'rotate', label: 'Rotate creative', sub: 'Suggest top 2 alternatives', change: 'Swaps in the two best-performing alternate creatives from the advertiser library and lowers frequency cap to 3/day.' }];
    case 'DATA_LAG': return [];
  }
  return [];
}
const EXPECTED_ACTION = { id: 'expected', label: 'Mark as expected', sub: 'Teaches the context calendar', change: 'Incident is closed as "expected". The pattern is added to the context calendar for this advertiser so it will not alert again.' };

/* ============================== render ============================== */
function render() {
  renderClock(); renderKPIs(); renderBanner(); renderScenarios(); renderList(); renderNoise(); renderDetail();
  if (S.tab === 'notify') renderNotify();
}
function renderClock() {
  $('#clock').innerHTML = `<span class="live-dot"></span>Data through <b>${tLabel(NOW + 1)}</b><br><span class="small">Simulated: ${CS.length} campaigns · ${ADVERTISERS.length} advertisers · ${SUPPLIES.length} supply clusters</span>`;
}
function openList() { return S.res.list.filter(i => !S.status[i.key]); }
function renderKPIs() {
  const open = openList();
  const cnt = s => open.filter(i => i.sev === s).length;
  let spend = 0, spendE = 0;
  for (const c of CS) for (let i = at(14, 0); i <= NOW; i++) { spend += c.spend[i]; spendE += c.med.spend[i]; }
  const risk = open.reduce((s, i) => s + (i.sev !== 'Info' ? i.risk : 0), 0);
  const inc = open.filter(i => i.sev !== 'Info').length;
  const cut = S.res.naive ? 1 - inc / S.res.naive : 0;
  $('#kpis').innerHTML = `
    <div class="kpi"><div class="l">Campaigns monitored</div><div class="v">${CS.length}</div><div class="s">${S.res.eligible} with enough volume to judge</div></div>
    <div class="kpi"><div class="l">Spend today</div><div class="v">${money(spend)}</div><div class="s">${pct(spend / spendE)} of same-hours norm</div></div>
    <div class="kpi ${cnt('P1') ? 'hl' : ''}"><div class="l">Open incidents</div><div class="v">${inc}</div><div class="s"><span class="chip P1">P1 ${cnt('P1')}</span> <span class="chip P2">P2 ${cnt('P2')}</span> <span class="chip P3">P3 ${cnt('P3')}</span></div></div>
    <div class="kpi ${risk > 0 ? 'hl' : ''}"><div class="l">$ at risk per hour</div><div class="v">${money(risk)}</div><div class="s">Across open incidents</div></div>
    <div class="kpi good"><div class="l">Alert noise removed</div><div class="v">${pct(cut, 1)}</div><div class="s">${num(S.res.naive)} naive alerts → ${inc} incidents today</div></div>`;
}
function renderBanner() {
  const b = [];
  if (S.res.lag) b.push(`<div class="banner warn">⏸ <div><b>Data-freshness guard is holding alerts.</b> The latest 2 hours of reporting are incomplete across ${S.res.lag.supplies} supply clusters. ${S.res.lag.held} new delivery/conversion signals are on hold instead of paging the team ${S.res.lag.campaigns} times. Open incidents are judged on the last complete data (through ${hh(S.res.evalAt + 1)}) and stay active.</div></div>`);
  if (!S.P.freshness && S.live.includes('DELAY')) b.push(`<div class="banner bad">⚠ <div><b>Freshness guard is off.</b> The reporting delay is being treated as real outages. Watch the incident list fill with false alarms, then switch the guard back on.</div></div>`);
  if (S.calendar && S.res.suppressed.length) b.push(`<div class="banner info">📅 <div><b>Context calendar:</b> Retail sale day. ${S.res.suppressed.length} Retail campaigns are spending ${times(avgRatio(S.res.suppressed))} normal with healthy cost per conversion, so they are treated as expected. Campaigns whose efficiency breaks still alert.</div></div>`);
  if (!S.calendar && S.live.includes('SALE')) b.push(`<div class="banner info">💡 <div>A planned Retail sale is running but is not on the context calendar, so Pulse flags it. Tick <b>Context calendar</b> in the scenario lab to see the false alarms disappear.</div></div>`);
  $('#banner').innerHTML = b.join('');
}
const avgRatio = rs => rs.reduce((s, r) => s + r.A.spend, 0) / rs.reduce((s, r) => s + r.E.spend, 0);
function renderScenarios() {
  const keys = ['PIXEL_SHOP', 'IVT_SPORTS', 'FATIGUE', 'RUNAWAY', 'FILL', 'CPA', 'DELAY', 'SALE'];
  $('#scenarios').innerHTML = keys.map(k => `<button class="sbtn ${S.live.includes(k) ? 'on' : ''}" data-sc="${k}"><b>${S.live.includes(k) ? '● ' : ''}${SCENARIOS[k].label}</b><span>${SCENARIOS[k].sub}</span></button>`).join('') +
    `<button class="sbtn reset" data-sc="RESET">Reset to default morning</button>`;
  $('#tgCal').checked = S.calendar; $('#tgFresh').checked = S.P.freshness;
}
function sevChip(s) { return `<span class="chip ${s}">${s === 'Info' ? 'INFO' : s}</span>`; }
function renderList() {
  const L = S.res.list;
  const open = L.filter(i => !S.status[i.key]), done = L.filter(i => S.status[i.key]);
  $('#incCount').textContent = `${open.length} open · ${S.res.rawSignals} raw signals`;
  const item = i => `<div class="inc ${S.sel === i.key ? 'sel' : ''} ${S.status[i.key] ? 'done' : ''}" data-key="${esc(i.key)}">
      <div class="row-between">${sevChip(i.sev)}${S.status[i.key] ? `<span class="chip ok">✓ ${esc(S.status[i.key].label)}</span>` : `<span class="small muted">${TYPES[i.type].short}</span>`}</div>
      <div class="t">${esc(incTitle(i))}</div>
      <div class="m">${i.sev !== 'Info' ? `<span><b>${money(i.risk)}</b>/h at risk</span>` : '<span>Alerts held</span>'}<span>${i.members.length || 'All'} campaign${i.members.length === 1 ? '' : 's'}</span><span>since ${since(i.onset)}</span></div>
    </div>`;
  $('#incList').innerHTML = (open.length ? open.map(item).join('') : '<div class="empty">No open incidents. Inject a scenario to see Pulse react.</div>') +
    (done.length ? `<div class="small muted" style="margin-top:12px">Handled</div>${done.map(item).join('')}` : '');
}
function renderNoise() {
  const inc = openList().filter(i => i.sev !== 'Info').length;
  $('#noise').innerHTML = `<h3>Why incidents, not alerts</h3>
    <div class="small muted">Today, a static "±30% vs yesterday" rule would have fired</div>
    <div class="big"><span class="a">${num(S.res.naive)}</span><span class="muted">→</span><span class="b">${inc}</span><span class="small muted">incidents</span></div>
    <div class="small muted">Pulse compares each hour with the same hour over the last 7 days, ignores low-volume campaigns, waits for ${S.P.persist} h of persistence and merges campaigns that share a root cause.</div>`;
}

function renderDetail() {
  const inc = S.res.list.find(i => i.key === S.sel);
  if (chart) { chart.destroy(); chart = null; }
  if (!inc) { $('#detail').innerHTML = '<div class="empty" style="padding:80px 20px"><h3>All clear</h3>No incident selected. Use the scenario lab to inject a failure.</div>'; return; }
  const st = S.status[inc.key];
  const ttd = inc.alertedAt - inc.onset + 1;
  const route = routeFor(inc.sev);
  const acts = actionsFor(inc);
  const fb = S.fb[inc.key];
  const members = inc.members.slice(0, 40);
  const w = S.P.persist;
  $('#detail').innerHTML = `
    <div class="dh">
      <div>${sevChip(inc.sev)} <span class="chip ghost">${TYPES[inc.type].label}</span> ${st ? `<span class="chip ok">✓ ${esc(st.label)} at ${st.at}</span>` : ''}
        <h2>${esc(incTitle(inc))}</h2>
        <div class="muted">${esc(rootCause(inc))}</div>
      </div>
    </div>
    <div class="facts">
      <div class="fact"><div class="l">${inc.type === 'DELIVERY_DROP' ? 'Revenue lost' : inc.type === 'CONV_ZERO' ? 'Spend flying blind' : '$ at risk'}</div><div class="v">${inc.sev === 'Info' ? '-' : money(inc.risk) + '/h'}</div><div class="s">${riskDef(inc.type)}</div></div>
      <div class="fact"><div class="l">Confidence</div><div class="v">${inc.z != null ? confTxt(inc.conf) : inc.type === 'FATIGUE' ? 'High' : 'High'}</div><div class="s">${inc.z != null ? `z = ${Math.abs(inc.z).toFixed(1)} vs threshold ${S.P.k}` : 'Pattern-based'}</div></div>
      <div class="fact"><div class="l">Scope</div><div class="v">${inc.members.length || 'All'}</div><div class="s">campaign${inc.members.length === 1 ? '' : 's'} · grouped by ${DIM_LABEL[inc.dim] || 'platform'}</div></div>
      <div class="fact"><div class="l">Started</div><div class="v">${since(inc.onset)}</div><div class="s">${ago(NOW - inc.onset)} (estimated)</div></div>
      <div class="fact"><div class="l">Detected in</div><div class="v">${ttd} h</div><div class="s">alerted with ${hh(inc.alertedAt + 1)} data</div></div>
    </div>
    <div class="grid2">
      <div>
        <div class="sec" style="margin-top:0"><h4>${chartTitle(inc)}</h4><div class="chartbox"><canvas id="incChart"></canvas></div></div>
      </div>
      <div>
        <div class="sec" style="margin-top:0"><h4>Why Pulse thinks this</h4><ul class="ev">${evidence(inc).map(e => `<li>${e}</li>`).join('')}</ul></div>
        <div class="sec"><h4>Ruled out</h4><ul class="ev neg">${ruledOut(inc).map(e => `<li>${e}</li>`).join('')}</ul></div>
      </div>
    </div>
    ${acts.length ? `<div class="sec"><h4>Recommended actions · human-approved, reversible</h4><div class="actions">
      ${acts.map((a, j) => `<button class="btn ${j === 0 ? 'primary' : ''}" data-act="${a.id}" ${st ? 'disabled' : ''}>${esc(a.label)}<small>${esc(a.sub)}</small></button>`).join('')}
      <button class="btn" data-act="expected" ${st ? 'disabled' : ''}>Mark as expected<small>Teaches the calendar</small></button>
      <button class="btn" data-act="snooze" ${st ? 'disabled' : ''}>Snooze 1 h<small>Re-alerts if it worsens</small></button>
    </div></div>` : ''}
    ${inc.members.length ? `<div class="sec"><h4>Affected campaigns (${inc.members.length})</h4><div class="tbl-wrap"><table>
      <thead><tr><th>Campaign</th><th>Channel</th><th>Supply</th><th>Pixel</th><th class="n">Spend/h now</th><th class="n">Normal</th><th class="n">${TYPES[inc.type].metric === 'conv' ? 'Conv. now / exp.' : TYPES[inc.type].metric === 'imp' ? 'Impr. vs normal' : 'Clicks vs normal'}</th></tr></thead>
      <tbody>${members.map(c => memberRow(c, inc, w)).join('')}</tbody></table></div></div>` : ''}
    <div class="grid2">
      <div class="sec"><h4>Notification trail</h4><div class="trail">${route.map(r => `<div><span class="tm">${r.t}</span><span>${r.txt}</span></div>`).join('')}</div></div>
      <div class="sec"><h4>Was this alert useful?</h4>
        <div class="fb"><button data-fb="up" class="${fb === 'up' ? 'on' : ''}">👍 Useful</button><button data-fb="down" class="${fb === 'down' ? 'on' : ''}">👎 Not useful</button>
        <span class="small muted">${fb ? 'Thanks. Feedback tunes this rule\'s threshold for this account.' : 'One tap. Feeds the precision metric and auto-tuning.'}</span></div>
        ${S.log.length ? `<div class="sec"><h4>Audit log</h4><div class="trail">${S.log.slice(-5).reverse().map(l => `<div><span class="tm">${l.at}</span><span>${esc(l.txt)}</span></div>`).join('')}</div></div>` : ''}
      </div>
    </div>`;
  drawIncidentChart(inc);
}
function riskDef(type) {
  return { CONV_ZERO: 'spend/h with no conversion signal', SPEND_HIGH: 'spend/h above the norm', IVT: 'suspected invalid spend/h', DELIVERY_DROP: 'unserved spend/h', CVR_DROP: 'spend/h on non-converting clicks', FATIGUE: 'lost click value/h', DATA_LAG: '' }[type];
}
function memberRow(c, inc, w) {
  let A = { imp: 0, clk: 0, spend: 0, conv: 0 }, E = { imp: 0, clk: 0, spend: 0, conv: 0 };
  for (let i = NOW - w + 1; i <= NOW; i++) for (const m of METRICS) { A[m] += c[m][i]; E[m] += c.med[m][i]; }
  const m = TYPES[inc.type].metric;
  let last;
  if (m === 'conv') { const e = A.clk * cvrBase(c, NOW); last = `<span class="${A.conv < 0.5 * e ? 'down' : ''}">${num(A.conv)} / ${num(e)}</span>`; }
  else if (m === 'imp') { const r = A.imp / Math.max(E.imp, 1); last = `<span class="${r < 0.6 ? 'down' : ''}">${pct(r)}</span>`; }
  else { const r = A.clk / Math.max(E.clk, 1); last = `<span class="${r > 1.4 ? 'up' : r < 0.6 ? 'down' : ''}">${pct(r)}</span>`; }
  const sr = A.spend / Math.max(E.spend, 1);
  return `<tr><td><b>${esc(c.adv)}</b> · ${esc(c.name)} <span class="muted small">${c.id} · ${c.geo}</span></td><td>${c.channel}</td><td>${c.supply}</td><td class="mono small">${c.pixel}</td>
    <td class="n ${sr > 1.4 ? 'up' : sr < 0.6 ? 'down' : ''}">${money(A.spend / w)}</td><td class="n">${money(E.spend / w)}</td><td class="n">${last}</td></tr>`;
}
function chartTitle(inc) {
  return { CONV_ZERO: 'Conversions vs expected band (affected campaigns)', IVT: 'Clicks vs expected band (affected campaigns)', SPEND_HIGH: 'Spend per hour vs expected band', DELIVERY_DROP: 'Impressions vs expected band', CVR_DROP: 'Conversions vs expected band', FATIGUE: 'Daily CTR, last 14 days', DATA_LAG: 'Platform impressions vs expected band' }[inc.type];
}
function drawIncidentChart(inc) {
  const ctx = $('#incChart'); if (!ctx || typeof Chart === 'undefined') return;
  const k = S.P.k, od = S.P.od;
  if (inc.type === 'FATIGUE') {
    const c = inc.members[0], labels = [], data = [];
    for (let d = 0; d <= 14; d++) {
      let cl = 0, im = 0;
      for (let i = 0; i <= NOW; i++) if (dayIdx(i) === d) { cl += c.clk[i]; im += c.imp[i]; }
      if (im > 0) { labels.push(dLabel(at(d, 12))); data.push(+(cl / im * 100).toFixed(2)); }
    }
    chart = new Chart(ctx, { type: 'line', data: { labels, datasets: [{ label: 'CTR %', data, borderColor: '#1570ef', backgroundColor: 'rgba(21,112,239,.1)', fill: true, tension: .3, pointRadius: 2 }] }, options: baseOpts('CTR %') });
    return;
  }
  const m = TYPES[inc.type].metric, mem = inc.members.length ? inc.members : CS;
  const labels = [], act = [], exp = [], lo = [], hi = [];
  for (let i = NOW - 47; i <= NOW; i++) {
    let a = 0, e = 0;
    for (const c of mem) { a += c[m][i]; e += c.med[m][i]; }
    const sd = m === 'spend' ? Math.sqrt(e * 1 + (od * e) ** 2) : Math.sqrt(Math.max(e, 1) + (od * e) ** 2);
    labels.push(hod(i) === 0 ? dLabel(i) : hh(i)); act.push(+a.toFixed(1)); exp.push(+e.toFixed(1)); lo.push(Math.max(0, +(e - 2 * sd).toFixed(1))); hi.push(+(e + 2 * sd).toFixed(1));
  }
  const on = inc.onset - (NOW - 47);
  const red = inc.sev === 'P1' ? '#d92d20' : inc.sev === 'P2' ? '#dc6803' : inc.sev === 'Info' ? '#667085' : '#1570ef';
  chart = new Chart(ctx, {
    type: 'line',
    data: {
      labels, datasets: [
        { label: 'Lower band', data: lo, borderWidth: 0, pointRadius: 0, fill: false },
        { label: 'Normal range (±2σ per hour)', data: hi, borderWidth: 0, pointRadius: 0, fill: '-1', backgroundColor: 'rgba(22,163,74,.12)' },
        { label: 'Expected (7-day same-hour median)', data: exp, borderColor: '#16a34a', borderDash: [5, 4], borderWidth: 1.5, pointRadius: 0, fill: false },
        { label: 'Actual', data: act, borderColor: '#101828', borderWidth: 2, pointRadius: 0, fill: false, segment: { borderColor: c => c.p0DataIndex >= on ? red : '#101828' } }
      ]
    },
    options: baseOpts({ conv: 'Conversions', clk: 'Clicks', spend: 'Spend ($)', imp: 'Impressions' }[m])
  });
}
function baseOpts(y) {
  return {
    responsive: true, maintainAspectRatio: false, animation: { duration: 250 }, interaction: { mode: 'index', intersect: false },
    plugins: { legend: { labels: { boxWidth: 10, font: { size: 11 }, filter: i => i.text !== 'Lower band' } }, tooltip: { filter: i => i.dataset.label !== 'Lower band' } },
    scales: { x: { ticks: { maxTicksLimit: 8, font: { size: 10 } }, grid: { display: false } }, y: { beginAtZero: true, title: { display: true, text: y, font: { size: 11 } }, ticks: { font: { size: 10 } } } }
  };
}

/* ============================== notifications ============================== */
const ROUTING = {
  P1: { chan: 'Slack #adops-oncall + SMS/push to on-call account manager', when: 'Immediately (within 15 min of the data landing)', esc: 'Escalate to team lead if not acknowledged in 30 min; re-notify every 30 min', quiet: 'Always delivered, even in quiet hours' },
  P2: { chan: 'Slack #adops-alerts + in-app + email', when: 'Immediately in working hours', esc: 'Escalate if open > 4 h', quiet: 'Batched to 07:00 during quiet hours (22:00-07:00)' },
  P3: { chan: 'Daily digest email + in-app inbox', when: '09:00 local, once a day', esc: 'None; auto-close if it clears for 24 h', quiet: 'n/a' },
  Info: { chan: 'In-app banner only', when: 'While the condition lasts', esc: 'Escalate as P2 if the delay exceeds 4 h', quiet: 'n/a' }
};
function routeFor(sev) {
  const t0 = hh(NOW + 1).replace(':00', ':0') ;
  const base = `${String(hod(NOW + 1)).padStart(2, '0')}:`;
  if (sev === 'P1') return [{ t: base + '02', txt: '🔴 Slack #adops-oncall, threaded (one thread per incident)' }, { t: base + '02', txt: '📱 SMS + push to on-call account manager' }, { t: base + '32', txt: '⏫ Escalates to team lead if not acknowledged' }];
  if (sev === 'P2') return [{ t: base + '02', txt: '🟠 Slack #adops-alerts + in-app' }, { t: base + '05', txt: '✉️ Email to campaign owner' }, { t: '+4 h', txt: '⏫ Escalates if still open' }];
  if (sev === 'P3') return [{ t: '09:00', txt: '🔵 Tomorrow\'s daily digest + in-app inbox' }, { t: '—', txt: 'No interruption: slow-moving issue' }];
  return [{ t: base + '00', txt: '⏸ Banner only; dependent alerts held until data is complete' }];
}
function renderNotify() {
  const inc = S.res.list.find(i => i.key === S.sel) || S.res.list[0];
  const p3 = S.res.list.filter(i => i.sev === 'P3');
  const sel = inc ? `${sevChip(inc.sev)} ${esc(incTitle(inc))}` : 'none';
  $('#tab-notify').innerHTML = `
    <div class="card"><h3>Routing policy: severity decides channel, urgency and escalation</h3>
      <p class="muted small" style="margin:0 0 10px">Severity = <b>$ at risk per hour × confidence</b>. P1 ≥ ${money(S.P.p1)}/h, P2 ≥ ${money(S.P.p2)}/h, otherwise P3. One incident = one thread; updates go into the thread, never as new pages.</p>
      <table><thead><tr><th>Severity</th><th>Channel</th><th>When</th><th>Escalation</th><th>Quiet hours</th></tr></thead>
      <tbody>${['P1', 'P2', 'P3', 'Info'].map(s => `<tr><td>${sevChip(s)}</td><td>${ROUTING[s].chan}</td><td>${ROUTING[s].when}</td><td>${ROUTING[s].esc}</td><td>${ROUTING[s].quiet}</td></tr>`).join('')}</tbody></table>
    </div>
    <div class="three" style="margin-top:16px">
      <div class="card"><h3>Slack preview</h3><p class="small muted">Selected: ${sel}</p>${inc ? slackCard(inc) : ''}</div>
      <div class="card"><h3>SMS / push (P1 only)</h3><p class="small muted">Short, actionable, links to the incident.</p>${inc && inc.sev === 'P1' ? `<div class="sms">PULSE P1: ${esc(incTitle(inc))}. ${money(inc.risk)}/h at risk, ${inc.members.length} campaigns. Ack: pulse.app/i/${(inc.key.length * 7919 % 9000 + 1000)}</div>` : '<div class="empty">Selected incident is not P1, so no SMS is sent.</div>'}</div>
      <div class="card"><h3>Daily digest (P3)</h3><p class="small muted">09:00 email. Slow issues never interrupt anyone.</p>
        ${p3.length ? `<table><tbody>${p3.map(i => `<tr><td>${esc(incTitle(i))}</td><td class="n">${money(i.risk)}/h</td></tr>`).join('')}</tbody></table>` : '<div class="empty">Nothing for the digest today.</div>'}</div>
    </div>
    <div class="two" style="margin-top:16px">
      <div class="card prose"><h3>Anti-fatigue rules</h3><ul>
        <li><b>Deduplicate by root cause:</b> one pixel outage on 9 campaigns is 1 incident, not 9 alerts.</li>
        <li><b>Persistence:</b> a signal must hold for ${S.P.persist} h before it alerts (single-hour blips are ignored).</li>
        <li><b>Minimum volume:</b> campaigns expecting under ${S.P.minClicks} clicks/h are not judged hourly.</li>
        <li><b>Auto-resolve</b> after 3 clean hours, with a resolution note in the thread.</li>
        <li><b>Snooze</b> re-alerts only if $ at risk grows by 50%.</li>
        <li><b>Budget:</b> target under 3 interrupts per account manager per day; tracked as a guardrail metric.</li></ul></div>
      <div class="card prose"><h3>Who gets what</h3><ul>
        <li><b>Campaign owner / account manager:</b> all incidents on their accounts.</li>
        <li><b>Ad-ops on-call:</b> P1 only, across all accounts.</li>
        <li><b>Traffic-quality team:</b> every invalid-traffic incident (for exclusions and credits).</li>
        <li><b>Supply-partner ops:</b> delivery drops grouped by supply cluster.</li>
        <li><b>Advertiser (opt-in):</b> pixel/tracking incidents with a self-serve tag checker.</li></ul></div>
    </div>`;
}
function slackCard(inc) {
  const acts = actionsFor(inc);
  return `<div class="slack"><div class="who"><div class="av"><svg viewBox="0 0 32 32" width="20" height="20"><path d="M4 17h6l3-8 5 15 3-7h7" stroke="#22c55e" stroke-width="3" fill="none" stroke-linecap="round"/></svg></div><div><b>Pulse</b> <span class="small muted">APP · ${hh(NOW + 1).slice(0, 3)}02</span></div></div>
    <div>${inc.sev === 'P1' ? '🔴' : inc.sev === 'P2' ? '🟠' : inc.sev === 'P3' ? '🔵' : '⏸'} <b>${inc.sev} · ${esc(incTitle(inc))}</b></div>
    <div class="small" style="margin-top:4px">${inc.sev !== 'Info' ? `<b>${money(inc.risk)}/h</b> at risk · ` : ''}${inc.members.length || 'all'} campaigns${inc.z != null ? ` · ${confTxt(inc.conf)} confidence` : ''}</div>
    <div class="small muted" style="margin-top:4px">${esc(rootCause(inc))}</div>
    <div class="bt">${acts.slice(0, 2).map(a => `<span>${esc(a.label)}</span>`).join('')}<span>Acknowledge</span><span>Snooze 1h</span></div></div>`;
}

/* ============================== thresholds & backtest ============================== */
const SLIDERS = [
  { k: 'k', label: 'Sensitivity threshold (z)', min: 1.5, max: 5, step: 0.25, fmt: v => v.toFixed(2), help: 'How unusual a group must be to alert. Lower = catch more, more noise.' },
  { k: 'persist', label: 'Persistence (hours)', min: 1, max: 3, step: 1, fmt: v => v + ' h', help: 'Signal must hold this long. Higher = fewer blips, slower detection.' },
  { k: 'minClicks', label: 'Minimum volume (expected clicks/h)', min: 2, max: 30, step: 1, fmt: v => v, help: 'Below this, a campaign is too small to judge hourly.' },
  { k: 'minRisk', label: 'Materiality floor ($ at risk/h)', min: 0, max: 100, step: 5, fmt: v => money(v), help: 'Issues smaller than this are not worth anyone’s attention as an incident.' },
  { k: 'p1', label: 'P1 floor ($ at risk/h × confidence)', min: 200, max: 3000, step: 100, fmt: v => money(v), help: 'Pages on-call. Set to what is worth waking someone for.' },
  { k: 'p2', label: 'P2 floor', min: 50, max: 600, step: 25, fmt: v => money(v), help: 'Real-time Slack/in-app. Below this goes to the daily digest.' }
];
function renderTune() {
  $('#tab-tune').innerHTML = `<div class="tune-grid">
    <div class="card"><h3>Trigger thresholds</h3><p class="small muted" style="margin-top:0">Every change re-runs a backtest on 6 days of history with ${HIST_EVENTS.length} known, labelled incidents.</p>
      ${SLIDERS.map(s => `<div class="sl"><label>${s.label}<span id="v_${s.k}">${s.fmt(S.P[s.k])}</span></label><input type="range" min="${s.min}" max="${s.max}" step="${s.step}" value="${S.P[s.k]}" data-sl="${s.k}"><p>${s.help}</p></div>`).join('')}
      <button class="btn" id="btReset">Restore recommended defaults</button>
      <p class="small muted" style="margin-top:12px">Changes also apply to the live view.</p>
    </div>
    <div>
      <div class="card"><h3>Backtest results</h3><div class="mcards" id="btCards"></div></div>
      <div class="card" style="margin-top:16px"><div class="row-between"><h3>The trade-off: catch rate vs noise</h3><span class="small muted">each point = one sensitivity setting</span></div>
        <div class="chartbox" style="height:260px"><canvas id="btChart"></canvas></div>
        <p class="small muted" style="margin:8px 0 0">Recommended default <b>z = 3.5</b>: the knee of the curve. Every labelled incident is caught with almost no false alarms; going lower buys nothing but noise, going higher starts missing real incidents.</p></div>
      <div class="card" style="margin-top:16px"><h3>Known incidents in the backtest window</h3><div class="tbl-wrap" style="max-height:none"><table id="btTable"></table></div></div>
    </div></div>`;
  runBacktest(true);
}
function runBacktest(withCurve) {
  const P = S.P;
  const bt = backtest(P); S.bt = bt;
  $('#btCards').innerHTML = `
    <div class="mc"><div class="l">Recall</div><div class="v">${pct(bt.recall)}</div><div class="s">${bt.truth.filter(e => e.hit !== null).length}/${bt.truth.length} real incidents caught</div></div>
    <div class="mc"><div class="l">Precision</div><div class="v">${pct(bt.precision)}</div><div class="s">${bt.tp}/${bt.alerts.length} incidents were real</div></div>
    <div class="mc"><div class="l">Median time to detect</div><div class="v">${bt.ttdMed != null ? bt.ttdMed + ' h' : '-'}</div><div class="s">from onset, hourly data</div></div>
    <div class="mc"><div class="l">Incidents / week</div><div class="v">${bt.perWeek.toFixed(0)}</div><div class="s">across ${CS.length} campaigns</div></div>
    <div class="mc"><div class="l">Naive rule / week</div><div class="v" style="color:var(--p1)">${num(bt.naivePerWeek)}</div><div class="s">±30% vs yesterday · ${pct(bt.naivePrecision)} real</div></div>`;
  $('#btTable').innerHTML = `<thead><tr><th>When</th><th>What happened</th><th>Pulse type</th><th>Caught?</th><th class="n">Detected in</th></tr></thead><tbody>${bt.truth.map(e => `<tr><td>${tLabel(e.s)}</td><td>${esc(e.what)} <span class="muted small">(${resolveScope(e.scope).length} campaigns)</span></td><td>${TYPES[e.hitType || FAMILY[e.type]].short}</td><td>${e.hit !== null ? `<span class="okc">✓ ${e.hitSev}</span>` : '<span class="down">✗ missed</span>'}</td><td class="n">${e.hit !== null ? (e.hit - e.s + 1) + ' h' : '-'}</td></tr>`).join('')}</tbody>`;
  if (withCurve || !S.curve) {
    const ks = [1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5];
    S.curve = ks.map(k => { const b = backtest({ ...P, k }); return { k, recall: b.recall, precision: b.precision, perWeek: b.perWeek }; });
  }
  drawCurve();
}
function drawCurve() {
  const el = $('#btChart'); if (!el || typeof Chart === 'undefined') return;
  if (btChart) btChart.destroy();
  const cur = S.curve;
  btChart = new Chart(el, {
    type: 'line',
    data: {
      labels: cur.map(p => 'z=' + p.k),
      datasets: [
        { label: 'Recall (real incidents caught)', data: cur.map(p => +(p.recall * 100).toFixed(0)), borderColor: '#16a34a', backgroundColor: '#16a34a', yAxisID: 'y', tension: .25, pointRadius: cur.map(p => p.k === S.P.k ? 6 : 3) },
        { label: 'Precision (alerts that were real)', data: cur.map(p => +(p.precision * 100).toFixed(0)), borderColor: '#1570ef', backgroundColor: '#1570ef', yAxisID: 'y', tension: .25, pointRadius: cur.map(p => p.k === S.P.k ? 6 : 3) },
        { label: 'Incidents per week', data: cur.map(p => +p.perWeek.toFixed(1)), borderColor: '#dc6803', backgroundColor: 'rgba(220,104,3,.15)', type: 'bar', yAxisID: 'y2' }
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false, animation: { duration: 200 }, interaction: { mode: 'index', intersect: false },
      plugins: { legend: { labels: { boxWidth: 10, font: { size: 11 } } } },
      scales: { y: { min: 0, max: 100, title: { display: true, text: '%' } }, y2: { position: 'right', beginAtZero: true, grid: { display: false }, title: { display: true, text: 'incidents / week' } }, x: { grid: { display: false } } }
    }
  });
}

/* ============================== how it works ============================== */
function renderHow() {
  $('#tab-how').innerHTML = `
    <div class="card"><h3>Pipeline: from raw metrics to one actionable incident</h3>
      <div class="flow">
        ${[['1', 'Ingest', 'Hourly impressions, clicks, spend, conversions per campaign'], ['2', 'Freshness guard', 'Hold alerts if reporting is late or partial'], ['3', 'Baseline', 'Same hour, last 7 days, median (handles daily & weekly cycles)'], ['4', 'Trigger rules', '5 failure signatures, z-scored with volume floors'], ['5', 'Context', 'Calendar removes planned surges (sales, launches)'], ['6', 'Group', 'Merge by shared pixel / supply / advertiser'], ['7', 'Score', '$ at risk/h × confidence → P1 / P2 / P3'], ['8', 'Route & act', 'Right channel, human-approved one-click fix'], ['9', 'Learn', '👍/👎 feedback tunes thresholds per account']]
        .map(([k, b, t]) => `<div class="step"><div class="k">STEP ${k}</div><b>${b}</b>${t}</div>`).join('')}
      </div></div>
    <div class="card" style="margin-top:16px"><h3>Trigger rules and default thresholds</h3>
      <table><thead><tr><th>Incident type</th><th>Trigger (all must hold)</th><th>Threshold</th><th>Grouped by</th><th>$ at risk</th></tr></thead><tbody>
        <tr><td><b>Conversion tracking loss</b></td><td>Conversions = 0 while clicks ≥ 50% of normal</td><td>Zero where ≥ k² conversions were expected (about 12 at k = 3.5, P &lt; 0.001%)</td><td>Pixel → advertiser</td><td>Spend/h flowing with no conversion signal</td></tr>
        <tr><td><b>Suspected invalid traffic</b></td><td>CTR ≥ 1.6× normal and conversion rate ≤ 0.65× normal</td><td>z ≥ k on clicks, given impressions</td><td>Supply cluster</td><td>Excess clicks × CPC</td></tr>
        <tr><td><b>Spend runaway</b></td><td>Spend ≥ 1.5× same-hour norm</td><td>z ≥ k on clicks</td><td>Advertiser → supply</td><td>Spend above norm</td></tr>
        <tr><td><b>Delivery drop</b></td><td>Impressions ≤ 0.5× same-hour norm</td><td>z ≤ −k</td><td>Supply → advertiser</td><td>Unserved spend (Media.net revenue)</td></tr>
        <tr><td><b>Conversion-rate collapse</b></td><td>Conversion rate ≤ 0.5× normal, traffic normal</td><td>z ≤ −k on conversions</td><td>Advertiser</td><td>Spend × (1 − CVR ratio)</td></tr>
        <tr><td><b>Creative fatigue</b></td><td>48 h CTR ≤ 0.75× prior week, delivery stable</td><td>≥ 300 clicks in 48 h</td><td>Campaign</td><td>Lost clicks × CPC (P3 digest)</td></tr>
      </tbody></table>
      <p class="small muted" style="margin:10px 0 0">Guards on every rule: minimum volume (${S.P.minClicks} expected clicks/h), persistence (${S.P.persist} h), materiality floor (${money(S.P.minRisk)}/h at risk), freshness guard, context calendar. Campaign-level signals use a looser 0.6k threshold; an incident fires only when the grouped total clears k, so shared root causes surface early while single-campaign noise does not.</p></div>
    <div class="how-grid">
      <div class="card prose"><h3>Key product decisions</h3><ul>
        <li><b>Incidents, not alerts.</b> The unit of work is a root cause. Alert fatigue is why most alerting tools get muted.</li>
        <li><b>Money-ranked.</b> Severity is $ at risk per hour × confidence, so a big account's outage outranks noise on a tiny one.</li>
        <li><b>Statistics before ML.</b> Same-hour medians and z-scores are explainable, cheap and need no training data. ML (seasonal forecasting, learned thresholds) comes after we have feedback labels.</li>
        <li><b>Human-approved actions.</b> Every fix is one click, scoped and reversible. Autonomy is earned rule by rule once precision is proven.</li>
        <li><b>Explain and rule out.</b> Each incident says why, and what it is not. Trust comes from showing the reasoning.</li></ul></div>
      <div class="card prose"><h3>Success metrics</h3><ul>
        <li><b>North star:</b> $ protected per account per month (wasted spend stopped + delivery recovered), measured against the backtest counterfactual.</li>
        <li><b>Quality:</b> precision ≥ 70% (👍 rate), recall ≥ 90% on labelled incidents.</li>
        <li><b>Speed:</b> median time to detect ≤ 2 h; time to mitigate ≤ 30 min for P1.</li>
        <li><b>Guardrails:</b> under 3 interrupts per account manager per day; mute/disable rate under 5%.</li>
        <li><b>Business:</b> make-good credits and refund disputes down; retention of managed accounts up.</li></ul></div>
      <div class="card prose"><h3>Rollout</h3><ul>
        <li><b>Week 0-2, replay:</b> run on 90 days of history; tune thresholds per vertical to hit the precision/recall targets.</li>
        <li><b>Week 3-4, shadow:</b> live but silent; account managers rate incidents in a daily review.</li>
        <li><b>Week 5-8, beta:</b> 20% of managed accounts, randomised by account; compare time-to-detect and $ lost vs control.</li>
        <li><b>Week 9+, GA:</b> all accounts, then self-serve advertisers with simplified P1-only alerts.</li></ul></div>
      <div class="card prose"><h3>Edge cases handled</h3><ul>
        <li><b>Late or partial data:</b> freshness guard (try "Reporting delay").</li>
        <li><b>Planned spikes:</b> context calendar (try "Retail sale surge").</li>
        <li><b>Small campaigns:</b> minimum-volume floor; judged daily instead of hourly.</li>
        <li><b>Daily and weekly cycles:</b> same-hour baseline over 7 days.</li>
        <li><b>Past anomalies in the baseline:</b> median, not mean.</li>
        <li><b>Several issues at once:</b> each root cause becomes its own incident.</li></ul></div>
    </div>`;
}

/* ============================== interactions ============================== */
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), 2600); }
function nowStamp() { const d = new Date(); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); }
function confirmAction(inc, a) {
  const m = $('#modal');
  m.innerHTML = `<div class="mbox"><h3>${esc(a.label)}?</h3><p class="muted small" style="margin-top:0">${esc(incTitle(inc))}</p>
    <ul><li>${esc(a.change)}</li><li>Logged to the audit trail with your name; reversible in one click.</li>${inc.members.length ? `<li>Applies to ${inc.members.length} campaign${inc.members.length === 1 ? '' : 's'}: ${inc.members.slice(0, 4).map(c => esc(c.adv + ' · ' + c.name)).join(', ')}${inc.members.length > 4 ? '…' : ''}</li>` : ''}</ul>
    <div class="row"><button class="btn" data-m="cancel">Cancel</button><button class="btn primary" data-m="ok">Approve</button></div></div>`;
  m.classList.remove('hidden');
  m.onclick = e => {
    const b = e.target.closest('[data-m]'); if (!b && e.target !== m) return;
    m.classList.add('hidden');
    if (b && b.dataset.m === 'ok') {
      const label = a.id === 'expected' ? 'Marked expected' : a.id === 'snooze' ? 'Snoozed 1 h' : 'Mitigated';
      S.status[inc.key] = { label, at: nowStamp() };
      S.log.push({ at: nowStamp(), txt: `${a.label}: ${incTitle(inc)}` });
      toast(`${a.label} approved. Incident moved to Handled.`);
      render();
    }
  };
}
document.addEventListener('click', e => {
  const tb = e.target.closest('.tab-btn');
  if (tb) {
    S.tab = tb.dataset.tab; $$('.tab-btn').forEach(b => b.classList.toggle('active', b === tb));
    $$('.tab').forEach(t => t.classList.toggle('active', t.id === 'tab-' + S.tab));
    if (S.tab === 'tune') renderTune(); if (S.tab === 'notify') renderNotify(); if (S.tab === 'how') renderHow();
    return;
  }
  const inc = e.target.closest('.inc');
  if (inc) { S.sel = inc.dataset.key; renderList(); renderDetail(); return; }
  const sc = e.target.closest('[data-sc]');
  if (sc) {
    const k = sc.dataset.sc;
    if (k === 'RESET') { S.live = [...DEFAULT_LIVE]; S.status = {}; S.calendar = false; S.P.freshness = true; S.sel = null; toast('Back to the default morning: 3 live issues.'); }
    else if (S.live.includes(k)) { S.live = S.live.filter(x => x !== k); toast(`${SCENARIOS[k].label} removed.`); }
    else { S.live.push(k); S.sel = null; toast(`${SCENARIOS[k].label} injected. Pulse re-evaluated ${CS.length} campaigns.`); }
    recompute();
    if (!S.live.includes(k)) return;
    const hit = k === 'DELAY' ? S.res.list.find(i => i.type === 'DATA_LAG') : S.res.list.find(i => !S.status[i.key] && resolveScope(SCENARIOS[k].scope).some(c => i.members.includes(c)));
    if (hit) { S.sel = hit.key; renderList(); renderDetail(); }
    return;
  }
  const act = e.target.closest('[data-act]');
  if (act) {
    const i = S.res.list.find(x => x.key === S.sel); if (!i) return;
    const id = act.dataset.act;
    const a = id === 'expected' ? EXPECTED_ACTION : id === 'snooze' ? { id: 'snooze', label: 'Snooze 1 h', change: 'Notifications pause for 1 hour; Pulse re-alerts early if $ at risk grows by 50%.' } : actionsFor(i).find(x => x.id === id);
    confirmAction(i, a); return;
  }
  const fb = e.target.closest('[data-fb]');
  if (fb) { S.fb[S.sel] = fb.dataset.fb; store.set('fb', S.fb); renderDetail(); toast(fb.dataset.fb === 'up' ? 'Marked useful.' : 'Marked not useful. This rule gets stricter for this account.'); return; }
  if (e.target.id === 'btReset') { Object.assign(S.P, { k: 3.5, persist: 2, minClicks: 8, p1: 600, p2: 100, minRisk: 25 }); renderTune(); recompute(); }
});
$('#tgCal').addEventListener('change', e => { S.calendar = e.target.checked; if (S.calendar && !S.live.includes('SALE')) S.live.push('SALE'); recompute(); toast(S.calendar ? 'Retail sale day added to the context calendar.' : 'Context calendar entry removed.'); });
$('#tgFresh').addEventListener('change', e => { S.P.freshness = e.target.checked; recompute(); toast(S.P.freshness ? 'Freshness guard on.' : 'Freshness guard off. Late data will now look like outages.'); });
let slT = null;
document.addEventListener('input', e => {
  const s = e.target.closest('[data-sl]'); if (!s) return;
  const k = s.dataset.sl, def = SLIDERS.find(x => x.k === k);
  S.P[k] = +s.value; $('#v_' + k).textContent = def.fmt(S.P[k]);
  clearTimeout(slT); slT = setTimeout(() => { runBacktest(k !== 'k' && k !== 'p1' && k !== 'p2' ? true : false); recompute(); }, 120);
});

// Deep links, e.g. ?sc=DELAY&fresh=0  ?sc=SALE&cal=1  ?tab=tune  ?sel=CONV_ZERO
const Q = new URLSearchParams(location.search);
(Q.get('sc') || '').split(',').forEach(k => { if (SCENARIOS[k] && !S.live.includes(k)) S.live.push(k); });
if (Q.get('cal') === '1') S.calendar = true;
if (Q.get('fresh') === '0') S.P.freshness = false;
recompute();
if (Q.get('sel')) { const i = S.res.list.find(x => x.type === Q.get('sel')); if (i) { S.sel = i.key; render(); } }
if (Q.get('tab')) { const b = document.querySelector(`[data-tab="${Q.get('tab')}"]`); if (b) b.click(); }
