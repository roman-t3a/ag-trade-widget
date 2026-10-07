'use strict';
// Trojan bundles: clustering, summary, history and rule matching (pure core of the trade widget)
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const C = require(path.join(__dirname, '..', '..', 'ag-trade-widget.user.js'));

const F1 = 'u6PJFunderAAAAAAAAAAAAAAAAAAAAAAAAAAAAXq2w', F2 = '5tzFFunderBBBBBBBBBBBBBBBBBBBBBBBBBBBBuAi9', F3 = 'AobVFunderCCCCCCCCCCCCCCCCCCCCCCCCCCCCSyrS';
const w = (i, funder, bal, o = {}) => Object.assign({
  walletAddress: 'W' + String(i).padStart(43, 'x'), currentTokenBalance: bal, amountTokensBought: o.bought ?? bal, amountTokensReceived: 0, amountTokensMinted: 0,
  amountTokensSold: o.sold ?? 0, amountNativeSpent: o.spent ?? 1, amountNativeEarned: o.earned ?? 0, numBuys: 1, numSells: o.sells ?? 0, numTransfersOut: o.sent ?? 0,
  amountSniped: o.sniped ?? 0, amountBundled: o.bundled ?? 0, amountReceivedFromDev: o.dev ?? 0, amountReceivedFromInsider: 0,
  lastBuyTimestamp: 1000, lastSellTimestamp: o.lastSell ?? 0,
  fundingInfo: funder ? { walletAddress: 'W' + i, firstNativeFunderAddress: funder, firstNativeFundingAmount: o.fund ?? 1.25 } : null,
}, o.extra || {});
// 3 wallets of F1 (60M), 2 of F2 (20M, dev-linked), 1 alone of F3 (not a bundle), 1 without funding info
const rows = (f1 = [30e6, 20e6, 10e6], f2 = [12e6, 8e6], o = {}) => [
  ...f1.map((b, i) => w(i, F1, b, { bought: [30e6, 20e6, 10e6][i], sniped: i === 0 ? 1 : 0, ...(o.f1 || {}) })),
  ...f2.map((b, i) => w(10 + i, F2, b, { bought: [12e6, 8e6][i], dev: i === 0 ? 5 : 0, fund: 0.8, ...(o.f2 || {}) })),
  w(20, F3, 50e6), w(21, null, 9e6),
];

test('clusterize groups 2+ wallets by first funder, biggest first', () => {
  const cl = C.clusterize(rows(), 1e9, 1e-7);
  assert.deepEqual(cl.map((c) => [c.id, c.n]), [[F1, 3], [F2, 2]]);
  const [a, b] = cl;
  assert.equal(a.bal, 60e6);
  assert.equal(a.pct, 6);
  assert.equal(a.left, 1);
  assert.equal(a.sniper, true);
  assert.equal(a.dev, false);
  assert.equal(a.sameAmt, true);
  assert.equal(a.value, 6);
  assert.equal(a.pnl, 0 - 3 + 6);
  assert.equal(b.dev, true);
  assert.equal(b.fundAmt, 0.8);
  assert.deepEqual(a.wallets.map((x) => x.bal), [30e6, 20e6, 10e6]);
});

test('clusterize: partial sells, custom supply, hot funders, junk input', () => {
  const cl = C.clusterize(rows([15e6, 20e6, 10e6]), 2e9);
  assert.equal(cl[0].left, 45 / 60);
  assert.equal(cl[0].pct, 45e6 / 2e9 * 100);
  assert.equal(cl[0].value, null, 'no price → no value');
  const many = Array.from({ length: 20 }, (_, i) => w(100 + i, F3, 1e6));
  assert.equal(C.clusterize(many)[0].hot, true, 'over BUNDLE_MAX wallets = hot wallet, not a bundle');
  assert.deepEqual(C.clusterize(null), []);
  assert.deepEqual(C.clusterize([null, {}, { walletAddress: 'x' }]), []);
  const diff = C.clusterize([w(1, F1, 5, { fund: 1 }), w(2, F1, 5, { fund: 2 })])[0];
  assert.equal(diff.sameAmt, false);
});

test('bundleSummary', () => {
  const r = rows(), s = C.bundleSummary(C.clusterize(r), r);
  assert.equal(s.clusters, 2);
  assert.equal(s.wallets, 5);
  assert.ok(Math.abs(s.held - 8) < 1e-9);
  assert.equal(s.snipers, 1);
  assert.equal(s.dev, 1);
  assert.equal(s.risk, Math.round(8 * 1.6 + 12 + 1.5));
  assert.equal(s.level, 'low');
  const empty = C.bundleSummary([], []);
  assert.equal(empty.clusters, 0);
  assert.equal(empty.risk, 0);
  const hot = C.bundleSummary(C.clusterize(Array.from({ length: 20 }, (_, i) => w(100 + i, F3, 10e6))), []);
  assert.equal(hot.clusters, 0, 'hot wallets are left out of the summary');
});

// history helper: snapshots at t (ms) of [f1 balances], [f2 balances]
const hist = (pts, o = {}) => {
  let h = [];
  for (const [t, f1, f2, ro] of pts) h = C.pushPoint(h, C.bundlePoint(C.clusterize(rows(f1, f2, ro || o)), t), 10 * 60e3);
  return h;
};
const R = (o) => Object.assign({ who: 'any', when: 'sell', pct: 30, windowSec: 60, scope: 'this', then: 'sell', sellPct: 100 }, o);

test('pushPoint keeps the window and caps the size', () => {
  let h = [];
  for (let t = 0; t < 1000; t++) h = C.pushPoint(h, { at: t * 1000, total: 0, c: {} }, 600e3);
  assert.equal(h.length, 400, 'capped');
  assert.equal(h[h.length - 1].at, 999000);
  let k = [];
  for (let t = 0; t < 100; t++) k = C.pushPoint(k, { at: t * 10000, total: 0, c: {} }, 300e3);
  assert.equal(k[0].at, 990000 - 300000, 'older than the window is dropped');
});

test('rule: sell ≥ X% within the window', () => {
  const h = hist([[0, [30e6, 20e6, 10e6], [12e6, 8e6]], [30000, [30e6, 20e6, 10e6], [12e6, 8e6]], [60000, [10e6, 20e6, 10e6], [12e6, 8e6]]]);
  const cl = C.clusterize(rows([10e6, 20e6, 10e6], [12e6, 8e6]));
  const m = C.bundleMatches(R({}), h, cl, 60000);
  assert.equal(m.length, 1);
  assert.equal(m[0].id, F1);
  assert.ok(Math.abs(m[0].pct - 33.33) < 0.1);
  assert.equal(C.bundleMatches(R({ pct: 40 }), h, cl, 60000).length, 0, 'below the threshold');
  // same drop spread over 3 min: outside a 60s window
  const slow = hist([[0, [30e6, 20e6, 10e6], [12e6, 8e6]], [90000, [20e6, 20e6, 10e6], [12e6, 8e6]], [180000, [10e6, 20e6, 10e6], [12e6, 8e6]]]);
  assert.equal(C.bundleMatches(R({}), slow, cl, 180000).length, 0);
  assert.equal(C.bundleMatches(R({ windowSec: 200 }), slow, cl, 180000).length, 1);
});

test('rule: who filters', () => {
  const h = hist([[0, [30e6, 20e6, 10e6], [12e6, 8e6]], [30000, [15e6, 10e6, 5e6], [6e6, 4e6]]]);
  const cl = C.clusterize(rows([15e6, 10e6, 5e6], [6e6, 4e6]));
  const ids = (o, watch) => C.bundleMatches(R(o), h, cl, 30000, watch).map((x) => x.id);
  assert.deepEqual(ids({}), [F1, F2]);
  assert.deepEqual(ids({ who: 'dev' }), [F2]);
  assert.deepEqual(ids({ who: 'snipers' }), [F1]);
  assert.deepEqual(ids({ who: 'min', minPct: 2 }), [F1]);
  assert.deepEqual(ids({ who: 'top3' }), [F1, F2]);
  assert.deepEqual(ids({ who: 'funder' }, [F2]), [F2]);
  assert.deepEqual(ids({ who: 'funder', funder: F1 }), [F1]);
  assert.deepEqual(ids({ who: 'funder' }), []);
});

test('rule: exit fires on the crossing only', () => {
  const pts = [[0, [30e6, 20e6, 10e6], [12e6, 8e6]], [30000, [3e6, 2e6, 0.5e6], [12e6, 8e6]]];
  const cl = C.clusterize(rows(pts[1][1], pts[1][2]));
  assert.equal(C.bundleMatches(R({ when: 'exit', pct: 90 }), hist(pts), cl, 30000)[0].id, F1);
  const already = hist([[0, [3e6, 2e6, 0.5e6], [12e6, 8e6]], [30000, [3e6, 2e6, 0.5e6], [12e6, 8e6]]]);
  assert.equal(C.bundleMatches(R({ when: 'exit', pct: 90 }), already, cl, 30000).length, 0, 'was already out when we started watching');
});

test('rule: accumulate / send / new', () => {
  const h = hist([[0, [30e6, 20e6, 10e6], [12e6, 8e6]], [30000, [30e6, 20e6, 10e6], [12e6, 8e6], { f1: { spent: 2, sent: 1 } }]]);
  const cl = C.clusterize(rows(undefined, undefined, { f1: { spent: 2, sent: 1 } }));
  const acc = C.bundleMatches(R({ when: 'acc', sol: 2 }), h, cl, 30000);
  assert.equal(acc.length, 1);
  assert.equal(acc[0].sol, 3);
  assert.equal(C.bundleMatches(R({ when: 'acc', sol: 4 }), h, cl, 30000).length, 0);
  const snd = C.bundleMatches(R({ when: 'send' }), h, cl, 30000);
  assert.equal(snd.length, 1);
  assert.equal(snd[0].n, 3);
  // new: F2 appears 25s after we started watching
  let h2 = C.pushPoint([], C.bundlePoint(C.clusterize(rows(undefined, [])), 0), 600e3);
  h2 = C.pushPoint(h2, C.bundlePoint(C.clusterize(rows()), 25000), 600e3);
  const nw = C.bundleMatches(R({ when: 'new', pct: 1 }), h2, C.clusterize(rows()), 25000);
  assert.deepEqual(nw.map((x) => x.id), [F2]);
  assert.equal(C.bundleMatches(R({ when: 'new', pct: 5 }), h2, C.clusterize(rows()), 25000).length, 0, 'too small');
  let h3 = C.pushPoint([], C.bundlePoint(C.clusterize(rows(undefined, [])), 0), 600e3);
  h3 = C.pushPoint(h3, C.bundlePoint(C.clusterize(rows()), 5000), 600e3);
  assert.equal(C.bundleMatches(R({ when: 'new', pct: 1 }), h3, C.clusterize(rows()), 5000).length, 0, 'first seconds after opening a coin are not "new"');
});

test('rule: all bundles out (reversed rule → buy)', () => {
  const pts = [[0, [30e6, 20e6, 10e6], [12e6, 8e6]], [30000, [1e6, 0, 0], [0.5e6, 0]]];
  const cl = C.clusterize(rows(pts[1][1], pts[1][2]));
  const m = C.bundleMatches(R({ when: 'allout', pct: 2, then: 'buy' }), hist(pts), cl, 30000);
  assert.equal(m.length, 1);
  assert.equal(m[0].id, '*');
  const never = hist([[0, [1e6, 0, 0], [0.5e6, 0]], [30000, [1e6, 0, 0], [0.5e6, 0]]]);
  assert.equal(C.bundleMatches(R({ when: 'allout', pct: 2 }), never, cl, 30000).length, 0, 'never had bundles above the line');
});

test('rule: watched funder', () => {
  const h = hist([[0, [30e6, 20e6, 10e6], [12e6, 8e6]]]);
  const m = C.bundleMatches(R({ who: 'funder', when: 'funder' }), h, C.clusterize(rows()), 0, [F2]);
  assert.equal(m.length, 1);
  assert.equal(m[0].id, F2);
});

test('bundleMatches: empty input is safe', () => {
  assert.deepEqual(C.bundleMatches(R({}), [], [], 0), []);
  assert.deepEqual(C.bundleMatches(R({}), null, null, 0), []);
});

test('ruleText', () => {
  assert.equal(C.ruleText(R({ scope: 'held' })), 'When any bundle sells ≥ 30% of its bag within 60s on a coin I hold, sell 100% of my bag');
  assert.equal(C.ruleText(R({ who: 'min', minPct: 5, when: 'exit', pct: 90, then: 'alert' })), 'When a bundle holding ≥ 5% has sold ≥ 90% of what it got on this coin, alert me');
  assert.equal(C.ruleText(R({ when: 'allout', pct: 2, then: 'buy', buySol: 0.2, mode: 'paper', scope: 'any' })), 'When all bundles together hold ≤ 2% of supply on any coin I open, buy ◎ 0.2 (paper)');
});
