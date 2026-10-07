'use strict';
// Trojan bundles: Trojan's own grouping (bundled-positions vs positions), summary, history and rule matching
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const C = require(path.join(__dirname, '..', '..', 'ag-trade-widget.user.js'));

const B1 = 'GZVSprimaryAAAAAAAAAAAAAAAAAAAAAAAAAAAALM9b', B2 = '5oHSprimaryBBBBBBBBBBBBBBBBBBBBBBBBBBBBU3YU', L = 'AYEuLoneWalletCCCCCCCCCCCCCCCCCCCCCCCCCzP88';
const row = (w, bal, o = {}) => ({
  walletAddress: w, currentTokenBalance: bal, amountTokensBought: o.bought ?? bal, amountTokensReceived: 0, amountTokensMinted: 0, amountTokensSold: o.sold ?? 0,
  amountNativeSpent: o.spent ?? 1, amountNativeEarned: o.earned ?? 0, numBuys: o.buys ?? 1, numSells: o.sells ?? 0, numTransfersOut: o.sent ?? 0,
  amountSniped: o.sniped ?? 0, amountBundled: o.bundled ?? 0, amountReceivedFromDev: o.dev ?? 0, amountReceivedFromInsider: 0, lastBuyTimestamp: 1000, lastSellTimestamp: o.lastSell ?? 0,
});
// bundled-positions: B1 = 5 wallets (60M), B2 = 3 wallets (20M, dev-linked), L = a lone wallet (50M) · positions: each wallet alone
const snap = (b1 = 60e6, b2 = 20e6, o = {}) => ({
  bp: [row(L, 50e6), row(B1, b1, { bought: 60e6, buys: 10, sniped: 1, ...(o.b1 || {}) }), row(B2, b2, { bought: 20e6, buys: 8, dev: 2, ...(o.b2 || {}) })],
  pos: [row(L, 50e6), row(B1, 13e6, { buys: 2 }), row(B2, 7e6, { buys: 3 }), row('Other1xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', 9e6)],
});
const bund = (b1, b2, o, meta) => { const s = snap(b1, b2, o); return C.trojanBundles(s.bp, s.pos, meta, 1e9, o && o.px); };

test('trojanBundles: a bundled row that is not the wallet alone = a bundle (Trojan grouping)', () => {
  const cl = bund();
  assert.deepEqual(cl.map((c) => c.id), [B1, B2], 'the lone wallet is not a bundle');
  const [a, b] = cl;
  assert.equal(a.bal, 60e6);
  assert.equal(a.pct, 6);
  assert.equal(a.left, 1);
  assert.equal(a.sniper, true);
  assert.equal(a.buys, 10);
  assert.equal(b.dev, true);
  assert.equal(a.n, null, 'wallet count unknown without Trojan\'s table');
  const pxd = bund(undefined, undefined, { px: 1e-7 });
  assert.equal(pxd[0].value, 6);
  assert.equal(pxd[0].pnl, -1 + 6);
});

test('trojanBundles: a wallet missing from the top-100 alone is a bundle; same balance but more buys is a bundle', () => {
  const s = snap();
  s.pos = s.pos.filter((p) => p.walletAddress !== B1);
  assert.ok(C.trojanBundles(s.bp, s.pos).some((c) => c.id === B1));
  const t = snap();
  t.pos[1] = row(B1, 60e6, { buys: 2 });
  assert.ok(C.trojanBundles(t.bp, t.pos).some((c) => c.id === B1), 'buys differ');
  const u = snap();
  u.pos[1] = row(B1, 60e6, { buys: 10 });
  assert.ok(!C.trojanBundles(u.bp, u.pos).some((c) => c.id === B1), 'identical to the wallet alone → lone wallet');
});

test('trojanBundles: without wallet rows, only what Trojan\'s table says is a bundle', () => {
  const s = snap();
  assert.deepEqual(C.trojanBundles(s.bp, null), []);
  const meta = { [B2]: { label: 'Beanzz', n: 2, conf: 'high', wallets: [row('Kid1xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', 4e6), row(B2, 16e6)] }, [L]: { n: 1 } };
  const cl = C.trojanBundles(s.bp, null, meta);
  assert.deepEqual(cl.map((c) => c.id), [B2]);
  assert.equal(cl[0].label, 'Beanzz');
  assert.equal(cl[0].n, 2);
  assert.equal(cl[0].conf, 'high');
  assert.deepEqual(cl[0].wallets.map((w) => w.bal), [16e6, 4e6]);
  assert.deepEqual(C.trojanBundles(null, null), []);
  assert.deepEqual(C.trojanBundles([null, {}], []), []);
});

test('trojanMeta reads Trojan\'s aggregate table rows', () => {
  const kid = (w) => row(w, 1);
  const m = C.trojanMeta([
    { type: 'aggregate', id: 'aggregate-' + B1, walletLabel: 'GZVS...LM9b', primaryWalletAddress: 'GZVS', bundlerConfidence: 'high', metrics: { walletAddress: B1 }, children: [kid('a'), kid('b'), kid('c'), kid('d')] },
    { type: 'aggregate', id: 'aggregate-' + B2, walletLabel: 'Beanzz', primaryWalletAddress: 'x', children: [{ metrics: kid('x') }, kid('y')] },
    { type: 'position', id: 'p1' }, null,
  ]);
  assert.deepEqual(Object.keys(m).sort(), [B1, B2].sort());
  assert.equal(m[B1].n, 5, 'primary not in the members → +1');
  assert.equal(m[B1].label, 'GZVS...LM9b');
  assert.equal(m[B1].conf, 'high');
  assert.equal(m[B2].n, 2, 'primary already in the members');
  assert.equal(m[B2].wallets[0].walletAddress, 'x');
});

test('bundleSummary', () => {
  const s = snap(), cl = C.trojanBundles(s.bp, s.pos), sum = C.bundleSummary(cl, s.pos.concat([row('Snip2xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', 0, { sniped: 1 })]));
  assert.equal(sum.clusters, 2);
  assert.ok(Math.abs(sum.held - 8) < 1e-9);
  assert.equal(sum.snipers, 1);
  assert.equal(sum.snipersOut, 1);
  const empty = C.bundleSummary([], []);
  assert.equal(empty.clusters, 0);
  assert.equal(empty.risk, 0);
});

const hist = (pts) => {
  let h = [];
  for (const [t, b1, b2, o] of pts) h = C.pushPoint(h, C.bundlePoint(bund(b1, b2, o), t), 10 * 60e3);
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
  const h = hist([[0, 60e6, 20e6], [30000, 60e6, 20e6], [60000, 40e6, 20e6]]);
  const m = C.bundleMatches(R({}), h, bund(40e6, 20e6), 60000);
  assert.equal(m.length, 1);
  assert.equal(m[0].id, B1);
  assert.ok(Math.abs(m[0].pct - 33.33) < 0.1);
  assert.equal(C.bundleMatches(R({ pct: 40 }), h, bund(40e6, 20e6), 60000).length, 0, 'below the threshold');
  const slow = hist([[0, 60e6, 20e6], [90000, 50e6, 20e6], [180000, 40e6, 20e6]]);
  assert.equal(C.bundleMatches(R({}), slow, bund(40e6, 20e6), 180000).length, 0, 'same drop over 3 min is outside a 60s window');
  assert.equal(C.bundleMatches(R({ windowSec: 200 }), slow, bund(40e6, 20e6), 180000).length, 1);
});

test('rule: who filters', () => {
  const h = hist([[0, 60e6, 20e6], [30000, 30e6, 10e6]]);
  const cl = bund(30e6, 10e6);
  const ids = (o, watch) => C.bundleMatches(R(o), h, cl, 30000, watch).map((x) => x.id);
  assert.deepEqual(ids({}), [B1, B2]);
  assert.deepEqual(ids({ who: 'dev' }), [B2]);
  assert.deepEqual(ids({ who: 'snipers' }), [B1]);
  assert.deepEqual(ids({ who: 'min', minPct: 2 }), [B1]);
  assert.deepEqual(ids({ who: 'top3' }), [B1, B2]);
  assert.deepEqual(ids({ who: 'funder' }, [B2]), [B2]);
  assert.deepEqual(ids({ who: 'funder', funder: B1 }), [B1]);
  assert.deepEqual(ids({ who: 'funder' }), []);
});

test('rule: exit fires on the crossing only', () => {
  const cl = bund(5e6, 20e6);
  assert.equal(C.bundleMatches(R({ when: 'exit', pct: 90 }), hist([[0, 60e6, 20e6], [30000, 5e6, 20e6]]), cl, 30000)[0].id, B1);
  assert.equal(C.bundleMatches(R({ when: 'exit', pct: 90 }), hist([[0, 5e6, 20e6], [30000, 5e6, 20e6]]), cl, 30000).length, 0, 'already out when we started watching');
});

test('rule: accumulate / send / new', () => {
  const o = { b1: { spent: 4, sent: 2 } };
  const h = hist([[0, 60e6, 20e6], [30000, 60e6, 20e6, o]]);
  const cl = bund(60e6, 20e6, o);
  const acc = C.bundleMatches(R({ when: 'acc', sol: 2 }), h, cl, 30000);
  assert.equal(acc.length, 1);
  assert.equal(acc[0].sol, 3);
  assert.equal(C.bundleMatches(R({ when: 'acc', sol: 4 }), h, cl, 30000).length, 0);
  assert.equal(C.bundleMatches(R({ when: 'send' }), h, cl, 30000)[0].n, 2);
  // new: B2 shows up 25s after we started watching
  const only1 = (t) => { const s = snap(); s.bp = s.bp.filter((r) => r.walletAddress !== B2); return C.bundlePoint(C.trojanBundles(s.bp, s.pos), t); };
  let h2 = C.pushPoint([], only1(0), 600e3);
  h2 = C.pushPoint(h2, C.bundlePoint(bund(), 25000), 600e3);
  assert.deepEqual(C.bundleMatches(R({ when: 'new', pct: 1 }), h2, bund(), 25000).map((x) => x.id), [B2]);
  assert.equal(C.bundleMatches(R({ when: 'new', pct: 5 }), h2, bund(), 25000).length, 0, 'too small');
  let h3 = C.pushPoint([], only1(0), 600e3);
  h3 = C.pushPoint(h3, C.bundlePoint(bund(), 5000), 600e3);
  assert.equal(C.bundleMatches(R({ when: 'new', pct: 1 }), h3, bund(), 5000).length, 0, 'the first seconds after opening a coin are not "new"');
});

test('rule: all bundles out (reverse rule → buy)', () => {
  const m = C.bundleMatches(R({ when: 'allout', pct: 2, then: 'buy' }), hist([[0, 60e6, 20e6], [30000, 1e6, 0.5e6]]), bund(1e6, 0.5e6), 30000);
  assert.equal(m.length, 1);
  assert.equal(m[0].id, '*');
  assert.equal(C.bundleMatches(R({ when: 'allout', pct: 2 }), hist([[0, 1e6, 0.5e6], [30000, 1e6, 0.5e6]]), bund(1e6, 0.5e6), 30000).length, 0, 'never above the line');
});

test('rule: watched bundle', () => {
  const m = C.bundleMatches(R({ who: 'funder', when: 'funder' }), hist([[0, 60e6, 20e6]]), bund(), 0, [B2]);
  assert.deepEqual(m.map((x) => x.id), [B2]);
});

test('bundleMatches: empty input is safe', () => {
  assert.deepEqual(C.bundleMatches(R({}), [], [], 0), []);
  assert.deepEqual(C.bundleMatches(R({}), null, null, 0), []);
});

test('ruleText', () => {
  assert.equal(C.ruleText(R({ scope: 'held' })), 'When any bundle sells ≥ 30% of its bag within 60s on a coin I hold, sell 100% of my bag');
  assert.equal(C.ruleText(R({ who: 'min', minPct: 5, when: 'exit', pct: 90, then: 'alert' })), 'When a bundle holding ≥ 5% has sold ≥ 90% of what it got on this coin, alert me');
  assert.equal(C.ruleText(R({ when: 'allout', pct: 2, then: 'buy', buySol: 0.2, mode: 'paper', scope: 'any' })), 'When all bundles together hold ≤ 2% of supply on any coin I open, buy ◎ 0.2 (paper)');
  assert.equal(C.ruleText(R({ who: 'funder', when: 'funder', then: 'alert', scope: 'any' })), 'When a watched bundle shows up on the coin on any coin I open, alert me');
});

test.describe('same-first-funder grouping (option)', () => {
  const F1 = 'u6PJFunderAAAAAAAAAAAAAAAAAAAAAAAAAAAAXq2w', F2 = '5tzFFunderBBBBBBBBBBBBBBBBBBBBBBBBBBBBuAi9';
  const w = (i, f, bal, o = {}) => Object.assign(row('W' + String(i).padStart(43, 'x'), bal, o), { fundingInfo: f ? { firstNativeFunderAddress: f, firstNativeFundingAmount: o.fund ?? 1.25 } : null });
  const rows = [w(0, F1, 30e6, { sniped: 1 }), w(1, F1, 20e6), w(2, F1, 10e6), w(10, F2, 12e6, { dev: 5, fund: 0.8 }), w(11, F2, 8e6, { fund: 0.8 }), w(20, 'Solo' + 'z'.repeat(40), 50e6), w(21, null, 9e6)];
  test('clusterize groups 2+ wallets by first funder, biggest first', () => {
    const cl = C.clusterize(rows, 1e9, 1e-7);
    assert.deepEqual(cl.map((c) => [c.id, c.n]), [[F1, 3], [F2, 2]]);
    assert.equal(cl[0].pct, 6);
    assert.equal(cl[0].sniper, true);
    assert.equal(cl[0].sameAmt, true);
    assert.equal(cl[1].dev, true);
    assert.equal(cl[1].fundAmt, 0.8);
    assert.equal(cl[0].value, 6);
    assert.deepEqual(cl[0].wallets.map((x) => x.bal), [30e6, 20e6, 10e6]);
  });
  test('clusterize: hot funders, mixed amounts, junk', () => {
    assert.equal(C.clusterize(Array.from({ length: C.BUNDLE_MAX + 5 }, (_, i) => w(100 + i, F2, 1e6)))[0].hot, true);
    assert.equal(C.clusterize([w(1, F1, 5, { fund: 1 }), w(2, F1, 5, { fund: 2 })])[0].sameAmt, false);
    assert.deepEqual(C.clusterize(null), []);
    assert.deepEqual(C.clusterize([null, {}, { walletAddress: 'x' }]), []);
    assert.equal(C.bundleSummary(C.clusterize(Array.from({ length: 20 }, (_, i) => w(100 + i, F2, 10e6))), []).clusters, 0, 'hot wallets left out of the summary');
  });
  test('rules work the same on funder groups', () => {
    let h = C.pushPoint([], C.bundlePoint(C.clusterize(rows), 0), 600e3);
    const after = rows.map((r, i) => (i < 3 ? Object.assign({}, r, { currentTokenBalance: r.currentTokenBalance / 2 }) : r));
    h = C.pushPoint(h, C.bundlePoint(C.clusterize(after), 30000), 600e3);
    assert.deepEqual(C.bundleMatches(R({}), h, C.clusterize(after), 30000).map((x) => x.id), [F1]);
  });
});
