'use strict';
/* Pulse v2: guided interface.
   engine.js is a verbatim copy of lines 1-403 of ../app.js (simulator, detection, backtest), so every
   number here matches the classic view. This file only adds plain-language presentation, tooltips,
   explain mode, the first-run tour and the use-case stories. */

/* ============================== state (same defaults as classic) ============================== */
const DEFAULT_P = { k: 3.5, persist: 2, minClicks: 8, od: 0.15, p1: 600, p2: 100, minRisk: 25, freshness: true };
const S = {
  P: { ...DEFAULT_P }, calendar: false, live: [...DEFAULT_LIVE],
  status: {}, log: [], fb: store.get('v2fb', {}), sel: null, tab: 'live', res: null, bt: null, curve: null,
  explain: false, stories: null
};
let chart = null, btChart = null;

function recompute() {
  generate(S.live);
  let r = detectAt(NOW, S.P, { calendar: S.calendar });
  if (r.lag) {
    const lag = r.lag, raw = r.rawSignals;
    r = detectAt(NOW - 2, S.P, { calendar: S.calendar });
    r.lag = lag; r.rawSignals = raw; r.evalAt = NOW - 2;
  }
  r.incidents.forEach(inc => Object.assign(inc, onsetOf(inc, S.P)));
  const fat = fatigueIncidents(NOW).map(f => ({ ...f, alertedAt: NOW, onset: NOW - 47 }));
  let list = [...r.incidents, ...fat];
  if (r.lag) list.unshift({ key: 'DATA_LAG|all|all', type: 'DATA_LAG', dim: 'all', val: 'all', members: [], risk: 0, score: 0, conf: 0.99, sev: 'Info', t: NOW, alertedAt: NOW, onset: NOW - 1, lag: r.lag });
  list.sort((a, b) => SEV_RANK[a.sev] - SEV_RANK[b.sev] || b.score - a.score);
  let naive = 0;
  for (let t = NOW - 23; t <= NOW; t++) for (const c of CS) {
    if (c.clk[t - 24] < 10) continue;
    for (const m of METRICS) { const b = c[m][t - 24]; if (b > 0 && Math.abs(c[m][t] / b - 1) > 0.3) { naive++; break; } }
  }
  S.res = { ...r, list, naive };
  if (!S.sel || !list.find(i => i.key === S.sel)) S.sel = list[0] ? list[0].key : null;
  render();
}

/* ============================== plain-language vocabulary ============================== */
const KIND = {
  CONV_ZERO: 'Sales tracking stopped', IVT: 'Likely bot clicks', SPEND_HIGH: 'Overspending',
  DELIVERY_DROP: 'Ads stopped showing', CVR_DROP: 'Clicks not turning into sales', FATIGUE: 'Ad wearing out', DATA_LAG: 'Reporting delay'
};
const DIMP = { pixel: 'sales-tracking tag', adv: 'advertiser', supply: 'publisher group', campaign: 'campaign', all: 'platform' };
const camp = c => `${c.adv}, ${c.name}`;

function title(inc) {
  const m = inc.members, c0 = m[0];
  switch (inc.type) {
    case 'CONV_ZERO': return inc.dim === 'pixel' ? `${inc.val ? c0.adv : ''}: sales tracking stopped on tag ${inc.val}` : inc.dim === 'adv' ? `${inc.val}: sales tracking stopped` : `${camp(c0)}: no sales recorded`;
    case 'IVT': return inc.dim === 'supply' ? `Likely bot clicks from ${inc.val}` : `Likely bot clicks on ${camp(c0)}`;
    case 'SPEND_HIGH': return inc.dim === 'adv' ? `${inc.val} is overspending across ${m.length} campaigns` : inc.dim === 'supply' ? `Spend surge on ${inc.val}` : `${camp(c0)} is overspending`;
    case 'DELIVERY_DROP': return inc.dim === 'supply' ? `Ads stopped showing on ${inc.val}` : inc.dim === 'adv' ? `Ads stopped showing for ${inc.val}` : `${camp(c0)}: ads stopped showing`;
    case 'CVR_DROP': return inc.dim === 'adv' ? `${inc.val}: clicks are not turning into sales` : `${camp(c0)}: clicks are not turning into sales`;
    case 'FATIGUE': return `${camp(c0)}: ad is wearing out`;
    case 'DATA_LAG': return 'Reporting is 2 hours behind';
  }
}
function summary(inc) {
  switch (inc.type) {
    case 'CONV_ZERO': return inc.dim === 'pixel' ? `People still click these ads, but no sales are being recorded. All affected campaigns share one tracking tag (${inc.val}), so the tag on the advertiser's website most likely stopped working, often after a site update.` : `People still click, but no sales are being recorded. This points to a tracking or checkout problem, not a drop in demand.`;
    case 'IVT': return `Clicks jumped but sales did not move${inc.dim === 'supply' ? `, and only on ads shown through ${inc.val}` : ''}. Real people who click more also buy more. This pattern points to automated (bot) clicks that the advertiser pays for.`;
    case 'SPEND_HIGH': return inc.dim === 'adv' ? `${inc.members.length} of ${inc.N} ${inc.val} campaigns started spending much faster in the same hour. When a whole account jumps at once, the usual cause is a budget or bid setting change, not real demand.` : `Spend is far above the normal level for this hour, and sales are not keeping up.`;
    case 'DELIVERY_DROP': return inc.dim === 'supply' ? `Only campaigns shown through ${inc.val} lost their ad views. Other publisher groups are normal, so the problem is on the publisher side (an ad tag or partner outage), not with the advertisers.` : `Ad views fell sharply compared with this hour on previous days.`;
    case 'CVR_DROP': return `Clicks look normal, but far fewer of them turn into sales. Typical causes are a broken landing page, form or checkout.`;
    case 'FATIGUE': return `Fewer people click this ad each day, while the number of people who see it is steady. The audience has seen it too often.`;
    case 'DATA_LAG': return `Most campaigns on ${inc.lag.supplies} publisher groups dropped at the same moment. A drop that hits everything at once is a reporting delay, not ${inc.lag.campaigns} separate problems. Pulse holds those alerts until the data is complete.`;
  }
}
function evidence(inc) {
  const A = inc.A, E = inc.E, w = S.P.persist, out = [], eConv = inc.eConv;
  switch (inc.type) {
    case 'CONV_ZERO':
      out.push(`<b>0 sales</b> recorded in the last ${w} hours. About ${num(eConv)} were expected from the clicks received. The chance of zero by luck is below ${Math.exp(-eConv).toExponential(0)}.`);
      out.push(`Clicks are ${num(A.clk)} against ${num(E.clk)} normally (${pct(A.clk / E.clk)}). People are still arriving, so demand did not disappear.`);
      break;
    case 'IVT': {
      const ctrR = (A.clk / A.imp) / (E.clk / E.imp), cvrR = A.conv / Math.max(eConv, 1e-9);
      out.push(`Clicks per ad view are <b>${times(ctrR)}</b> the normal level for this hour.`);
      out.push(`Sales per click are <b>${pct(cvrR)}</b> of normal. The extra clicks bring no extra sales.`);
      out.push(`Ad views are ${pct(A.imp / E.imp)} of normal, so the extra clicks do not come from more people seeing the ads.`);
      break;
    }
    case 'SPEND_HIGH':
      out.push(`Spend is <b>${money(A.spend / w)} an hour</b> against ${money(E.spend / w)} normally (${times(A.spend / E.spend)}).`);
      out.push(`Cost per sale is ${money(A.spend / Math.max(A.conv, 1))} against ${money(E.spend / Math.max(E.conv, 1))} normally.`);
      break;
    case 'DELIVERY_DROP':
      out.push(`Ad views are <b>${pct(A.imp / E.imp)}</b> of the normal level for this hour.`);
      out.push(`${money(inc.risk)} an hour of planned spend is not being delivered. This is lost revenue for Media.net and lost reach for the advertisers.`);
      break;
    case 'CVR_DROP':
      out.push(`<b>${num(A.conv)} sales</b> against about ${num(eConv)} expected for this many clicks (${pct(A.conv / eConv)}).`);
      out.push(`Clicks are ${pct(A.clk / E.clk)} of normal, so traffic is healthy.`);
      break;
    case 'FATIGUE':
      out.push(`Clicks per ad view in the last 48 hours: <b>${pct(inc.ctrNow, 2)}</b>, against ${pct(inc.ctrBefore, 2)} the week before (${pct(1 - inc.ratio)} lower).`);
      out.push(`Ad views are steady, so people are tired of the ad. They are not missing it.`);
      break;
    case 'DATA_LAG':
      out.push(`${inc.lag.campaigns} campaigns on ${inc.lag.supplies} of ${SUPPLIES.length} publisher groups dropped in the same hour.`);
      out.push(`${inc.lag.held} new alerts are on hold until the data is complete.`);
      break;
  }
  if (inc.core > 1 && inc.N) out.push(`${inc.core} of ${inc.N} campaigns on this ${DIMP[inc.dim]} show the same pattern, so Pulse treats them as <b>one problem</b>${inc.members.length > inc.core ? `. ${inc.members.length - inc.core} more campaign${inc.members.length - inc.core === 1 ? '' : 's'} with a weaker signal on the same ${DIMP[inc.dim]} joined it` : ''}.`);
  if (inc.z != null) out.push(`The change is ${Math.abs(inc.z).toFixed(1)} times larger than the normal hour-to-hour wobble. Pulse alerts only above ${S.P.k}.`);
  return out;
}
function ruledOut(inc) {
  const o = [];
  if (inc.type === 'CONV_ZERO') { o.push('Not an ad delivery problem: ad views and clicks are normal.'); o.push('Not a platform-wide tracking problem: other advertisers record sales normally.'); }
  if (inc.type === 'IVT') { o.push('Not real demand: sales did not rise with clicks.'); o.push('Not an advertiser-side change: the same advertisers are normal on other publisher groups.'); }
  if (inc.type === 'SPEND_HIGH') { o.push('Not a planned event: there is no calendar entry for this advertiser today.'); o.push('Not a data error: views and clicks rose together with spend.'); }
  if (inc.type === 'DELIVERY_DROP') { o.push('Not a reporting delay: other publisher groups report normally.'); o.push('Not budgets running out: campaigns are below their daily pace.'); }
  if (inc.type === 'CVR_DROP') { o.push('Not bot clicks: clicks per ad view are normal.'); o.push('Not a tracking-tag outage: sales are low but not zero.'); }
  if (inc.type === 'FATIGUE') o.push('Not a delivery or bidding change: ad views are steady.');
  if (inc.type === 'DATA_LAG') o.push('Not a real outage: no single publisher, advertiser or tag explains the drop.');
  return o;
}
function actionsFor(inc) {
  const n = inc.members.length, scope = n > 1 ? `${n} campaigns` : 'this campaign';
  switch (inc.type) {
    case 'CONV_ZERO': return [
      { id: 'bid', label: 'Switch to fixed bids', sub: 'Stops automatic bidding while it is blind', tip: 'act.bid', change: `Bidding on ${scope} switches from automatic (target cost per sale) to a fixed cost per click at the 7-day average. It switches back when sales are recorded again.` },
      { id: 'notify', label: 'Tell the advertiser', sub: 'Send tag diagnostics', tip: 'act.notify', change: 'Sends the advertiser the tag ID, the last time it fired and a link to a tag checker.' }];
    case 'IVT': return [
      { id: 'excl', label: `Block ${inc.dim === 'supply' ? inc.val : 'this source'} for 24 h`, sub: 'For the affected campaigns', tip: 'act.excl', change: `${inc.val} is blocked for ${scope} for 24 hours. The traffic-quality team reviews it before it is turned back on.` },
      { id: 'refund', label: 'Open a refund claim', sub: 'Click evidence attached', tip: 'act.refund', change: 'Opens a refund ticket with click logs, the evidence above and the estimated spend on bot clicks.' }];
    case 'SPEND_HIGH': return [
      { id: 'cap', label: 'Cap at 110% of plan', sub: 'Campaigns stay live', tip: 'act.cap', change: `The daily budget on ${scope} is capped at 110% of plan for the rest of today.` },
      { id: 'pause', label: `Pause ${scope}`, sub: 'Full stop', tip: 'act.pause', change: `${scope} pause now. One click in the audit log resumes them.` }];
    case 'DELIVERY_DROP': return [
      { id: 'shift', label: 'Move budget to healthy publishers', sub: "Protects today's delivery", tip: 'act.shift', change: `Unspent budget on ${scope} moves to the other publisher groups these campaigns already use.` },
      { id: 'page', label: 'Page the publisher team', sub: 'Opens a partner ticket', tip: 'act.page', change: `Pages the on-call partner-operations person for ${inc.val}, with the chart attached.` }];
    case 'CVR_DROP': return [
      { id: 'pause', label: 'Pause campaign', sub: 'Stop paying for dead clicks', tip: 'act.pause', change: `${scope} pauses until its landing page passes a check.` },
      { id: 'lp', label: 'Test the landing page', sub: 'Automated visit and form submit', tip: 'act.lp', change: 'Runs an automated visit and form submit on the landing page and attaches the result to this incident.' }];
    case 'FATIGUE': return [
      { id: 'rotate', label: 'Rotate the ad', sub: 'Suggests 2 alternatives', tip: 'act.rotate', change: 'Swaps in the two best alternative ads from the advertiser library and limits each person to 3 views a day.' }];
  }
  return [];
}
const riskName = t => ({ CONV_ZERO: 'Spend with no sales data', DELIVERY_DROP: 'Revenue not delivered', FATIGUE: 'Click value lost' }[t] || 'Money at risk');
const riskSub = t => ({ CONV_ZERO: 'per hour, spent without knowing if it works', SPEND_HIGH: 'per hour above the normal level', IVT: 'per hour paid for likely bot clicks', DELIVERY_DROP: 'per hour of planned spend not served', CVR_DROP: 'per hour on clicks that do not convert', FATIGUE: 'per hour of clicks lost to a tired ad' }[t] || '');
const chartName = t => ({ CONV_ZERO: 'Sales recorded vs normal range', IVT: 'Clicks vs normal range', SPEND_HIGH: 'Spend per hour vs normal range', DELIVERY_DROP: 'Ad views vs normal range', CVR_DROP: 'Sales vs normal range', FATIGUE: 'Clicks per ad view, last 14 days', DATA_LAG: 'All ad views vs normal range' }[t]);

/* ============================== tooltip copy: what it is / why it is here ============================== */
const TIPS = {
  'tab.live': ['Live incidents: the problems Pulse found in the latest hour of data.', 'This is the screen an account manager opens first each hour.'],
  'tab.cases': ['Use cases: five short stories of real failures and how Pulse handles each one.', 'They show the value without needing to know ad operations.'],
  'tab.tune': ['Thresholds and backtest: the settings that decide when Pulse alerts, tested on 6 days of past data.', 'It proves the settings catch real problems without flooding the team.'],
  'tab.notify': ['Notifications: who is told, on which channel and how fast, for each severity.', 'The right person hears about a problem once, at the right urgency.'],
  'tab.how': ['How it works: the steps from raw data to one ranked incident.', 'It shows the logic is simple, explainable and testable.'],
  'tool.tour': ['A 5-step walk through the live screen.', 'A new viewer understands the product in about a minute.'],
  'tool.explain': ['Explain mode: puts a number on each part of the screen and lists what each number is.', 'Use it to read the whole screen at once instead of hovering.'],
  'tool.classic': ['The original version of this prototype, as submitted.', 'Same data and logic, without the guidance layer.'],
  'status': ['A one-line summary of what needs attention right now.', 'A busy reader gets the answer before reading any number.'],
  'clock': ['The latest hour of data Pulse has checked. The data is simulated.', 'Every number on the screen refers to this point in time.'],
  'm.campaigns': ['Campaigns watched: every advertiser campaign Pulse checks each hour.', 'Shows coverage. Some campaigns are too small to judge hourly; they are checked daily instead.'],
  'm.spend': ['Spend today: total advertiser spend so far today, compared with a normal day at the same hours.', 'A quick check that the business as a whole is on track.'],
  'm.open': ['Open incidents: problems that still need a decision, split by severity.', 'This is the team\'s to-do list. P1 is the most urgent.'],
  'm.risk': ['Money at risk per hour: the spend that is wasted or lost each hour these problems continue.', 'It ranks problems by business impact, so the team fixes the costly ones first.'],
  'm.noise': ['Alerts avoided: how many alerts a simple "moved more than 30% since yesterday" rule would have sent today, against the incidents Pulse raised.', 'Too many alerts make people mute them. Fewer, better alerts get acted on.'],
  'queue': ['The open incidents, most urgent and most costly first.', 'One line per problem, not one line per campaign.'],
  'strip': ['One incident: a single problem with one likely cause, even if it affects many campaigns. Select it to see the details.', 'The team works one item per cause instead of reading one alert per campaign.'],
  'sev.P1': ['P1, urgent: at least $600 an hour at risk, after adjusting for how sure Pulse is.', 'P1 pages the on-call person straight away, day or night.'],
  'sev.P2': ['P2, important: $100 to $600 an hour at risk, after adjusting for how sure Pulse is.', 'P2 goes to the team chat in working hours. Nobody is woken up.'],
  'sev.P3': ['P3, slow-moving: below $100 an hour at risk.', 'P3 waits for the 09:00 daily email, so small issues never interrupt anyone.'],
  'sev.Info': ['Information: not a problem with campaigns. Here, the data itself is late.', 'Pulse tells the team why alerts are paused instead of sending false ones.'],
  'lab': ['Scenario lab: add a real-world failure to today\'s simulated data.', 'Lets you test Pulse yourself instead of trusting a screenshot.'],
  'sc.PIXEL_SHOP': ['Tracking tag outage: ShopKart\'s sales-tracking code stops reporting sales.', 'The most common silent failure. Spend continues with no proof it works.'],
  'sc.IVT_SPORTS': ['Bot clicks: automated clicks arrive through one publisher group.', 'Advertisers pay for clicks that can never buy anything.'],
  'sc.FATIGUE': ['Ad wearing out: clicks on one ad slowly decline over a week.', 'A slow problem, so Pulse sends it to the daily email, not a page.'],
  'sc.RUNAWAY': ['Overspending: a daily budget cap is removed by mistake.', 'Money leaves quickly. This must reach a person within the hour.'],
  'sc.FILL': ['Publisher outage: ads stop showing on one publisher group.', 'Lost delivery is lost revenue for Media.net.'],
  'sc.CPA': ['Broken landing page: a form stops working, so clicks stop turning into sales.', 'Only one campaign is hit, so it must be caught without grouping.'],
  'sc.DELAY': ['Reporting delay: the last 2 hours of data arrive incomplete.', 'Late data looks like an outage. This tests that Pulse does not panic.'],
  'sc.SALE': ['Planned sale: retail campaigns spend more because of a sale.', 'An expected spike is not a problem. This tests the calendar.'],
  'sc.RESET': ['Back to the starting state: 3 problems running.', 'Start again after testing scenarios.'],
  'toggle.cal': ['Calendar: tells Pulse that a retail sale is planned today.', 'Expected spikes are not alerted, unless cost per sale also gets worse.'],
  'toggle.fresh': ['Data completeness check: if most of the data drops at the same moment, Pulse treats it as late data and holds alerts.', 'It stops a reporting delay from paging the team dozens of times. Turn it off to see the difference.'],
  'noise': ['The same week of data, counted two ways: alerts from a simple rule against incidents from Pulse.', 'This is the core idea: group by cause and rank by money, so the team gets a short list.'],
  'f.risk': ['Money at risk per hour: the spend that is wasted or lost each hour this problem continues.', 'It ranks problems by business impact, so the team fixes the costly ones first.'],
  'f.conf': ['How sure Pulse is that this is a real problem and not normal ups and downs.', 'A sure, costly problem outranks a doubtful one of the same size.'],
  'f.scope': ['How many campaigns this one problem affects, and what they have in common.', 'The shared item (a tag, a publisher group, an advertiser) points to the cause.'],
  'f.start': ['When the problem most likely started, worked out from the data.', 'Helps match the problem to a change, such as a site release.'],
  'f.ttd': ['How many hours of data Pulse needed before it raised the incident.', 'Pulse waits for the signal to last, so one odd hour does not wake anyone.'],
  'chart': ['The black line is what happened. The grey band is the normal range for each hour, based on the same hour over the last 7 days. Magenta marks where it left the normal range.', 'You can see the problem without reading any number.'],
  'why': ['The evidence Pulse used to flag this problem.', 'People trust an alert when they can check the reasoning.'],
  'ruled': ['Other explanations Pulse checked and rejected.', 'Saves the team from investigating the wrong cause.'],
  'actions': ['Suggested fixes. Each one needs a person to approve it, and each one can be undone.', 'Fast to act on, but no automatic changes to a client\'s money.'],
  'act.bid': ['Switch to fixed bids: stop automatic bidding, which lowers bids when it sees no sales.', 'Without sales data, automatic bidding would wrongly cut the campaign.'],
  'act.notify': ['Tell the advertiser: send them the tag details so their web team can fix it.', 'The fix is on the advertiser\'s website, so they must be told quickly.'],
  'act.excl': ['Block the source: stop showing these campaigns on this publisher group for 24 hours.', 'Stops paying for bot clicks while the traffic team checks.'],
  'act.refund': ['Open a refund claim with the click evidence.', 'Advertisers get credit for clicks that were not real.'],
  'act.cap': ['Cap spend at 110% of the daily plan.', 'Stops the overspend but keeps the campaigns running.'],
  'act.pause': ['Pause: stop the campaigns now.', 'The safest option when every hour costs money.'],
  'act.shift': ['Move unspent budget to the other publishers these campaigns use.', 'Keeps today\'s delivery on plan.'],
  'act.page': ['Page the partner team that manages this publisher group.', 'The fix is on the publisher side, so the right team must know.'],
  'act.lp': ['Run an automated visit and form submit on the landing page.', 'Confirms the cause in a minute instead of a manual check.'],
  'act.rotate': ['Swap in fresh ads from the advertiser library.', 'Brings clicks back without changing the budget.'],
  'act.expected': ['Mark as expected: close the incident and add the pattern to the calendar.', 'Pulse learns and does not alert on the same planned event again.'],
  'act.snooze': ['Snooze for 1 hour. Pulse alerts again earlier if money at risk grows by half.', 'Gives the team time without losing sight of the problem.'],
  'members': ['Every campaign in this incident, with its current and normal numbers.', 'Shows exactly what will change if a fix is approved.'],
  'th.campaign': ['The advertiser and campaign name.', 'Identifies what a fix would touch.'],
  'th.channel': ['Ad format: search-style text ads, native ads inside content, or display banners.', 'Some problems affect only one format.'],
  'th.supply': ['Publisher group: the set of websites and apps where the ad is shown.', 'A problem on one publisher group points to that publisher.'],
  'th.pixel': ['Tracking tag: code on the advertiser\'s website that reports each sale.', 'Campaigns that share a tag fail together when the tag breaks.'],
  'th.now': ['Spend per hour over the last 2 hours.', 'Shows the current cost of the problem.'],
  'th.normal': ['Normal spend per hour: the middle value of the same hour over the last 7 days.', 'The comparison point. Using the middle value ignores past one-off spikes.'],
  'th.metric': ['The number that shows this problem, against what is normal.', 'Confirms each campaign really has the problem.'],
  'trail': ['Who Pulse told about this incident, on which channel, and when.', 'One message per problem, at the right urgency.'],
  'feedback': ['Tell Pulse if this incident was useful.', 'Answers measure alert quality and tighten noisy rules for this account.'],
  'fb.up': ['Useful: this was a real problem worth the interruption.', 'Counts towards precision, the share of incidents that were real.'],
  'fb.down': ['Not useful: this was noise or not worth the interruption.', 'Pulse makes this rule stricter for this account, so it alerts less often.'],
  'story.go': ['Opens the live screen with this scenario running.', 'See the story happen with real, working logic.'],
  'flow': ['The 7 steps from raw numbers to a ranked incident.', 'Each step removes noise or adds meaning.'],
  'ba': ['One week of the same data, counted two ways. Each small dot on the left is 10 alerts. Each dot on the right is 1 incident.', 'This is the core idea: group by cause and rank by money, so the team gets a short list.'],
  'sl.k': ['Sensitivity bar: how far from normal a change must be before Pulse alerts, measured in normal hour-to-hour wobbles.', 'Lower catches more, but adds noise. The chart below shows the trade-off.'],
  'sl.persist': ['How many hours a problem must last before Pulse alerts.', 'Ignores one-hour blips, at the cost of slower alerts.'],
  'sl.minClicks': ['Campaigns smaller than this are too small to judge every hour.', 'Small numbers swing a lot by chance. Those campaigns are judged daily.'],
  'sl.minRisk': ['Problems worth less than this per hour are ignored.', 'Nobody should be interrupted for a few dollars.'],
  'sl.p1': ['Money at risk per hour above which an incident becomes P1 and pages someone.', 'Set it to what is worth waking a person for.'],
  'sl.p2': ['Money at risk per hour above which an incident is sent in real time (P2). Below it, the daily email (P3).', 'Keeps small issues out of the chat.'],
  'bt.recall': ['Recall: the share of real, known problems Pulse caught.', 'A missed problem costs money. This must be high.'],
  'bt.precision': ['Precision: the share of Pulse incidents that were real problems.', 'False alerts erode trust. This must be high too.'],
  'bt.ttd': ['Median time to detect: the typical hours from start of a problem to the alert.', 'Every hour of delay is money lost.'],
  'bt.week': ['Incidents per week across all 124 campaigns.', 'A team can act on about 2 a day. Thousands get muted.'],
  'bt.naive': ['Alerts per week from a simple rule: "any number moved more than 30% since the same hour yesterday".', 'This is what many teams use today. The gap is the noise Pulse removes.'],
  'bt.curve': ['Each point is one sensitivity setting, tested on the same 6 days. Lines are recall and precision; bars are incidents per week.', 'Shows why 3.5 is recommended: everything is caught with the fewest alerts.'],
  'bt.table': ['The 10 problems planted in the past data, and whether Pulse caught them.', 'A known answer key makes the test honest.'],
  'bt.reset': ['Restores the recommended settings.', 'Get back to the tested defaults after experimenting.'],
  'routing': ['The rules for who is told, how, and how fast, for each severity.', 'Urgent problems reach a person fast. Small ones never interrupt.'],
  'pv.slack': ['What the team chat message looks like for the selected incident.', 'One thread per problem. Updates go in the thread, not as new messages.'],
  'pv.sms': ['The text message the on-call person gets, for P1 only.', 'Short, with one link to act.'],
  'pv.digest': ['The 09:00 email with slow-moving issues.', 'Small issues are still seen, without interruptions.'],
  'rules': ['The five failure patterns Pulse looks for, and the exact test for each.', 'Clear rules can be checked and explained to a client.'],
  'th.r.sev': ['Severity: how urgent a problem is, from P1 (urgent) to P3 (slow).', 'Each level gets a different channel, so urgency matches the interruption.'],
  'th.r.chan': ['Channel: where the alert is sent, such as team chat, a text message or email.', 'Urgent problems use a channel people see at once.'],
  'th.r.when': ['When: how fast the alert goes out after Pulse finds the problem.', 'Small problems wait for a batch, so they do not interrupt.'],
  'th.r.esc': ['Escalation: who is told next if nobody responds in time.', 'A real problem is never left unread.'],
  'th.r.night': ['At night: what happens outside working hours.', 'Only problems worth waking someone for wake someone.'],
  'th.b.when': ['When: the hour the planted problem started in the past data.', 'Lets you check how fast Pulse found it.'],
  'th.b.what': ['What happened: the real problem planted in the test data, and how many campaigns it hit.', 'This is the answer key the test is scored against.'],
  'th.b.called': ['Pulse called it: the cause Pulse named for the incident.', 'Shows Pulse names the right cause, not just that something moved.'],
  'th.b.caught': ['Caught: whether Pulse raised an incident for this problem, and at what severity.', 'A missed problem is the most costly failure.'],
  'th.b.after': ['Found after: hours from the start of the problem to the alert.', 'Every hour of delay is money lost.'],
  'th.h.prob': ['Problem: one of the five failure patterns Pulse looks for.', 'Each pattern has its own test, so each alert has a clear reason.'],
  'th.h.when': ['Pulse alerts when: the exact test that must pass before Pulse alerts.', 'A clear test can be checked and explained to a client.'],
  'th.h.group': ['Grouped by: the shared thing used to merge many campaigns into one incident.', 'One cause becomes one incident, not dozens of alerts.'],
  'th.h.risk': ['Money at risk: how Pulse counts the dollars lost each hour for this problem.', 'This sets the priority, so costly problems come first.']
};
const tipAttr = (k, focus = true) => ` data-tip="${k}"${focus ? ' tabindex="0"' : ''}`;

/* ============================== render: live ============================== */
function sevBadge(s, focus = true) { return `<span class="sev ${s}"${tipAttr('sev.' + s, focus)}><i><span></span></i>${s === 'Info' ? 'Info' : s}</span>`; }
function openList() { return S.res.list.filter(i => !S.status[i.key]); }

function render() {
  renderStatus(); renderMetrics(); renderBanner(); renderScenarios(); renderQueue(); renderNoise(); renderDetail();
  if (S.tab === 'notify') renderNotify();
  refreshExplain();
}
function renderStatus() {
  const open = openList().filter(i => i.sev !== 'Info');
  const risk = open.reduce((s, i) => s + i.risk, 0);
  const p1 = open.filter(i => i.sev === 'P1').length;
  const head = open.length
    ? `${open.length === 1 ? 'One problem needs' : `${open.length} problems need`} attention${p1 ? `, ${p1} of them urgent` : ''}. Together they put <b>${money(risk)} an hour</b> at risk.`
    : 'No problems need attention right now.';
  $('#status').innerHTML = `<h1${tipAttr('status')}>${head}</h1>
    <div class="clock"${tipAttr('clock')}><span class="live-dot"></span>Data through <b>${tLabel(NOW + 1)}</b><br>Checked every hour</div>`;
}
function renderMetrics() {
  const open = openList(), inc = open.filter(i => i.sev !== 'Info').length;
  const cnt = s => open.filter(i => i.sev === s).length;
  let spend = 0, spendE = 0;
  for (const c of CS) for (let i = at(14, 0); i <= NOW; i++) { spend += c.spend[i]; spendE += c.med.spend[i]; }
  const risk = open.reduce((s, i) => s + (i.sev !== 'Info' ? i.risk : 0), 0);
  $('#metrics').innerHTML = `
    <div class="metric"${tipAttr('m.campaigns')}><div class="l"><span>Campaigns watched</span></div><div class="v">${CS.length}</div><div class="s">${S.res.eligible} large enough to judge hourly</div></div>
    <div class="metric"${tipAttr('m.spend')}><div class="l"><span>Spend today</span></div><div class="v">${money(spend)}</div><div class="s">${pct(spend / spendE)} of a normal day so far</div></div>
    <div class="metric"${tipAttr('m.open')}><div class="l"><span>Open incidents</span></div><div class="v">${inc}</div><div class="s">${cnt('P1')} urgent, ${cnt('P2')} important, ${cnt('P3')} slow</div></div>
    <div class="metric"${tipAttr('m.risk')}><div class="l"><span>Money at risk per hour</span></div><div class="v ${risk > 0 ? 'mag' : ''}">${money(risk)}</div><div class="s">across open incidents</div></div>
    <div class="metric"${tipAttr('m.noise')}><div class="l"><span>Alerts avoided today</span></div><div class="v">${num(Math.max(0, S.res.naive - inc))}</div><div class="s">${num(S.res.naive)} simple-rule alerts became ${inc} incidents</div></div>`;
}
function renderBanner() {
  const b = [];
  if (S.res.lag) b.push(`<div class="banner warn"><b>Alerts on hold: the latest data is incomplete.</b> The last 2 hours are missing data from ${S.res.lag.supplies} publisher groups. ${S.res.lag.held} new alerts wait until the data arrives, instead of paging the team ${S.res.lag.campaigns} times. Open incidents use the last complete data (through ${hh(S.res.evalAt + 1)}).</div>`);
  if (!S.P.freshness && S.live.includes('DELAY')) b.push(`<div class="banner bad"><b>The data completeness check is off.</b> Late data is now treated as real outages, so the list fills with false alarms. Turn the check back on in the scenario lab.</div>`);
  if (S.calendar && S.res.suppressed.length) b.push(`<div class="banner"><b>Calendar: retail sale today.</b> ${S.res.suppressed.length} retail campaigns spend ${times(avgRatio(S.res.suppressed))} their normal level with a healthy cost per sale, so Pulse treats them as expected. A campaign whose cost per sale gets worse still alerts.</div>`);
  if (!S.calendar && S.live.includes('SALE')) b.push(`<div class="banner">A planned retail sale is running, but it is not on the calendar, so Pulse flags the spikes. Tick <b>Calendar: retail sale planned today</b> to see them handled as expected.</div>`);
  $('#banner').innerHTML = b.join('');
}
const avgRatio = rs => rs.reduce((s, r) => s + r.A.spend, 0) / rs.reduce((s, r) => s + r.E.spend, 0);
const LAB_KEYS = ['PIXEL_SHOP', 'IVT_SPORTS', 'FATIGUE', 'RUNAWAY', 'FILL', 'CPA', 'DELAY', 'SALE'];
const LAB = {
  PIXEL_SHOP: ['Tracking tag outage', 'ShopKart sales stop recording'], IVT_SPORTS: ['Bot clicks', 'On Sports-Network'], FATIGUE: ['Ad wearing out', 'StayWell Hotels, slow decline'],
  RUNAWAY: ['Overspending', 'HomeNest budget cap removed'], FILL: ['Publisher outage', 'News-Tier1 stops showing ads'], CPA: ['Broken landing page', 'InsureEasy form fails'],
  DELAY: ['Reporting delay', 'Last 2 hours incomplete'], SALE: ['Planned retail sale', 'Expected spike in spend']
};
function renderScenarios() {
  $('#scenarios').innerHTML = LAB_KEYS.map(k => `<button class="sbtn" data-sc="${k}" aria-pressed="${S.live.includes(k)}" data-tip="sc.${k}"><b>${LAB[k][0]}</b><span>${LAB[k][1]}</span></button>`).join('') +
    `<button class="sbtn reset" data-sc="RESET" data-tip="sc.RESET">Reset to the starting 3 problems</button>`;
  $('#tgCal').checked = S.calendar; $('#tgFresh').checked = S.P.freshness;
}
function stripHTML(i) {
  const st = S.status[i.key];
  return `<li><button class="strip ${i.sev} ${st ? 'done' : ''}" data-key="${esc(i.key)}" aria-current="${S.sel === i.key}" data-tip="strip">
    <span class="edge" aria-hidden="true"></span><span class="body">
    <span class="row">${sevBadge(i.sev, false)}${st ? `<span class="pill ok">${esc(st.label)}</span>` : `<span class="kind">${KIND[i.type]}</span>`}</span>
    <span class="t" style="display:block">${esc(title(i))}</span>
    <span class="m">${i.sev !== 'Info' ? `<span><b>${money(i.risk)}</b> an hour at risk</span>` : '<span>Alerts on hold</span>'}<span>${i.members.length || 'All'} campaign${i.members.length === 1 ? '' : 's'}</span><span>since ${since(i.onset)}</span></span>
    </span></button></li>`;
}
function renderQueue() {
  const L = S.res.list, open = L.filter(i => !S.status[i.key]), done = L.filter(i => S.status[i.key]);
  $('#incCount').textContent = `${open.length} open from ${S.res.rawSignals} raw signals`;
  $('#queue').innerHTML = (open.length ? open.map(stripHTML).join('') : `<li class="empty"><b>Nothing needs attention.</b>Add a failure in the scenario lab below to see how Pulse reacts.</li>`) +
    (done.length ? `<li class="handled">Handled today</li>${done.map(stripHTML).join('')}` : '');
}

/* before / after: each small dot = 10 alerts (left), each large dot = 1 incident (right) */
function baSVG(naiveWeek, incWeek, big) {
  const dots = Math.round(naiveWeek / 10), cols = big ? 60 : 44, rows = Math.ceil(dots / cols), g = big ? 7 : 6, r = big ? 2 : 1.6;
  const W = cols * g, Hh = rows * g;
  let d = '';
  for (let i = 0; i < dots; i++) { const x = (i % cols) * g + g / 2, y = Math.floor(i / cols) * g + g / 2; d += `M${x - r} ${y}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0`; }
  const ic = Math.round(incWeek), icCols = 4, R = big ? 7 : 6, G = R * 2 + 6;
  const icRows = Math.ceil(ic / icCols), W2 = icCols * G, H2 = Math.max(icRows * G, G);
  let c = '';
  for (let i = 0; i < ic; i++) c += `<circle cx="${(i % icCols) * G + G / 2}" cy="${H2 - (Math.floor(i / icCols) * G + G / 2)}" r="${R}" fill="#b3134b"/>`;
  return `<div class="ba${big ? ' big' : ''}"${tipAttr('ba')}>
    <figure><svg viewBox="0 0 ${W} ${Hh}" role="img" aria-label="${num(naiveWeek)} alerts in one week from a simple rule, drawn as ${dots} dots of 10"><path d="${d}" fill="#9a9aa1"/></svg>
      <figcaption><b>${num(naiveWeek)} alerts</b>a week from a simple "moved 30% since yesterday" rule. About ${num(naiveWeek / 7)} a day.</figcaption></figure>
    <figure class="after"><svg viewBox="0 0 ${W2} ${H2}" role="img" aria-label="${ic} incidents in one week from Pulse" style="max-width:${big ? 120 : 96}px">${c}</svg>
      <figcaption><b>${ic} incidents</b>a week from Pulse, each one explained and ranked.</figcaption></figure>
  </div>`;
}
let BT0 = null;   // backtest at recommended defaults, computed once
function baseBacktest() { if (!BT0) BT0 = backtest(DEFAULT_P); return BT0; }
function renderNoise() {
  const b = baseBacktest();
  $('#noise').innerHTML = `<h3${tipAttr('noise')}>How noise is kept low</h3>${baSVG(b.naivePerWeek, b.perWeek, false)}
    <p>Pulse compares each hour with the same hour on the last 7 days, skips campaigns too small to judge, waits for a problem to last ${S.P.persist} hours and merges campaigns that share a cause. Same 6 days of simulated data, both counts.</p>`;
}

function renderDetail() {
  const inc = S.res.list.find(i => i.key === S.sel);
  if (chart) { chart.destroy(); chart = null; }
  if (!inc) { $('#detail').innerHTML = `<div class="empty"><b>Nothing selected.</b>There are no open incidents. Add a failure in the scenario lab to see Pulse respond.</div>`; return; }
  const st = S.status[inc.key], ttd = inc.alertedAt - inc.onset + 1, acts = actionsFor(inc), fb = S.fb[inc.key], w = S.P.persist;
  const metric = TYPES[inc.type].metric;
  $('#detail').innerHTML = `
    <div class="dh"><div class="tags">${sevBadge(inc.sev)}<span class="pill">${KIND[inc.type]}</span>${st ? `<span class="pill ok">${esc(st.label)} at ${st.at}</span>` : ''}</div>
      <h2>${esc(title(inc))}</h2><p>${esc(summary(inc))}</p></div>
    <div class="facts">
      <div class="fact"${tipAttr('f.risk')}><div class="l"><span>${riskName(inc.type)}</span></div><div class="v">${inc.sev === 'Info' ? 'None' : money(inc.risk) + '/h'}</div><div class="s">${inc.sev === 'Info' ? 'Data problem, not a campaign problem' : riskSub(inc.type)}</div></div>
      <div class="fact"${tipAttr('f.conf')}><div class="l"><span>How sure</span></div><div class="v">${inc.z != null ? confTxt(inc.conf) : 'High'}</div><div class="s">${inc.z != null ? 'chance this is a real change' : 'steady pattern over days'}</div></div>
      <div class="fact"${tipAttr('f.scope')}><div class="l"><span>Campaigns affected</span></div><div class="v">${inc.members.length || 'All'}</div><div class="s">${inc.dim === 'campaign' ? 'a single campaign' : `sharing one ${DIMP[inc.dim]}`}</div></div>
      <div class="fact"${tipAttr('f.start')}><div class="l"><span>Started</span></div><div class="v">${since(inc.onset)}</div><div class="s">${ago(NOW - inc.onset)}, estimated</div></div>
      <div class="fact"${tipAttr('f.ttd')}><div class="l"><span>Found after</span></div><div class="v">${ttd} h</div><div class="s">flagged with the ${hh(inc.alertedAt + 1)} data</div></div>
    </div>
    <div class="cols">
      <div class="sec" style="margin-top:0"><h3${tipAttr('chart')}>${chartName(inc.type)}</h3><div class="chartbox"><canvas id="incChart" role="img" aria-label="${esc(chartName(inc.type))}"></canvas></div>
        ${inc.type !== 'FATIGUE' ? `<div class="chart-key"><span><i></i>Actual</span><span><i class="bad"></i>Outside normal</span><span><i class="exp"></i>Normal (same hour, last 7 days)</span><span><i class="band"></i>Normal range</span></div>` : ''}</div>
      <div>
        <div class="sec" style="margin-top:0" id="why"><h3${tipAttr('why')}>Why Pulse flagged it</h3><ul class="ev">${evidence(inc).map(e => `<li>${e}</li>`).join('')}</ul></div>
        <div class="sec"><h3${tipAttr('ruled')}>What it is not</h3><ul class="ev neg">${ruledOut(inc).map(e => `<li>${e}</li>`).join('')}</ul></div>
      </div>
    </div>
    ${acts.length ? `<div class="sec" id="actions"><h3${tipAttr('actions')}>What to do <span class="meta">A person approves each fix. Each fix can be undone.</span></h3><div class="actions">
      ${acts.map((a, j) => `<button class="btn ${j === 0 ? 'primary' : ''}" data-act="${a.id}" data-tip="${a.tip}" ${st ? 'disabled' : ''}>${esc(a.label)}<small>${esc(a.sub)}</small></button>`).join('')}
      <button class="btn" data-act="expected" data-tip="act.expected" ${st ? 'disabled' : ''}>Mark as expected<small>Adds it to the calendar</small></button>
      <button class="btn" data-act="snooze" data-tip="act.snooze" ${st ? 'disabled' : ''}>Snooze 1 hour<small>Alerts again if it grows</small></button>
    </div></div>` : ''}
    ${inc.members.length ? `<div class="sec"><h3${tipAttr('members')}>Affected campaigns <span class="meta">${inc.members.length}</span></h3><div class="tbl-wrap"><table>
      <thead><tr><th${tipAttr('th.campaign')}><span>Campaign</span></th><th class="hide-sm"${tipAttr('th.channel')}><span>Ad format</span></th><th class="hide-sm"${tipAttr('th.supply')}><span>Publisher group</span></th><th class="hide-sm"${tipAttr('th.pixel')}><span>Tracking tag</span></th>
      <th class="n"${tipAttr('th.now')}><span>Spend/h now</span></th><th class="n hide-sm"${tipAttr('th.normal')}><span>Normal</span></th><th class="n"${tipAttr('th.metric')}><span>${metric === 'conv' ? 'Sales / expected' : metric === 'imp' ? 'Ad views vs normal' : 'Clicks vs normal'}</span></th></tr></thead>
      <tbody>${inc.members.slice(0, 40).map(c => memberRow(c, inc, w)).join('')}</tbody></table></div></div>` : ''}
    <div class="cols">
      <div class="sec"><h3${tipAttr('trail')}>Who was told</h3><div class="trail">${routeFor(inc.sev).map(r => `<div><span class="tm">${r.t}</span><span>${r.txt}</span></div>`).join('')}</div></div>
      <div class="sec"><h3${tipAttr('feedback')}>Was this incident useful?</h3>
        <div class="fb"><button class="btn sm" data-fb="up" data-tip="fb.up" aria-pressed="${fb === 'up'}">Useful</button><button class="btn sm" data-fb="down" data-tip="fb.down" aria-pressed="${fb === 'down'}">Not useful</button>
        <span class="meta">${fb ? 'Recorded. Answers tune this rule for this account.' : 'One tap. Answers measure alert quality.'}</span></div>
        ${S.log.length ? `<div class="sec"><h3>Audit log</h3><div class="trail">${S.log.slice(-5).reverse().map(l => `<div><span class="tm">${l.at}</span><span>${esc(l.txt)}</span></div>`).join('')}</div></div>` : ''}
      </div>
    </div>`;
  if (S.tab === 'live') drawIncidentChart(inc);
}
function memberRow(c, inc, w) {
  const A = { imp: 0, clk: 0, spend: 0, conv: 0 }, E = { imp: 0, clk: 0, spend: 0, conv: 0 };
  for (let i = NOW - w + 1; i <= NOW; i++) for (const m of METRICS) { A[m] += c[m][i]; E[m] += c.med[m][i]; }
  const m = TYPES[inc.type].metric;
  let last;
  if (m === 'conv') { const e = A.clk * cvrBase(c, NOW); last = `<span class="${A.conv < 0.5 * e ? 'down' : ''}">${num(A.conv)} / ${num(e)}</span>`; }
  else if (m === 'imp') { const r = A.imp / Math.max(E.imp, 1); last = `<span class="${r < 0.6 ? 'down' : ''}">${pct(r)}</span>`; }
  else { const r = A.clk / Math.max(E.clk, 1); last = `<span class="${r > 1.4 || r < 0.6 ? 'up' : ''}">${pct(r)}</span>`; }
  const sr = A.spend / Math.max(E.spend, 1);
  return `<tr><td><b>${esc(c.adv)}</b>, ${esc(c.name)}<span class="sub">${c.id}, ${c.geo}</span></td><td class="hide-sm">${c.channel}</td><td class="hide-sm">${c.supply}</td><td class="hide-sm">${c.pixel}</td>
    <td class="n ${sr > 1.4 || sr < 0.6 ? 'up' : ''}">${money(A.spend / w)}</td><td class="n hide-sm">${money(E.spend / w)}</td><td class="n">${last}</td></tr>`;
}
function chartBase(y) {
  Chart.defaults.font.family = "'DM Sans', system-ui, sans-serif"; Chart.defaults.color = '#4a4a4f';
  return {
    responsive: true, maintainAspectRatio: false, animation: false, interaction: { mode: 'index', intersect: false },
    plugins: { legend: { display: false }, tooltip: { backgroundColor: '#111', titleFont: { weight: '600' }, filter: i => i.dataset.label !== 'low' } },
    scales: { x: { ticks: { maxTicksLimit: 7, font: { size: 11 } }, grid: { display: false }, border: { color: '#d0d0d5' } }, y: { beginAtZero: true, title: { display: true, text: y, font: { size: 11 } }, ticks: { font: { size: 11 } }, grid: { color: '#efeff1' }, border: { display: false } } }
  };
}
function drawIncidentChart(inc) {
  const ctx = $('#incChart'); if (!ctx || typeof Chart === 'undefined') return;
  const od = S.P.od;
  if (inc.type === 'FATIGUE') {
    const c = inc.members[0], labels = [], data = [];
    for (let d = 0; d <= 14; d++) { let cl = 0, im = 0; for (let i = 0; i <= NOW; i++) if (dayIdx(i) === d) { cl += c.clk[i]; im += c.imp[i]; } if (im > 0) { labels.push(dLabel(at(d, 12))); data.push(+(cl / im * 100).toFixed(2)); } }
    chart = new Chart(ctx, { type: 'line', data: { labels, datasets: [{ label: 'Clicks per 100 ad views', data, borderColor: '#111', borderWidth: 2, pointRadius: 2, pointBackgroundColor: '#111', tension: .25, segment: { borderColor: s => s.p0DataIndex >= 9 ? '#b3134b' : '#111' } }] }, options: chartBase('Clicks per 100 ad views') });
    return;
  }
  const m = TYPES[inc.type].metric, mem = inc.members.length ? inc.members : CS;
  const labels = [], act = [], exp = [], lo = [], hi = [];
  for (let i = NOW - 47; i <= NOW; i++) {
    let a = 0, e = 0; for (const c of mem) { a += c[m][i]; e += c.med[m][i]; }
    const sd = m === 'spend' ? Math.sqrt(e + (od * e) ** 2) : Math.sqrt(Math.max(e, 1) + (od * e) ** 2);
    labels.push(hod(i) === 0 ? dLabel(i) : hh(i)); act.push(+a.toFixed(1)); exp.push(+e.toFixed(1)); lo.push(Math.max(0, +(e - 2 * sd).toFixed(1))); hi.push(+(e + 2 * sd).toFixed(1));
  }
  const on = inc.onset - (NOW - 47);
  chart = new Chart(ctx, {
    type: 'line',
    data: { labels, datasets: [
      { label: 'low', data: lo, borderWidth: 0, pointRadius: 0, fill: false },
      { label: 'Normal range, top', data: hi, borderWidth: 0, pointRadius: 0, fill: '-1', backgroundColor: 'rgba(17,17,17,.07)' },
      { label: 'Normal', data: exp, borderColor: '#76767c', borderDash: [4, 4], borderWidth: 1.5, pointRadius: 0, fill: false },
      { label: 'Actual', data: act, borderColor: '#111', borderWidth: 2, pointRadius: 0, fill: false, segment: { borderColor: c => c.p0DataIndex >= on ? '#b3134b' : '#111' } }] },
    options: chartBase({ conv: 'Sales', clk: 'Clicks', spend: 'Spend ($)', imp: 'Ad views' }[m])
  });
}

/* ============================== notifications ============================== */
const ROUTING = {
  P1: ['Team chat #adops-oncall, plus text message and phone alert to the on-call account manager', 'Within 15 minutes of the data arriving', 'To the team lead if nobody responds in 30 minutes', 'Always sent, even at night'],
  P2: ['Team chat #adops-alerts, in-app and email to the campaign owner', 'Straight away in working hours', 'If still open after 4 hours', 'Held until 07:00 at night (22:00 to 07:00)'],
  P3: ['Daily email at 09:00 and the in-app inbox', 'Once a day', 'None. Closes itself if clear for 24 hours', 'Not needed'],
  Info: ['Banner inside Pulse only', 'While the condition lasts', 'Becomes P2 if data is more than 4 hours late', 'Not needed']
};
function routeFor(sev) {
  const b = `${String(hod(NOW + 1)).padStart(2, '0')}:`;
  if (sev === 'P1') return [{ t: b + '02', txt: 'Team chat #adops-oncall, one thread for this incident' }, { t: b + '02', txt: 'Text message and phone alert to the on-call account manager' }, { t: b + '32', txt: 'Goes to the team lead if nobody responds' }];
  if (sev === 'P2') return [{ t: b + '02', txt: 'Team chat #adops-alerts and in-app' }, { t: b + '05', txt: 'Email to the campaign owner' }, { t: '+4 h', txt: 'Goes to the team lead if still open' }];
  if (sev === 'P3') return [{ t: '09:00', txt: "Tomorrow's daily email and the in-app inbox" }, { t: '', txt: 'No interruption: this problem moves slowly' }];
  return [{ t: b + '00', txt: 'Banner only. Related alerts wait until the data is complete' }];
}
function renderNotify() {
  const inc = S.res.list.find(i => i.key === S.sel) || S.res.list[0];
  const p3 = S.res.list.filter(i => i.sev === 'P3');
  const acts = inc ? actionsFor(inc) : [];
  $('#tab-notify').innerHTML = `<div class="page">
    <div class="page-head"><h1>Who hears about a problem, and how fast</h1><p>Severity decides the channel. Severity is money at risk per hour, adjusted for how sure Pulse is. One problem gets one message thread; updates go into that thread.</p></div>
    <div class="block"><h2${tipAttr('routing')}>Routing rules</h2><p class="lede">P1 at ${money(S.P.p1)} an hour or more. P2 at ${money(S.P.p2)} or more. Everything smaller is P3.</p>
      <div class="tbl-wrap"><table><thead><tr><th${tipAttr('th.r.sev')}><span>Severity</span></th><th${tipAttr('th.r.chan')}><span>Channel</span></th><th${tipAttr('th.r.when')}><span>When</span></th><th class="hide-sm"${tipAttr('th.r.esc')}><span>Escalation</span></th><th class="hide-sm"${tipAttr('th.r.night')}><span>At night</span></th></tr></thead>
      <tbody>${['P1', 'P2', 'P3', 'Info'].map(s => `<tr><td>${sevBadge(s)}</td><td>${ROUTING[s][0]}</td><td>${ROUTING[s][1]}</td><td class="hide-sm">${ROUTING[s][2]}</td><td class="hide-sm">${ROUTING[s][3]}</td></tr>`).join('')}</tbody></table></div></div>
    <div class="block"><h2>Message previews</h2><p class="lede">For the incident selected on the live screen${inc ? `: ${esc(title(inc))}` : ''}.</p>
      <div class="previews">
        <div${tipAttr('pv.slack')}><h3>Team chat</h3>${inc ? `<div class="msg" style="margin-top:8px"><div class="from"><span class="av"><svg viewBox="0 0 32 32" width="16" height="16" aria-hidden="true"><path d="M4 17h6l3-8 5 15 3-7h7" stroke="#D51254" stroke-width="3" fill="none" stroke-linecap="round"/></svg></span><b>Pulse</b><span class="meta">${hh(NOW + 1).slice(0, 3)}02</span></div>
          <div>${sevBadge(inc.sev, false)} <b>${esc(title(inc))}</b></div><p class="meta" style="margin-top:6px">${inc.sev !== 'Info' ? `${money(inc.risk)} an hour at risk. ` : ''}${inc.members.length || 'All'} campaigns.${inc.z != null ? ` ${confTxt(inc.conf)} sure.` : ''}</p>
          <p style="margin-top:6px;color:var(--ink2)">${esc(summary(inc))}</p><div class="btns">${acts.slice(0, 2).map(a => `<span>${esc(a.label)}</span>`).join('')}<span>Acknowledge</span><span>Snooze 1 hour</span></div></div>` : ''}</div>
        <div${tipAttr('pv.sms')}><h3>Text message, P1 only</h3><div style="margin-top:8px">${inc && inc.sev === 'P1' ? `<div class="sms">Pulse P1: ${esc(title(inc))}. ${money(inc.risk)}/h at risk, ${inc.members.length} campaigns. Open: pulse.app/i/${(inc.key.length * 7919 % 9000 + 1000)}</div>` : '<div class="empty">The selected incident is not P1, so no text message is sent.</div>'}</div></div>
        <div${tipAttr('pv.digest')}><h3>Daily email at 09:00, P3</h3><div style="margin-top:8px">${p3.length ? `<table><tbody>${p3.map(i => `<tr><td>${esc(title(i))}</td><td class="n">${money(i.risk)}/h</td></tr>`).join('')}</tbody></table>` : '<div class="empty">Nothing for the daily email today.</div>'}</div></div>
      </div></div>
    <div class="block two">
      <div class="prose"><h2>Rules against alert fatigue</h2><ul>
        <li><b>One problem, one incident.</b> A tag outage on 9 campaigns is 1 incident, not 9 alerts.</li>
        <li><b>Must last.</b> A problem must hold for ${S.P.persist} hours before it alerts.</li>
        <li><b>Big enough to judge.</b> Campaigns expecting fewer than ${S.P.minClicks} clicks an hour are judged daily.</li>
        <li><b>Closes itself</b> after 3 clean hours, with a note in the thread.</li>
        <li><b>Snooze</b> alerts again only if money at risk grows by half.</li>
        <li><b>Interruption budget:</b> fewer than 3 interruptions per account manager per day, tracked weekly.</li></ul></div>
      <div class="prose"><h2>Who gets what</h2><ul>
        <li><b>Account manager:</b> every incident on their accounts.</li>
        <li><b>Ad-operations on-call:</b> P1 only, across all accounts.</li>
        <li><b>Traffic-quality team:</b> every bot-click incident, for blocks and refunds.</li>
        <li><b>Publisher partner team:</b> delivery drops, grouped by publisher.</li>
        <li><b>Advertiser (if they opt in):</b> tracking-tag incidents, with a tag checker.</li></ul></div>
    </div></div>`;
  refreshExplain();
}

/* ============================== thresholds & backtest ============================== */
const SLIDERS = [
  { k: 'k', label: 'Sensitivity bar', min: 1.5, max: 5, step: 0.25, fmt: v => v.toFixed(2), help: 'How far from normal before Pulse alerts. Lower catches more, with more noise.' },
  { k: 'persist', label: 'Must last at least', min: 1, max: 3, step: 1, fmt: v => v + ' h', help: 'Longer means fewer blips, but slower alerts.' },
  { k: 'minClicks', label: 'Smallest campaign judged hourly', min: 2, max: 30, step: 1, fmt: v => v + ' clicks/h', help: 'Smaller campaigns swing by chance, so they are judged daily.' },
  { k: 'minRisk', label: 'Ignore problems smaller than', min: 0, max: 100, step: 5, fmt: v => money(v) + '/h', help: 'Not worth anyone\'s time as an incident.' },
  { k: 'p1', label: 'Page someone (P1) above', min: 200, max: 3000, step: 100, fmt: v => money(v) + '/h', help: 'Set to what is worth waking a person for.' },
  { k: 'p2', label: 'Real-time message (P2) above', min: 50, max: 600, step: 25, fmt: v => money(v) + '/h', help: 'Below this, the 09:00 daily email.' }
];
function renderTune() {
  $('#tab-tune').innerHTML = `<div class="page">
    <div class="page-head"><h1>When should Pulse alert?</h1><p>Move a setting and Pulse re-tests itself on 6 days of past data with ${HIST_EVENTS.length} known, planted problems. The live screen updates too.</p></div>
    <div class="tune">
      <div><h2>Settings</h2>
        ${SLIDERS.map(s => `<div class="sl"><label for="sl_${s.k}">${s.label}<output id="v_${s.k}">${s.fmt(S.P[s.k])}</output></label><input id="sl_${s.k}" type="range" min="${s.min}" max="${s.max}" step="${s.step}" value="${S.P[s.k]}" data-sl="${s.k}" data-tip="sl.${s.k}"><p>${s.help}</p></div>`).join('')}
        <button class="btn sm" id="btReset" style="margin-top:16px" data-tip="bt.reset">Restore recommended settings</button></div>
      <div>
        <h2>Test result</h2><div class="bt-row" id="btCards" style="margin-top:8px"></div>
        <div class="block" style="margin-top:24px"><h2${tipAttr('bt.curve')}>Catch rate against noise</h2><p class="lede">Each point is one sensitivity setting. At <b>3.5</b> every planted problem is caught with the fewest alerts. Lower adds noise; higher starts to miss problems.</p>
          <div class="chartbox" style="height:260px"><canvas id="btChart" role="img" aria-label="Recall, precision and incidents per week for each sensitivity setting"></canvas></div>
          <div class="chart-key"><span><i></i>Recall: real problems caught (%)</span><span><i class="exp"></i>Precision: incidents that were real (%)</span><span><i class="band"></i>Incidents per week</span></div></div>
        <div class="block"><h2${tipAttr('bt.table')}>The planted problems</h2><div class="tbl-wrap" style="margin-top:8px"><table id="btTable"></table></div></div>
      </div></div></div>`;
  runBacktest(true);
  refreshExplain();
}
function runBacktest(withCurve) {
  const bt = backtest(S.P); S.bt = bt;
  $('#btCards').innerHTML = `
    <div class="metric"${tipAttr('bt.recall')}><div class="l"><span>Recall</span></div><div class="v">${pct(bt.recall)}</div><div class="s">${bt.truth.filter(e => e.hit !== null).length} of ${bt.truth.length} real problems caught</div></div>
    <div class="metric"${tipAttr('bt.precision')}><div class="l"><span>Precision</span></div><div class="v">${pct(bt.precision)}</div><div class="s">${bt.tp} of ${bt.alerts.length} incidents were real</div></div>
    <div class="metric"${tipAttr('bt.ttd')}><div class="l"><span>Time to detect</span></div><div class="v">${bt.ttdMed != null ? bt.ttdMed + ' h' : 'None'}</div><div class="s">median, from the start</div></div>
    <div class="metric"${tipAttr('bt.week')}><div class="l"><span>Incidents a week</span></div><div class="v mag">${bt.perWeek.toFixed(0)}</div><div class="s">across ${CS.length} campaigns</div></div>
    <div class="metric"${tipAttr('bt.naive')}><div class="l"><span>Simple-rule alerts a week</span></div><div class="v">${num(bt.naivePerWeek)}</div><div class="s">${pct(bt.naivePrecision)} of them real</div></div>`;
  $('#btTable').innerHTML = `<thead><tr><th${tipAttr('th.b.when')}><span>When</span></th><th${tipAttr('th.b.what')}><span>What happened</span></th><th class="hide-sm"${tipAttr('th.b.called')}><span>Pulse called it</span></th><th${tipAttr('th.b.caught')}><span>Caught</span></th><th class="n"${tipAttr('th.b.after')}><span>Found after</span></th></tr></thead><tbody>${bt.truth.map(e => `<tr><td>${tLabel(e.s)}</td><td>${esc(e.what)}<span class="sub">${resolveScope(e.scope).length} campaigns</span></td><td class="hide-sm">${KIND[e.hitType || FAMILY[e.type]]}</td><td>${e.hit !== null ? `<span class="okc">Yes, ${e.hitSev}</span>` : '<span class="down">Missed</span>'}</td><td class="n">${e.hit !== null ? (e.hit - e.s + 1) + ' h' : 'None'}</td></tr>`).join('')}</tbody>`;
  if (withCurve || !S.curve) { S.curve = [1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5].map(k => { const b = backtest({ ...S.P, k }); return { k, recall: b.recall, precision: b.precision, perWeek: b.perWeek }; }); }
  drawCurve();
}
function drawCurve() {
  const el = $('#btChart'); if (!el || typeof Chart === 'undefined') return;
  if (btChart) btChart.destroy();
  const cur = S.curve, isK = p => p.k === S.P.k, opt = chartBase('%');
  opt.scales.y.max = 100; opt.scales.y2 = { position: 'right', beginAtZero: true, grid: { display: false }, border: { display: false }, title: { display: true, text: 'incidents a week', font: { size: 11 } }, ticks: { font: { size: 11 } } };
  opt.plugins.tooltip.filter = () => true;
  btChart = new Chart(el, {
    data: { labels: cur.map(p => p.k.toFixed(1)), datasets: [
      { type: 'line', label: 'Recall (%)', data: cur.map(p => +(p.recall * 100).toFixed(0)), borderColor: '#111', borderWidth: 2, pointBackgroundColor: cur.map(p => isK(p) ? '#b3134b' : '#111'), pointRadius: cur.map(p => isK(p) ? 6 : 3), yAxisID: 'y', tension: .2 },
      { type: 'line', label: 'Precision (%)', data: cur.map(p => +(p.precision * 100).toFixed(0)), borderColor: '#76767c', borderDash: [4, 4], borderWidth: 2, pointBackgroundColor: '#76767c', pointRadius: 3, yAxisID: 'y', tension: .2 },
      { type: 'bar', label: 'Incidents a week', data: cur.map(p => +p.perWeek.toFixed(1)), backgroundColor: cur.map(p => isK(p) ? 'rgba(179,19,75,.25)' : '#e3e3e6'), yAxisID: 'y2' }] },
    options: opt
  });
}

/* ============================== how it works ============================== */
const FLOW = [
  ['Collect', 'Each hour: ad views, clicks, spend and sales for every campaign.'],
  ['Check data is complete', 'If most data drops at once, hold alerts. It is late data, not 40 outages.'],
  ['Compare with normal', 'Same hour on the last 7 days, middle value. Mondays compare with Mondays at 10:00.'],
  ['Group by cause', 'Campaigns sharing a tag, publisher group or advertiser become one incident.'],
  ['Rank by money at risk', 'Money at risk per hour, adjusted for how sure. Sets P1, P2 or P3.'],
  ['Notify', 'Right person, right channel. A person approves every fix.'],
  ['Learn', 'Useful or not useful answers tighten noisy rules per account.']
];
function flowHTML() {
  return `<ol class="flow"${tipAttr('flow')} style="list-style:none;padding:0;margin:16px 0 0">${FLOW.map(([b, t], i) => `<li class="fstep ${i === 3 || i === 4 ? 'key' : ''}"><span class="n">${i + 1}</span><b>${b}</b><p>${t}</p></li>`).join('')}</ol>`;
}
function renderHow() {
  const b = baseBacktest();
  $('#tab-how').innerHTML = `<div class="page">
    <div class="page-head"><h1>From raw numbers to one ranked problem</h1><p>Seven steps, each simple enough to explain to a client. Steps 4 and 5 are what make Pulse different from a normal alert tool.</p></div>
    <div class="block"><h2>The pipeline</h2>${flowHTML()}</div>
    <div class="block"><h2>Before and after</h2><p class="lede">One week of the same simulated data. On the left, each small dot is 10 alerts from a simple rule. On the right, each dot is one Pulse incident.</p>${baSVG(b.naivePerWeek, b.perWeek, true)}</div>
    <div class="block"><h2${tipAttr('rules')}>The five failure patterns</h2><p class="lede">Each pattern has its own fingerprint in the data. All of them also need: enough volume to judge, ${S.P.persist} hours of persistence and at least ${money(S.P.minRisk)} an hour at risk.</p>
      <div class="tbl-wrap"><table><thead><tr><th${tipAttr('th.h.prob')}><span>Problem</span></th><th${tipAttr('th.h.when')}><span>Pulse alerts when</span></th><th class="hide-sm"${tipAttr('th.h.group')}><span>Grouped by</span></th><th class="hide-sm"${tipAttr('th.h.risk')}><span>Money at risk means</span></th></tr></thead><tbody>
        <tr><td><b>Sales tracking stopped</b></td><td>Zero sales while clicks are at least half of normal, and about 12 or more sales were expected</td><td class="hide-sm">Tracking tag, then advertiser</td><td class="hide-sm">Spend running with no sales data</td></tr>
        <tr><td><b>Likely bot clicks</b></td><td>Clicks per ad view at least 1.6 times normal and sales per click at most 0.65 times normal</td><td class="hide-sm">Publisher group</td><td class="hide-sm">Extra clicks times cost per click</td></tr>
        <tr><td><b>Overspending</b></td><td>Spend at least 1.5 times the normal level for this hour</td><td class="hide-sm">Advertiser, then publisher group</td><td class="hide-sm">Spend above normal</td></tr>
        <tr><td><b>Ads stopped showing</b></td><td>Ad views at most half the normal level for this hour</td><td class="hide-sm">Publisher group, then advertiser</td><td class="hide-sm">Planned spend not served (Media.net revenue)</td></tr>
        <tr><td><b>Clicks not turning into sales</b></td><td>Sales per click at most half of normal while traffic is normal</td><td class="hide-sm">Advertiser</td><td class="hide-sm">Spend on clicks that do not convert</td></tr>
        <tr><td><b>Ad wearing out</b> <span class="meta">(slow, P3 only)</span></td><td>Clicks per ad view over 48 hours at most 0.75 times the week before</td><td class="hide-sm">Campaign</td><td class="hide-sm">Clicks lost to a tired ad</td></tr>
      </tbody></table></div></div>
    <div class="block two">
      <div class="prose"><h2>Product decisions</h2><ul>
        <li><b>Incidents, not alerts.</b> The unit of work is one cause. Too many alerts is why alert tools get muted.</li>
        <li><b>Ranked by money.</b> A big account's outage outranks noise on a tiny one.</li>
        <li><b>Rules before machine learning.</b> Same-hour comparisons are cheap, explainable and need no training data. Learning comes after there are feedback labels.</li>
        <li><b>A person approves every fix.</b> Fixes are one click, scoped and reversible. Automation is earned rule by rule.</li>
        <li><b>Hourly.</b> Reporting lands hourly. Faster checks would mostly add noise on small numbers.</li></ul></div>
      <div class="prose"><h2>How success is measured</h2><ul>
        <li><b>Main goal:</b> money protected per account per month (waste stopped plus delivery recovered).</li>
        <li><b>Quality:</b> at least 70% of incidents marked useful in the test (85% at full launch); at least 90% of known problems caught.</li>
        <li><b>Speed:</b> median 2 hours or less to detect; 30 minutes or less to act on a P1.</li>
        <li><b>Guardrails:</b> fewer than 3 interruptions per account manager per day; fewer than 5% of people muting Pulse.</li></ul></div>
    </div>
    <div class="block two">
      <div class="prose"><h2>Rollout</h2><ul>
        <li><b>Weeks 0 to 2, replay:</b> run on 90 days of real history and tune settings per industry.</li>
        <li><b>Weeks 3 to 4, silent:</b> live but sends nothing; 10 account managers rate incidents daily.</li>
        <li><b>Weeks 5 to 10, test:</b> 20% of managed accounts, chosen at random by account; compare money lost per incident with the rest.</li>
        <li><b>Week 11 onward:</b> all managed accounts, then self-serve advertisers with P1 alerts only.</li></ul></div>
      <div class="prose"><h2>Edge cases handled</h2><ul>
        <li><b>Late data:</b> data completeness check. Try "Reporting delay" in the scenario lab.</li>
        <li><b>Planned spikes:</b> calendar. Try "Planned retail sale".</li>
        <li><b>Small campaigns:</b> judged daily, not hourly.</li>
        <li><b>Daily and weekly cycles:</b> same-hour comparison over 7 days.</li>
        <li><b>Past spikes in the normal level:</b> middle value, not average.</li>
        <li><b>Several problems at once:</b> each cause becomes its own incident.</li></ul></div>
    </div></div>`;
  refreshExplain();
}

/* ============================== use cases ============================== */
const STORIES = [
  { id: 'pixel', sc: 'PIXEL_SHOP', find: 'CONV_ZERO', t: 'Broken sales tracking', who: 'ShopKart, an online retailer, releases a site update at 11:00. The update removes the code that reports each sale.' },
  { id: 'bot', sc: 'IVT_SPORTS', find: 'IVT', t: 'Bot clicks on one publisher group', who: 'From 12:00, automated clicks arrive through the Sports-Network group of sites. Advertisers pay for each one.' },
  { id: 'runaway', sc: 'RUNAWAY', find: 'SPEND_HIGH', t: 'Budget runaway', who: 'At noon, someone removes the daily spend cap on the HomeNest account by mistake.' },
  { id: 'delay', sc: 'DELAY', t: 'Reporting delay', who: 'The data pipeline runs late. The last 2 hours arrive with only about 30% of the numbers.' },
  { id: 'sale', sc: 'SALE', t: 'Planned sale', who: 'Retail advertisers run a sale from 09:00. Their campaigns spend about twice the normal level, as planned.' }
];
function naiveOn(cs, s) {
  let n = 0; for (let t = s; t <= NOW; t++) for (const c of cs) { if (c.clk[t - 24] < 10) continue; for (const m of METRICS) { const b = c[m][t - 24]; if (b > 0 && Math.abs(c[m][t] / b - 1) > 0.3) { n++; break; } } }
  return n;
}
const HOURS_TO_REPORT = (24 - hod(NOW + 1) + 9) % 24 || 24;   // next 09:00 daily report
function computeStories() {
  const P = { ...DEFAULT_P }, out = {};
  for (const st of STORIES) {
    const sc = SCENARIOS[st.sc], scope = resolveScope(sc.scope);
    const live = [...DEFAULT_LIVE]; if (!live.includes(st.sc)) live.push(st.sc);
    generate(live);
    const o = { n: scope.length, naive: naiveOn(scope, sc.s) };
    if (st.find) {
      const r = detectAt(NOW, P, { calendar: false });
      const inc = r.incidents.find(i => i.type === st.find && i.members.some(c => scope.includes(c)));
      if (inc) { Object.assign(inc, onsetOf(inc, P)); o.inc = inc; o.members = inc.members.length; o.risk = inc.risk; o.ttd = inc.alertedAt - inc.onset + 1; o.sev = inc.sev; o.saved = inc.risk * HOURS_TO_REPORT; }
    }
    if (st.id === 'delay') {
      const on = detectAt(NOW, P, { calendar: false }), off = detectAt(NOW, { ...P, freshness: false }, { calendar: false });
      generate(DEFAULT_LIVE); const base = detectAt(NOW, P, { calendar: false });
      o.held = on.lag ? on.lag.held : 0; o.lagCamp = on.lag ? on.lag.campaigns : 0;
      const baseKeys = new Set(base.incidents.map(i => i.key));
      const extra = off.incidents.filter(i => !baseKeys.has(i.key));
      o.falseInc = extra.length; o.falseP1 = extra.filter(i => i.sev === 'P1').length;
    }
    if (st.id === 'sale') {
      const offc = detectAt(NOW, P, { calendar: false }), onc = detectAt(NOW, P, { calendar: true });
      o.flagOff = offc.incidents.filter(i => i.type === 'SPEND_HIGH' && i.members.some(c => c.vertical === 'Retail')).length;
      o.flagOn = onc.incidents.filter(i => i.type === 'SPEND_HIGH' && i.members.some(c => c.vertical === 'Retail')).length;
      o.supp = onc.suppressed.length;
    }
    out[st.id] = o;
  }
  generate(S.live);   // restore the live data
  return out;
}
/* wireframe: grey boxes and arrows. left = campaigns + signal shape, middle = Pulse, right = outcome */
const SHAPES = {
  pixel: [6, 7, 6.5, 7.5, 7, 6.8, 0.2, 0.2, 0.2], bot: [4, 4.2, 3.9, 4.1, 4, 8.5, 9, 8.8, 9.2],
  runaway: [4, 4.3, 4, 4.2, 4.1, 8.2, 8.6, 8.4, 8.5], delay: [6, 6.3, 6.1, 6.4, 6.2, 6.3, 6.1, 2, 1.8], sale: [4, 4.2, 4, 7.8, 8.1, 8, 8.2, 8.1, 8]
};
function wireSVG(id, o) {
  // 3 stacked panels, top to bottom: what the data shows -> Pulse step -> outcome. Reads at 300 px wide.
  const n = Math.min(id === 'delay' ? 12 : o.members || o.n, 12), boxes = [];
  for (let i = 0; i < n; i++) { const x = 16 + (i % 6) * 26, y = 34 + Math.floor(i / 6) * 20; boxes.push(`<rect x="${x}" y="${y}" width="22" height="15" rx="2" fill="${id === 'delay' ? '#fff' : '#d0d0d5'}" stroke="#9a9aa1" ${id === 'delay' ? 'stroke-dasharray="3 2"' : ''}/>`); }
  const sh = SHAPES[id], pts = sh.map((v, i) => `${180 + i * 15},${80 - v * 5}`), bad = id === 'sale' ? 3 : id === 'delay' ? 7 : sh.findIndex((v, i) => i > 0 && Math.abs(v - sh[i - 1]) > 2);
  const line = `<polyline points="${pts.slice(0, bad).join(' ')}" fill="none" stroke="#4a4a4f" stroke-width="2"/><polyline points="${pts.slice(bad - 1).join(' ')}" fill="none" stroke="${id === 'sale' ? '#4a4a4f' : '#b3134b'}" stroke-width="2.5" ${id === 'sale' || id === 'delay' ? 'stroke-dasharray="5 3"' : ''}/>`;
  const leftLabel = { pixel: `${o.members} campaigns share one tag`, bot: `${o.members} campaigns share one publisher group`, runaway: `${o.members} campaigns in one account`, delay: 'All campaigns, data arriving late', sale: `${o.n} retail campaigns, sale running` }[id];
  const metric = { pixel: 'sales recorded', bot: 'clicks', runaway: 'spend', delay: 'data received', sale: 'spend' }[id];
  const step = { pixel: 'Group by shared tag', bot: 'Group by publisher group', runaway: 'Group by account', delay: 'Check data is complete', sale: 'Check the calendar' }[id];
  const out = {
    pixel: ['1 incident: sales tracking stopped', o.sev], bot: ['1 incident: likely bot clicks', o.sev], runaway: ['1 incident: overspending', o.sev],
    delay: ['1 notice: alerts on hold', ''], sale: ['No alert: expected spike', '']
  }[id];
  const dashed = id === 'delay' || id === 'sale';
  const arrow = y => `<path d="M170 ${y}v16" stroke="#111" stroke-width="1.5"/><path d="M170 ${y + 20}l-5 -7h10z" fill="#111"/>`;
  return `<svg viewBox="0 0 340 236" role="img" aria-label="Diagram: ${esc(leftLabel)}. Pulse step: ${esc(step)}. Result: ${esc(out[0])}.">
    <rect x="1" y="1" width="338" height="96" rx="4" fill="#fff" stroke="#d0d0d5"/>
    <text x="16" y="22" font-size="12" fill="#4a4a4f">${esc(leftLabel)}</text>${boxes.join('')}
    <line x1="180" y1="80" x2="300" y2="80" stroke="#e3e3e6"/>${line}
    <text x="320" y="92" font-size="11" fill="#76767c" text-anchor="end">${metric}</text>
    ${arrow(100)}
    <rect x="30" y="124" width="280" height="36" rx="4" fill="#111"/>
    <text x="170" y="147" font-size="13" font-weight="600" fill="#fff" text-anchor="middle">Pulse: ${esc(step)}</text>
    ${arrow(162)}
    <rect x="30" y="186" width="280" height="44" rx="4" fill="#fff" stroke="${dashed ? '#76767c' : '#111'}" stroke-width="1.5" ${dashed ? 'stroke-dasharray="5 3"' : ''}/>
    ${out[1] ? `<rect x="30" y="186" width="5" height="44" fill="#111"/>` : ''}
    <text x="46" y="213" font-size="13" font-weight="700" fill="#111">${esc(out[0])}</text>
    ${out[1] ? `<text x="296" y="213" font-size="13" font-weight="700" text-anchor="end" fill="${out[1] === 'P1' ? '#b3134b' : '#111'}">${out[1]}</text>` : ''}
  </svg>`;
}
function storyBeats(st, o) {
  const B = (n, h, body, cls = '') => `<div class="beat ${cls}"><h3><em>${n}</em>${h}</h3>${body}</div>`;
  const est = `<p class="est">Estimate: money at risk per hour times the ${HOURS_TO_REPORT} hours until a 09:00 daily report would show it.</p>`;
  switch (st.id) {
    case 'pixel': return B(1, 'What happened', `<p>Clicks stay normal, so nothing looks wrong. But ${o.members} campaigns on one tracking tag now record zero sales, and automatic bidding starts cutting bids because it sees no results.</p>`) +
      B(2, 'A normal alert tool', `<p><span class="big">${num(o.naive)} alerts</span>One per campaign per hour, each saying "sales down 100%". Nobody can tell they share one cause.</p>`) +
      B(3, 'What Pulse does', `<p><span class="big">1 incident, ${o.sev}</span>Groups all ${o.members} campaigns under the shared tag, names the likely cause and offers "Switch to fixed bids". Found after ${o.ttd} hour${o.ttd === 1 ? '' : 's'}.</p>`, 'win') +
      B(4, 'Money and time saved', `<p><span class="big">about ${money(o.saved)}</span>${money(o.risk)} an hour stops being spent blind, ${HOURS_TO_REPORT} hours before the morning report.</p>${est}`, 'result');
    case 'bot': return B(1, 'What happened', `<p>Clicks jump on campaigns shown through Sports-Network. Sales do not move. To a dashboard, more clicks look like good news.</p>`) +
      B(2, 'A normal alert tool', `<p><span class="big">${num(o.naive)} alerts</span>"Clicks up" alerts, often read as good news. No link to the publisher group.</p>`) +
      B(3, 'What Pulse does', `<p><span class="big">1 incident, ${o.sev}</span>Sees clicks up and sales flat on ${o.members} campaigns that share one publisher group. Offers a 24-hour block and a refund claim. Found after ${o.ttd} hour${o.ttd === 1 ? '' : 's'}.</p>`, 'win') +
      B(4, 'Money and time saved', `<p><span class="big">about ${money(o.saved)}</span>${money(o.risk)} an hour of bot clicks stopped, plus evidence for a refund.</p>${est}`, 'result');
    case 'runaway': return B(1, 'What happened', `<p>All ${o.members} HomeNest campaigns start spending about 3 times their normal level in the same hour.</p>`) +
      B(2, 'A normal alert tool', `<p><span class="big">${num(o.naive)} alerts</span>One per campaign. Or none at all, if the tool only checks daily budgets at midnight.</p>`) +
      B(3, 'What Pulse does', `<p><span class="big">1 incident, ${o.sev}</span>Sees the whole account jump at once, which points to a settings change. Pages the on-call person and offers "Cap at 110% of plan". Found after ${o.ttd} hour${o.ttd === 1 ? '' : 's'}.</p>`, 'win') +
      B(4, 'Money and time saved', `<p><span class="big">about ${money(o.saved)}</span>${money(o.risk)} an hour of overspend stopped the same afternoon.</p>${est}`, 'result');
    case 'delay': return B(1, 'What happened', `<p>Numbers from most publisher groups drop by about 70% at the same moment. Nothing is wrong with the campaigns; the data is late.</p>`) +
      B(2, 'A normal alert tool', `<p><span class="big">${o.falseInc} false incidents</span>With the data check off, Pulse itself raises ${o.falseInc} extra incidents (${o.falseP1} of them P1). A simple tool would page the team about every one.</p>`) +
      B(3, 'What Pulse does', `<p><span class="big">1 notice</span>Sees a drop across ${o.lagCamp} campaigns on most publisher groups at once, and recognises late data. Holds ${o.held} alerts and keeps real incidents open on the last complete hour.</p>`, 'win') +
      B(4, 'Time saved', `<p><span class="big">${o.falseP1} pages avoided</span>No one is woken up for a data problem, and trust in P1 pages stays high.</p>`, 'result');
    case 'sale': return B(1, 'What happened', `<p>${o.n} retail campaigns spend about twice the normal level because of a planned sale. Sales rise too.</p>`) +
      B(2, 'A normal alert tool', `<p><span class="big">${num(o.naive)} alerts</span>"Spend up" alerts on every retail campaign, all day.</p>`) +
      B(3, 'What Pulse does', `<p><span class="big">${o.flagOff} → ${o.flagOn} incidents</span>Without a calendar entry, Pulse flags ${o.flagOff}. With the sale on the calendar, ${o.supp} campaigns with a healthy cost per sale are treated as expected. A campaign whose cost per sale gets worse still alerts.</p>`, 'win') +
      B(4, 'Time saved', `<p><span class="big">${num(o.naive)} alerts avoided</span>The team watches the sale's efficiency instead of dismissing alerts.</p>`, 'result');
  }
}
function renderCases() {
  if (!S.stories) { S.stories = computeStories(); recompute(); }
  $('#tab-cases').innerHTML = `<div class="page">
    <div class="page-head"><h1>Five problems, and what Pulse does about each one</h1><p>Each story uses the same simulated data and logic as the live screen. Every number below is computed in your browser. Open any story to watch it happen.</p></div>
    ${STORIES.map(st => { const o = S.stories[st.id]; return `<article class="story" id="story-${st.id}">
      <div><h2>${st.t}</h2><p class="who">${st.who}</p><div class="wire">${wireSVG(st.id, o)}</div>
        <button class="btn primary go" data-story="${st.id}" data-tip="story.go">See it live<small>Opens the live screen with this scenario</small></button></div>
      <div class="beats">${storyBeats(st, o)}</div></article>`; }).join('')}
  </div>`;
  refreshExplain();
}
function openStory(id) {
  const st = STORIES.find(s => s.id === id);
  S.live = [...DEFAULT_LIVE]; if (!S.live.includes(st.sc)) S.live.push(st.sc);
  S.status = {}; S.calendar = false; S.P.freshness = true; S.sel = null;
  recompute();
  const scope = resolveScope(SCENARIOS[st.sc].scope);
  const hit = id === 'delay' ? S.res.list.find(i => i.type === 'DATA_LAG') : S.res.list.find(i => (!st.find || i.type === st.find) && scope.some(c => i.members.includes(c)));
  if (hit) S.sel = hit.key;
  setTab('live'); renderQueue(); renderDetail();
  toast(id === 'sale' ? 'Planned sale running. Tick "Calendar: retail sale planned today" to see the spikes handled as expected.' : id === 'delay' ? 'Reporting delay running. Turn off the data completeness check to see the false alarms it prevents.' : `${st.t}: scenario running.`);
  window.scrollTo({ top: 0 });
}

/* ============================== tabs ============================== */
function setTab(t) {
  S.tab = t;
  $$('.tab-btn').forEach(b => b.setAttribute('aria-selected', b.dataset.tab === t));
  $$('.tab').forEach(x => x.classList.toggle('active', x.id === 'tab-' + t));
  if (t === 'live') { renderDetail(); refreshExplain(); }
  if (t === 'cases') renderCases();
  if (t === 'tune') renderTune();
  if (t === 'notify') renderNotify();
  if (t === 'how') renderHow();
}

/* ============================== tooltips: hover, focus, tap ============================== */
const tipEl = $('#tip');
let tipFor = null, tipTimer = null;
function showTip(el) {
  const d = TIPS[el.dataset.tip]; if (!d) return;
  tipFor = el;
  tipEl.innerHTML = `<b>${esc(d[0])}</b><span class="why">${esc(d[1])}</span>`;
  tipEl.hidden = false;
  el.setAttribute('aria-describedby', 'tip');
  const r = el.getBoundingClientRect(), tw = tipEl.offsetWidth, th = tipEl.offsetHeight;
  let x = Math.min(Math.max(8, r.left + r.width / 2 - tw / 2), innerWidth - tw - 8);
  let y = r.bottom + 8; if (y + th > innerHeight - 8) y = Math.max(8, r.top - th - 8);
  tipEl.style.left = x + 'px'; tipEl.style.top = y + 'px';
}
function hideTip() { clearTimeout(tipTimer); if (tipFor) tipFor.removeAttribute('aria-describedby'); tipFor = null; tipEl.hidden = true; }
document.addEventListener('mouseover', e => {
  const el = e.target.closest('[data-tip]');
  if (el === tipFor) return;
  clearTimeout(tipTimer);
  if (!el) { if (tipFor && !tipFor.contains(document.activeElement)) hideTip(); return; }
  tipTimer = setTimeout(() => showTip(el), 350);
});
document.addEventListener('focusin', e => { const el = e.target.closest('[data-tip]'); if (el && !document.body.classList.contains('touring')) showTip(el); });
document.addEventListener('focusout', () => hideTip());
document.addEventListener('pointerdown', e => {
  if (e.pointerType !== 'touch') return;
  const el = e.target.closest('[data-tip]');
  if (!el) { hideTip(); return; }
  if (tipFor === el && !el.matches('button,a,input,label')) { hideTip(); return; }
  showTip(el); clearTimeout(tipTimer); tipTimer = setTimeout(hideTip, 4000);
});
addEventListener('scroll', () => { if (tipFor && document.activeElement !== tipFor) hideTip(); }, { passive: true });
document.addEventListener('keydown', e => { if (e.key === 'Escape') { hideTip(); if (!$('#tour').hidden) endTour(); if (!$('#modal').hidden) closeModal(); } });

/* ============================== explain mode ============================== */
function refreshExplain() {
  const layer = $('#xm-layer'); layer.innerHTML = '';
  if (!S.explain) return;
  const scope = [document.querySelector('.top'), document.querySelector('.tab.active')];
  const seen = new Map(), items = [];
  scope.forEach(root => $$('[data-tip]', root).forEach(el => {
    if (!el.offsetParent && el.getClientRects().length === 0) return;
    const k = el.dataset.tip; if (seen.has(k) || !TIPS[k]) return;
    seen.set(k, items.length + 1); items.push({ k, el });
  }));
  const sx = scrollX, sy = scrollY;
  layer.innerHTML = items.map((it, i) => { const r = it.el.getBoundingClientRect(); return `<span class="xm" style="left:${Math.max(r.left, 12) + sx}px;top:${Math.max(r.top, 12) + sy}px">${i + 1}</span>`; }).join('');
  $('#xpanel').innerHTML = `<h2>What each number means <button class="btn sm" id="xClose">Close</button></h2><p class="meta" style="margin-top:4px">${items.length} parts of this screen. Select one to jump to it.</p>
    <ol>${items.map((it, i) => `<li tabindex="0" data-xi="${i}"><span class="k">${i + 1}</span><div><b>${esc(TIPS[it.k][0])}</b><span>${esc(TIPS[it.k][1])}</span></div></li>`).join('')}</ol>`;
  refreshExplain.items = items;
}
function setExplain(on) {
  S.explain = on; document.body.classList.toggle('explain', on);
  $('#explainBtn').setAttribute('aria-pressed', on); $('#xpanel').hidden = !on;
  if (on && chart) chart.resize();
  requestAnimationFrame(refreshExplain);
}
addEventListener('resize', () => { if (S.explain) refreshExplain(); });

/* ============================== guided tour ============================== */
const TOUR = [
  { sel: ['#status', '#metrics'], h: 'What Pulse watches', p: 'Every hour Pulse checks 124 advertiser campaigns: ad views, clicks, spend and sales. This line tells you what needs attention right now and how much money is at risk.' },
  { sel: ['#queue li:first-child .strip'], h: 'One incident', p: 'Each line is one problem with one likely cause, even if many campaigns are hit. The darkest badge, P1, is the most urgent. The list is sorted by money at risk.' },
  { sel: ['#why'], h: 'Why it was flagged', p: 'Pulse shows its evidence: what changed, against what normal looks like for this hour, and how many campaigns share the cause. Below it, the explanations it ruled out.' },
  { sel: ['#actions'], h: 'What to do', p: 'Suggested fixes, ready in one click. A person always approves, and every fix can be undone. Pulse never changes a client\'s money on its own.' },
  { sel: ['#noise'], h: 'How noise is kept low', p: 'On the same data, a simple "moved 30% since yesterday" rule sends about 14,300 alerts a week. Pulse sends about 12, because it groups by cause and ranks by money.' }
];
let tourI = 0;
function startTour() {
  store.set('v2tour', 'seen'); $('#offer').innerHTML = '';
  if (S.explain) setExplain(false);
  S.sel = S.res.list.find(i => !S.status[i.key] && actionsFor(i).length) ? S.res.list.find(i => !S.status[i.key] && actionsFor(i).length).key : S.sel;
  setTab('live'); renderQueue(); renderDetail();
  document.body.classList.add('touring'); hideTip();
  tourI = 0; $('#tour').hidden = false; showStep();
}
function endTour() { $('#tour').hidden = true; $('#tour').innerHTML = ''; document.body.classList.remove('touring'); $('#tourBtn').focus(); }
function tourEls() { return TOUR[tourI].sel.map(s => $(s)).filter(Boolean); }
function placeTour() {
  const els = tourEls(), spot = $('#tour .spot'), card = $('#tour .card'); if (!els.length || !spot) return;
  const rs = els.map(e => e.getBoundingClientRect());
  const L = Math.min(...rs.map(r => r.left)) - 6, T = Math.min(...rs.map(r => r.top)) - 6, R = Math.max(...rs.map(r => r.right)) + 6, B = Math.max(...rs.map(r => r.bottom)) + 6;
  Object.assign(spot.style, { left: L + 'px', top: T + 'px', width: (R - L) + 'px', height: (B - T) + 'px' });
  if (innerWidth <= 600) return;   // phone: card is pinned to the bottom by CSS
  const cw = card.offsetWidth, ch = card.offsetHeight;
  let cx, cy;
  if (R + 16 + cw <= innerWidth - 16) { cx = R + 16; cy = T; }                       // right of the target
  else if (L - 16 - cw >= 16) { cx = L - 16 - cw; cy = T; }                          // left of the target
  else { cx = Math.min(Math.max(16, L), innerWidth - cw - 16); cy = B + 12 + ch <= innerHeight - 16 ? B + 12 : T - ch - 12; }   // below, else above
  card.style.left = cx + 'px'; card.style.top = Math.max(16, Math.min(cy, innerHeight - ch - 16)) + 'px';
}
function showStep() {
  const st = TOUR[tourI], els = tourEls();
  if (!els.length) { if (tourI < TOUR.length - 1) { tourI++; showStep(); } else endTour(); return; }
  const h = els.reduce((s, e) => s + e.getBoundingClientRect().height, 0);
  els[0].scrollIntoView({ block: h > innerHeight * 0.5 ? 'start' : 'center', behavior: 'auto' });
  if (h > innerHeight * 0.5) scrollBy(0, -72);
  $('#tour').innerHTML = `<div class="spot"></div>
    <div class="card" role="dialog" aria-modal="true" aria-labelledby="tourH">
      <div class="step">Step ${tourI + 1} of ${TOUR.length}</div><h2 id="tourH">${st.h}</h2><p>${st.p}</p>
      <div class="dots" aria-hidden="true">${TOUR.map((_, i) => `<i class="${i <= tourI ? 'on' : ''}"></i>`).join('')}</div>
      <div class="nav"><button class="skip2" data-tour="skip">Skip tour</button>${tourI ? '<button class="btn sm" data-tour="back">Back</button>' : ''}<button class="btn sm primary" data-tour="next">${tourI === TOUR.length - 1 ? 'Finish' : 'Next'}</button></div></div>`;
  placeTour();
  $('[data-tour="next"]').focus({ preventScroll: true });
}
addEventListener('scroll', () => { if (!$('#tour').hidden) placeTour(); }, { passive: true });
addEventListener('resize', () => { if (!$('#tour').hidden) placeTour(); });
function renderOffer() {
  if (store.get('v2tour', null) || Q.get('tour') === '0') return;
  $('#offer').innerHTML = `<div class="offer" role="region" aria-label="Tour offer"><p><b>New to Pulse?</b> A 5-step tour shows what it watches, one incident, and what to do about it. About a minute.</p>
    <button class="btn sm primary" data-offer="start">Start the tour</button><button class="btn sm" data-offer="no">No thanks</button></div>`;
}

/* ============================== actions, modal, toast ============================== */
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), 2600); }
function nowStamp() { const d = new Date(); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); }
let modalReturn = null;
function closeModal() { $('#modal').hidden = true; if (modalReturn) modalReturn.focus(); }
function confirmAction(inc, a, from) {
  modalReturn = from;
  const m = $('#modal');
  m.innerHTML = `<div class="mbox"><h2 id="mTitle">${esc(a.label)}?</h2><p class="meta" style="margin-top:4px">${esc(title(inc))}</p>
    <ul><li>${esc(a.change)}</li><li>Recorded in the audit log with your name. One click undoes it.</li>${inc.members.length ? `<li>Applies to ${inc.members.length} campaign${inc.members.length === 1 ? '' : 's'}: ${inc.members.slice(0, 4).map(c => esc(camp(c))).join('; ')}${inc.members.length > 4 ? ' and more' : ''}.</li>` : ''}</ul>
    <div class="row"><button class="btn sm" data-m="cancel">Cancel</button><button class="btn sm primary" data-m="ok">Approve: ${esc(a.label)}</button></div></div>`;
  m.hidden = false; $('[data-m="ok"]', m).focus();
  m.onclick = e => {
    const b = e.target.closest('[data-m]'); if (!b && e.target !== m) return;
    closeModal();
    if (b && b.dataset.m === 'ok') {
      const label = a.id === 'expected' ? 'Marked expected' : a.id === 'snooze' ? 'Snoozed 1 hour' : 'Fixed';
      S.status[inc.key] = { label, at: nowStamp() };
      S.log.push({ at: nowStamp(), txt: `${a.label}: ${title(inc)}` });
      toast(`${a.label}: approved. The incident moved to Handled.`);
      render();
    }
  };
}
document.addEventListener('click', e => {
  const tb = e.target.closest('.tab-btn'); if (tb) { setTab(tb.dataset.tab); return; }
  const strip = e.target.closest('.strip'); if (strip) { S.sel = strip.dataset.key; renderQueue(); renderDetail(); refreshExplain(); $(`.strip[data-key="${CSS.escape(S.sel)}"]`).focus(); return; }
  const sc = e.target.closest('[data-sc]');
  if (sc) {
    const k = sc.dataset.sc;
    if (k === 'RESET') { S.live = [...DEFAULT_LIVE]; S.status = {}; S.calendar = false; S.P.freshness = true; S.sel = null; toast('Back to the starting 3 problems.'); }
    else if (S.live.includes(k)) { S.live = S.live.filter(x => x !== k); toast(`${LAB[k][0]}: removed.`); }
    else { S.live.push(k); S.sel = null; toast(`${LAB[k][0]}: added. Pulse checked all ${CS.length} campaigns again.`); }
    recompute();
    if (k !== 'RESET' && S.live.includes(k)) {
      const hit = k === 'DELAY' ? S.res.list.find(i => i.type === 'DATA_LAG') : S.res.list.find(i => !S.status[i.key] && resolveScope(SCENARIOS[k].scope).some(c => i.members.includes(c)));
      if (hit) { S.sel = hit.key; renderQueue(); renderDetail(); }
    }
    const again = $(`[data-sc="${k}"]`); if (again) again.focus();
    return;
  }
  const act = e.target.closest('[data-act]');
  if (act) {
    const i = S.res.list.find(x => x.key === S.sel); if (!i) return;
    const id = act.dataset.act;
    const a = id === 'expected' ? { id, label: 'Mark as expected', change: 'Closes the incident as expected and adds the pattern to the calendar for this advertiser, so it does not alert again.' }
      : id === 'snooze' ? { id, label: 'Snooze 1 hour', change: 'Pauses messages for 1 hour. Pulse alerts again earlier if money at risk grows by half.' } : actionsFor(i).find(x => x.id === id);
    confirmAction(i, a, act); return;
  }
  const fb = e.target.closest('[data-fb]');
  if (fb) { S.fb[S.sel] = fb.dataset.fb; store.set('v2fb', S.fb); renderDetail(); toast(fb.dataset.fb === 'up' ? 'Marked useful.' : 'Marked not useful. This rule gets stricter for this account.'); return; }
  const story = e.target.closest('[data-story]'); if (story) { openStory(story.dataset.story); return; }
  const off = e.target.closest('[data-offer]'); if (off) { if (off.dataset.offer === 'start') startTour(); else { store.set('v2tour', 'skipped'); $('#offer').innerHTML = ''; toast('You can start the tour any time from the header.'); } return; }
  const tr = e.target.closest('[data-tour]');
  if (tr) { const a = tr.dataset.tour; if (a === 'skip') endTour(); else if (a === 'back') { tourI--; showStep(); } else if (tourI === TOUR.length - 1) endTour(); else { tourI++; showStep(); } return; }
  if (e.target.id === 'tourBtn') { startTour(); return; }
  if (e.target.closest('#explainBtn')) { setExplain(!S.explain); return; }
  if (e.target.id === 'xClose') { setExplain(false); $('#explainBtn').focus(); return; }
  const xi = e.target.closest('[data-xi]');
  if (xi) { const it = refreshExplain.items[+xi.dataset.xi]; it.el.scrollIntoView({ block: 'center' }); setTimeout(() => { if (it.el.focus) it.el.focus({ preventScroll: true }); }, 50); return; }
  if (e.target.id === 'btReset') { Object.assign(S.P, { k: 3.5, persist: 2, minClicks: 8, p1: 600, p2: 100, minRisk: 25 }); renderTune(); recompute(); }
});
document.addEventListener('keydown', e => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('[data-xi]')) { e.preventDefault(); e.target.click(); return; }
  // tablist: left / right arrows move between tabs
  if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && e.target.matches('.tab-btn')) {
    const tabs = $$('.tab-btn'), i = tabs.indexOf(e.target), n = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
    setTab(n.dataset.tab); n.focus(); e.preventDefault(); return;
  }
  // keep keyboard focus inside an open dialog (tour card or approval modal)
  if (e.key === 'Tab') {
    const box = !$('#modal').hidden ? $('#modal .mbox') : !$('#tour').hidden ? $('#tour .card') : null; if (!box) return;
    const f = $$('button', box); if (!f.length) return;
    if (e.shiftKey && document.activeElement === f[0]) { f[f.length - 1].focus(); e.preventDefault(); }
    else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { f[0].focus(); e.preventDefault(); }
    else if (!box.contains(document.activeElement)) { f[0].focus(); e.preventDefault(); }
  }
});
$$('.tab-btn').forEach(b => { b.setAttribute('aria-controls', 'tab-' + b.dataset.tab); b.id = 'tb-' + b.dataset.tab; $('#tab-' + b.dataset.tab).setAttribute('aria-labelledby', b.id); $('#tab-' + b.dataset.tab).removeAttribute('aria-label'); });
$('#tgCal').addEventListener('change', e => { S.calendar = e.target.checked; if (S.calendar && !S.live.includes('SALE')) S.live.push('SALE'); recompute(); toast(S.calendar ? 'Retail sale added to the calendar.' : 'Calendar entry removed.'); });
$('#tgFresh').addEventListener('change', e => { S.P.freshness = e.target.checked; recompute(); toast(S.P.freshness ? 'Data completeness check on.' : 'Data completeness check off. Late data now looks like outages.'); });
let slT = null;
document.addEventListener('input', e => {
  const s = e.target.closest('[data-sl]'); if (!s) return;
  const k = s.dataset.sl, def = SLIDERS.find(x => x.k === k);
  S.P[k] = +s.value; $('#v_' + k).textContent = def.fmt(S.P[k]);
  clearTimeout(slT); slT = setTimeout(() => { runBacktest(k !== 'k' && k !== 'p1' && k !== 'p2'); recompute(); }, 120);
});

/* ============================== boot + deep links ============================== */
// Same links as the classic view: ?sc=DELAY&fresh=0  ?sc=SALE&cal=1  ?tab=tune  ?sel=CONV_ZERO
// Extra: ?story=pixel|bot|runaway|delay|sale   ?tour=0 hides the first-visit offer   ?tour=1 starts it
const Q = new URLSearchParams(location.search);
(Q.get('sc') || '').split(',').forEach(k => { if (SCENARIOS[k] && !S.live.includes(k)) S.live.push(k); });
if (Q.get('cal') === '1') S.calendar = true;
if (Q.get('fresh') === '0') S.P.freshness = false;
recompute();
if (Q.get('sel')) { const i = S.res.list.find(x => x.type === Q.get('sel')); if (i) { S.sel = i.key; render(); } }
if (Q.get('story') && STORIES.find(s => s.id === Q.get('story'))) openStory(Q.get('story'));
else if (Q.get('tab') && $(`[data-tab="${Q.get('tab')}"]`)) setTab(Q.get('tab'));
renderOffer();
if (Q.get('tour') === '1') startTour();
