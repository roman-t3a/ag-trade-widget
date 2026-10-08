'use strict';
// Buy Guard: reading a launch from its first transactions, and scoring a coin before a buy
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const C = require(path.join(__dirname, '..', '..', 'ag-trade-widget.user.js'));
const F = require(path.join(__dirname, '..', 'fixtures', 'launch.js'));

const MINT = 's8vGp8XZ7q8JC4YFehgr3Q8ERHJarwYhj6WYpgUpump';

test('txParse: fee payer, token change, side, fingerprint (version · fee · routers · tip)', () => {
  const L = F.launch(MINT), w = F.addr('w1'), pool = F.addr('p1');
  L.tx({ rel: 0, w, d: { [w]: 100e6, [pool]: 900e6 }, sol: 1, fee: 105000, ver: 0, progs: [F.PUMP], tip: true, logs: ['Program log: Instruction: Create'] });
  L.tx({ rel: 1, w: pool, d: {}, fee: 5000 });
  const a = C.txParse(L.txs[0], MINT);
  assert.equal(a.w, w);
  assert.equal(a.create, true);
  assert.equal(a.pool, pool);
  assert.equal(a.supply, 1e9);
  assert.equal(a.tok, 100e6);
  assert.equal(a.print, 'v0|105000||jito', 'common programs are not routers; a Jito tip is part of the shape');
  assert.equal(C.txParse(L.txs[1], MINT).side, 'other');
  assert.equal(C.txParse({ transaction: {}, meta: { err: { x: 1 } } }, MINT), null, 'failed transactions are skipped');
  assert.equal(C.txParse(null, MINT), null);
  assert.match(C.printText('legacy|29000|GMgnVFR8Jb39LoXsEVzb3DvBy3ywCmdmJquHUy1Lrkqb|'), /legacy · 0\.000029 ◎ fee · router GMgnVF/);
});

test('launchScan on the cat launch: farm stream, dev selling into it, sniper, outside SOL', () => {
  const c = F.cat(MINT), s = C.launchScan(c.txs, MINT);
  assert.equal(s.ok, true);
  assert.equal(s.dev, c.dev);
  assert.equal(s.pool, c.pool);
  assert.ok(Math.abs(s.devBuyPct - 25.16) < 0.01);
  assert.equal(s.devLeftPct, 0, 'the dev sold everything');
  assert.equal(s.farm.n, 29, '29 distinct wallets');
  assert.equal(s.farm.buys, 31, '31 buys (two wallets bought twice)');
  assert.deepEqual([s.farm.first, s.farm.last], [5, 39]);
  assert.equal(s.farm.text, 'legacy · 0.000029 ◎ fee');
  assert.equal(s.devSells.length, 6);
  assert.equal(s.devInto, 6, 'all 6 dev sells land inside the farm stream');
  assert.equal(s.devShares, true, 'the dev sells with the farm\'s transaction shape');
  assert.deepEqual(s.snipers.map((x) => x.w), [c.sniper]);
  assert.ok(s.outside > 1.5 && s.outside < 1.7, String(s.outside));
  assert.ok(!s.farm.wallets.includes(c.dev) && !s.farm.wallets.includes(c.pool));
  const lanes = new Set(s.events.map((e) => e.lane));
  assert.deepEqual([...lanes].sort(), ['dev', 'farm', 'out', 'sniper']);
  assert.equal(s.events[0].tok, 251.6e6, 'first event = the dev\'s create buy');
});

test('launchScan: order-independent input, missing creation, junk', () => {
  const c = F.cat(MINT), r = C.launchScan(c.txs.slice().reverse(), MINT);
  assert.equal(r.ok, true);
  assert.equal(r.farm.n, 29);
  assert.equal(C.launchScan(c.txs.slice(1), MINT).ok, false);
  assert.equal(C.launchScan(null, MINT).ok, false);
  assert.equal(C.launchScan([null, {}, { meta: {} }], MINT).ok, false);
});

test('guardScore: the cat launch is blocked, with the pattern named', () => {
  const s = C.launchScan(F.cat(MINT).txs, MINT);
  const r = C.guardScore({ scan: s, buySol: 0.5, ageMin: 3, busy: { n: 5, of: 5 } }, {});
  assert.equal(r.level, 'block');
  assert.ok(r.score >= 70, String(r.score));
  assert.equal(r.head, 'Launch-tool dump pattern');
  assert.match(r.sub, /29 wallets/);
  assert.deepEqual(r.checks.filter((x) => x.tag === 'FAIL').map((x) => x.id), ['farm', 'devstep', 'busy']);
  assert.ok(r.checks[0].pts >= r.checks[r.checks.length - 1].pts, 'biggest first');
});

test('guardScore: a clean launch is clear; a terminal default is only a warning', () => {
  const a = C.guardScore({ scan: C.launchScan(F.clean(MINT).txs, MINT), buySol: 0.1, ageMin: 3 }, {});
  assert.equal(a.level, 'clear');
  assert.equal(a.score, 0);
  assert.equal(a.head, 'Nothing found');
  const b = C.guardScore({ scan: C.launchScan(F.terminal(MINT).txs, MINT), buySol: 0.1, ageMin: 3 }, {});
  assert.equal(b.level, 'clear');
  const f = b.checks.find((x) => x.id === 'farm');
  assert.equal(f.tag, 'WARN');
  assert.match(f.detail, /terminal default/);
});

test('nukeRisk and the nuke check (first minutes only)', () => {
  assert.deepEqual(C.nukeRisk(4.6, 0.5).line, 5);
  assert.equal(C.nukeRisk(4.6, 0.3).line, null);
  assert.equal(C.nukeRisk(12, 1).line, null, 'past every line');
  assert.equal(C.nukeRisk(0.9, 0.2, [1, 3]).line, 1);
  const s = C.launchScan(F.clean(MINT).txs, MINT);
  const hit = C.guardScore({ scan: s, buySol: 0.5, ageMin: 2, outsideSol: 4.6 }, {});
  assert.ok(hit.checks.some((x) => x.id === 'nuke'));
  assert.equal(hit.nuke.line, 5);
  assert.ok(!C.guardScore({ scan: s, buySol: 0.5, ageMin: 30, outsideSol: 4.6 }, {}).checks.some((x) => x.id === 'nuke'), 'old coin: no launch guard any more');
  assert.ok(!C.guardScore({ scan: s, buySol: 0.5, ageMin: 2, outsideSol: 4.6 }, { on: { nuke: false } }).checks.some((x) => x.id === 'nuke'), 'check off');
});

test('guardScore: memory (saved farm, flagged dev), bundles out, shared funder, dev record, no scan', () => {
  const c = F.cat(MINT), s = C.launchScan(c.txs, MINT);
  const mem = { farms: [{ wallets: c.farm.slice(0, 4), coins: ['MOMO'] }], devs: { [c.dev]: { flag: true, coins: ['cat'] } } };
  const r = C.guardScore({ scan: s, buySol: 0.1, ageMin: 30, mem }, {});
  assert.ok(r.checks.some((x) => x.id === 'seen' && /MOMO/.test(x.detail)));
  assert.ok(r.checks.some((x) => x.id === 'flagged'));
  assert.equal(r.score, 100, 'capped');
  const rows = [{ walletAddress: 'A1', currentTokenBalance: 5e6, amountNativeSpent: 1, fundingInfo: { firstNativeFunderAddress: 'FUNDERxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', firstNativeFundingAmount: 0.667 } },
    { walletAddress: 'A2', currentTokenBalance: 4e6, amountNativeSpent: 1, fundingInfo: { firstNativeFunderAddress: 'FUNDERxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', firstNativeFundingAmount: 0.667 } }];
  const t = C.guardScore({ rows, sum: { peak: 27.2, held: 0 }, migr: { m: 0, n: 33 }, buySol: 0.1 }, { on: { devrec: true } });
  assert.deepEqual(t.checks.filter((x) => x.pts).map((x) => x.id).sort(), ['devrec', 'funder', 'out']);
  assert.ok(t.checks.some((x) => x.id === 'noscan'), 'says the launch was not read');
  assert.equal(t.level, 'clear', '6 + 6 + 8 stays under caution');
  assert.equal(C.guardScore({ migr: { m: 21, n: 33 } }, {}).checks.find((x) => x.id === 'devrec'), undefined, 'dev record is off by default');
  assert.equal(C.guardScore({ migr: { m: 21, n: 33 } }, { on: { devrec: true } }).checks.find((x) => x.id === 'devrec').tag, 'INFO');
});

test('guardScore: thresholds and weights are yours', () => {
  const s = C.launchScan(F.cat(MINT).txs, MINT);
  assert.equal(C.guardScore({ scan: s }, { block: 90 }).level, 'caution');
  assert.equal(C.guardScore({ scan: s }, { w: { farm: 0, devstep: 0 } }).level, 'clear');
  assert.equal(C.guardScore({ scan: s }, { on: { farm: false, devstep: false } }).checks.some((x) => x.id === 'farm'), false);
});

test('outsideSol: Trojan rows minus dev, farm and pool', () => {
  const c = F.cat(MINT), s = C.launchScan(c.txs, MINT);
  const rows = [{ walletAddress: c.dev, amountNativeSpent: 9 }, { walletAddress: c.farm[0], amountNativeSpent: 2 }, { walletAddress: 'X', amountNativeSpent: 1.5 },
    { walletAddress: c.pool, isReserveAccountsOwner: true, amountNativeSpent: 0 }, { walletAddress: 'Y', amountNativeSpent: 0.25 }];
  assert.equal(C.outsideSol(rows, s), 1.75);
  assert.equal(C.outsideSol(rows, null), 12.75);
});

test('Block-0 bundle with the dev\'s tool + dev dump (the Pao launch)', () => {
  const f = F.pao(MINT), s = C.launchScan(f.txs, MINT);
  assert.equal(s.farm, null, 'only 3 wallets: no farm');
  assert.equal(s.b0.toolN, 3);
  assert.ok(Math.abs(s.b0.toolPct - 12.873) < 0.01, String(s.b0.toolPct));
  assert.equal(s.b0.devShape, true, 'they share the dev\'s transaction shape');
  assert.deepEqual(s.b0.wallets.sort(), f.b0.slice().sort());
  assert.ok(!s.b0.wallets.includes(f.sniper), 'a router sniper is not part of the bundle');
  assert.equal(s.devLastSell, 35);
  assert.deepEqual([...new Set(s.events.filter((e) => e.lane === 'b0').map((e) => e.w))].sort(), f.b0.slice().sort());
  const r = C.guardScore({ scan: s, buySol: 0.1, ageMin: 1, bundlersPct: 50.5, bundlersSrc: 'Trojan' }, {});
  assert.equal(r.level, 'block');
  assert.equal(r.head, 'Bundled launch, dev dumped');
  assert.deepEqual(r.checks.filter((x) => x.tag === 'FAIL').map((x) => x.id).sort(), ['block0', 'bundled', 'devstep']);
  assert.match(r.checks.find((x) => x.id === 'devstep').detail, /sold all of its 12%/);
  assert.equal(C.guardScore({ scan: s }, {}).level, 'block', 'block-0 + dump alone block (60)');
});

test('block-0 rules: a lone dev-tool buy warns; a slot-0 sniper with its own shape is nothing', () => {
  const L = F.launch(MINT), dev = F.addr('d1'), pool = F.addr('p1'), b = F.addr('b1'), x = F.addr('x1');
  L.tx({ rel: 0, w: dev, d: { [dev]: 50e6, [pool]: 950e6 }, sol: 1, fee: 1005000, ver: 0, logs: ['Program log: Instruction: Create'] });
  L.tx({ rel: 0, w: b, d: { [b]: 40e6, [pool]: -40e6 }, sol: 1, fee: 1005000, ver: 0 });
  L.tx({ rel: 0, w: x, d: { [x]: 30e6, [pool]: -30e6 }, sol: 1, fee: 3749000, ver: 0, progs: ['5DVzy5EpG2xVxrwwuyZPDe9EpraUnGh7ZgYABwizzNVu'] });
  const s = C.launchScan(L.txs, MINT);
  assert.equal(s.b0.toolN, 1);
  assert.equal(C.guardScore({ scan: s }, {}).checks.find((c) => c.id === 'block0').tag, 'WARN');
  assert.equal(C.launchScan(F.cat(MINT).txs, MINT).b0.toolN, 0, 'cat: the slot-0 sniper is a third party');
});

test('bundles held and funded-together checks', () => {
  assert.equal(C.guardScore({ bundlersPct: 50 }, {}).checks.find((c) => c.id === 'bundled').tag, 'FAIL');
  assert.equal(C.guardScore({ bundlersPct: 20 }, {}).checks.find((c) => c.id === 'bundled').tag, 'WARN');
  assert.equal(C.guardScore({ bundlersPct: 10 }, {}).checks.find((c) => c.id === 'bundled'), undefined);
  const rows = Array.from({ length: 10 }, (_, i) => ({ walletAddress: 'W' + i, currentTokenBalance: 21e6, amountNativeSpent: 1, fundingInfo: { firstNativeFunderAddress: '5tzFxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxuAi9', firstNativeFundingAmount: 5.643959 } }));
  const f = C.guardScore({ rows }, {}).checks.find((c) => c.id === 'funder');
  assert.equal(f.tag, 'FAIL');
  assert.equal(f.name, 'Funded together');
  assert.match(f.detail, /10 top holders .* the same 5\.644 ◎ each · 21% of supply/);
});
