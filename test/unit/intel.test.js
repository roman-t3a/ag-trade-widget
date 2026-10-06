'use strict';
// Unit tests for AG Intel's pure core. The userscript exports `Core` when it is loaded in Node.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const C = require(path.join(__dirname, '..', '..', 'ag-intel.user.js'));
const W = require(path.join(__dirname, '..', '..', 'ag-trade-widget.user.js'));

const MINT = 'pZguZriDrxLRimkew1MrWcJCZMLDwDndsRFWNAJpump';

test('loading in Node exports the core and runs nothing else', () => {
  for (const k of ['riskScore', 'momentum', 'walletQuality', 'tslStop', 'tslStep', 'parseX', 'copycatPick', 'mdLite']) assert.equal(typeof C[k], 'function', k);
});

test('formatting', () => {
  assert.equal(C.fmt$(1234), '$1.2K');
  assert.equal(C.fmt$(2.5e6), '$2.50M');
  assert.equal(C.fmt$(null), '—');
  assert.equal(C.pct(12.345), '12.3%');
  assert.equal(C.pct(''), '—');
  assert.equal(C.esc('<a href="x">'), '&lt;a href=&quot;x&quot;&gt;');
  assert.equal(C.mintFromHash('#token/' + MINT), MINT);
  assert.equal(C.mintFromHash('#other'), null);
});

test('riskScore: same formula as the trade widget (it badges terminal lists with it)', () => {
  const ms = [
    { bundledPct: 70, topHoldersPct: 55, drainedPct: 3, drainedCount: 2, creatorHoldingPct: 8, freshDeployer: true, liquidityPct: 5, buyVolumePct: 30 },
    { bundledPct: 30, topHoldersPct: 40, liquidityPct: 50 }, { bundledPct: 50, isMayhemMode: true }, {},
  ];
  for (const m of ms) assert.equal(C.riskScore(m).score, W.riskScore(m).score, JSON.stringify(m));
  const extra = { ch: { cohortHoldingPct: 20 }, rug: { risks: [{ level: 'warn', name: 'w' }, { level: 'danger', name: 'd' }] } };
  assert.equal(C.riskScore(ms[1], extra).score, W.riskScore(ms[1], extra).score);
  assert.equal(C.riskScore(ms[1], extra).score, 8 + 8 + 8 + 16);
});

test('momentum', () => {
  assert.equal(C.momentum({}).score, 50);
  const candles = { candles: Array.from({ length: 12 }, (_, i) => ({ c: 100 + i * 10, n: i < 9 ? 5 : 10 })) };
  const up = C.momentum({ candles, swaps: { swaps: [{ side: 'buy', solAmount: 4 }, { side: 'sell', solAmount: 1 }] } });
  assert.ok(up.score > 60, String(up.score));
  assert.ok(up.rows.some(([k, v]) => k === 'Net SOL flow' && v === '+3.00 SOL'));
  const ath = C.momentum({ profile: { currentMcap: 50, athMcap: 100, firstSignalMcap: 25 } });
  assert.equal(ath.score, 50 - 10);
  assert.ok(ath.rows.some(([k, v]) => k === '× from first signal' && v === '2.00×'));
});

test('walletQuality', () => {
  const q = C.walletQuality({ ws: { smartMoney: 2, kyc: 1, fresh: 3, dormant: 1, unique: 10, convinced: 1 },
    fresh: { freshies: [{ state: 'exited' }, { state: 'exited' }, { state: 'holding' }] },
    swaps: { swaps: [{ fundedBy: 'F' }, { fundedBy: 'F' }, { fundedBy: 'F', stillHolds: true, isSmartMoney: true }] } });
  assert.equal(q.score, 50 + 16 + 3 + 4 - 3 - 10 - 15);
  assert.deepEqual(q.flags, ['2/3 early freshies exited', '3 recent swappers share one funder (cluster)']);
});

test('deltaRows', () => {
  const r = C.deltaRows({ holdersCount: 100 }, { holdersCount: 150, bundledPct: 10 });
  assert.deepEqual(r.map((x) => x[0]), ['Holders', 'Bundled %']);
  assert.match(r[0][1], /▲50%/);
});

test('trailing stop-loss', () => {
  assert.ok(Math.abs(C.tslStop(100, 5, 30) - 40) < 1e-9); // peak +100% → 2× × 0.7 = 1.4 → +40%
  assert.equal(C.tslStop(20, 5, 30), 5, 'never below the profit lock');
  assert.equal(C.tslStop(200, 5, 0), 5, 'no trailing → just the lock');
  const cfg = { activate: 40, lock: 5, trail: 30, sellPct: 100 };
  const st = { peak: 0 };
  assert.deepEqual(C.tslStep(st, 30, cfg, 1000), { armedNow: false, sell: false });
  assert.deepEqual(C.tslStep(st, 100, cfg, 2000), { armedNow: true, sell: false });
  assert.equal(st.armed, 2000);
  assert.deepEqual(C.tslStep(st, 60, cfg, 3000), { armedNow: false, sell: false });
  assert.deepEqual(C.tslStep(st, 39, cfg, 4000), { armedNow: false, sell: true });
  Object.assign(st, { lastTry: 4000, tries: 1 });
  assert.equal(C.tslStep(st, 30, cfg, 10000).sell, false, '15s between tries');
  assert.equal(C.tslStep(st, 30, cfg, 20000).sell, true);
  st.tries = 3;
  assert.equal(C.tslStep(st, 30, cfg, 60000).sell, false, 'gives up after 3 tries');
  const part = { peak: 100, armed: 1, soldAt: 5 };
  assert.equal(C.tslStep(part, 10, { ...cfg, sellPct: 50 }, 99999).sell, false, 'a partial sell fires once');
});

test('socials parsing', () => {
  assert.deepEqual(C.parseX('https://x.com/foo/status/123'), { kind: 'tweet', handle: 'foo', id: '123', url: 'https://x.com/foo/status/123' });
  assert.equal(C.parseX('https://x.com/foo').kind, 'account');
  assert.equal(C.parseX('https://x.com/i/communities/42').kind, 'community');
  assert.equal(C.parseX('https://x.com/search?q=x').kind, 'search');
  assert.equal(C.parseX(null), null);
  assert.deepEqual(C.siteDomain('https://www.coin.vercel.app/x'), { host: 'coin.vercel.app', hosted: true });
  assert.equal(C.siteDomain('https://app.mycoin.co.uk').reg, 'mycoin.co.uk');
  assert.equal(C.siteDomain('https://mycoin.fun').reg, 'mycoin.fun');
  assert.equal(C.siteDomain('nope'), null);
  assert.equal(C.linkKind('https://t.me/x'), 'telegram');
  assert.equal(C.linkKind('https://twitter.com/x'), 'x');
  assert.equal(C.linkKind('https://site.io'), 'website');
  const tg = C.tgParse('grp', '<div class="tgme_page_extra">1 234 members</div>');
  assert.equal(tg.members, 1234);
  assert.equal(tg.exists, true);
});

test('copycatPick', () => {
  const p = (addr, sym, created, mcap) => ({ chainId: 'solana', baseToken: { address: addr, symbol: sym, name: sym }, pairCreatedAt: created, marketCap: mcap });
  const r = C.copycatPick([p(MINT, 'DOG', 200, 50), p('A', 'DOG', 100, 10), p('B', 'CAT', 50, 999), { chainId: 'eth', baseToken: { address: 'E', symbol: 'DOG' } }], MINT, 'DOG', 'Dog');
  assert.equal(r.count, 1);
  assert.equal(r.isOldest, false);
  assert.equal(r.isBiggest, true);
  assert.equal(C.copycatPick([], MINT, 'DOG', 'Dog').count, 0);
  assert.equal(C.copycatPick(null, MINT, 'DOG'), null);
});

test('mdLite escapes before formatting', () => {
  assert.equal(C.mdLite('## Title\n- **bold** <b>x</b>'), '<div class="nh">Title</div><div class="nb">• <b>bold</b> &lt;b&gt;x&lt;/b&gt;</div>');
});

test('GMGN payloads', () => {
  assert.deepEqual(C.gmgnPick({ a: { holder_count: '12', name: 'x' }, renounced: true, price: 3 }), [['a.holder_count', '12'], ['renounced', 'yes']]);
  const h = C.holderSummary({ list: [{ amount_percentage: 0.1, tags: ['sniper'] }, { amount_percentage: 0.05, tags: ['sniper', 'kol'] }] });
  assert.equal(h.n, 2);
  assert.ok(Math.abs(h.pct - 15) < 1e-9);
  assert.deepEqual(h.tags, [['sniper', 2], ['kol', 1]]);
  assert.equal(C.holderSummary({}), null);
});
