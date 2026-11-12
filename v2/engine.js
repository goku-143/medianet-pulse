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
