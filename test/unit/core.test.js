'use strict';
// Unit tests for the pure core of the userscript. The userscript exports `Core` when it is loaded in Node.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const C = require(path.join(__dirname, '..', '..', 'ag-trade-widget.user.js'));

const MINT = 'pZguZriDrxLRimkew1MrWcJCZMLDwDndsRFWNAJpump';
const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps * Math.max(1, Math.abs(b)), `${a} ≉ ${b}`);

test('loading in Node exports the core and runs nothing else', () => {
  assert.equal(typeof C, 'object');
  for (const k of ['num', 'supplyCost', 'buyLegs', 'agPathAllowed', 'relayMode', 'agBus']) assert.equal(typeof C[k], 'function', k);
  assert.equal(typeof C.PUMP, 'object');
});

test.describe('formatting', () => {
  test('num picks the first numeric value', () => {
    assert.equal(C.num(null, '', 'x', '3.5', 7), 3.5);
    assert.equal(C.num(0), 0);
    assert.equal(C.num(undefined, null), null);
  });
  test('sol / kfmt / usdV', () => {
    assert.equal(C.sol(0.12345), '0.123');
    assert.equal(C.sol(1.5), '1.50');
    assert.equal(C.sol(150), '150.0');
    assert.equal(C.sol(null), '--');
    assert.equal(C.kfmt(6970), '7.0K');
    assert.equal(C.kfmt(123456), '123K');
    assert.equal(C.kfmt(2.5e6), '2.50M');
    assert.equal(C.kfmt(3e9), '3.00B');
    assert.equal(C.kfmt(5), '5.00');
    assert.equal(C.usdV(-19.8), '-$19.80');
    assert.equal(C.usdV(45000), '$45.0K');
    assert.equal(C.usdV(NaN), '');
  });
  test('escH escapes HTML', () => assert.equal(C.escH('<b a="1">&</b>'), '&lt;b a=&quot;1&quot;&gt;&amp;&lt;/b&gt;'));
  test('tail shortens a mint', () => assert.equal(C.tail(MINT), 'pZgu…pump'));
  test('unitLab', () => {
    assert.equal(C.unitLab(0.5, 'pct'), '0.5%');
    assert.equal(C.unitLab(1000, 'usd'), '$1K');
    assert.equal(C.unitLab(0.1, 'sol'), '0.1');
  });
  test('fmtM', () => {
    assert.equal(C.fmtM(4.12, '%'), '4.1%');
    assert.equal(C.fmtM(31.4, '%'), '31%');
    assert.equal(C.fmtM(25000, '$'), '$25.0K');
    assert.equal(C.fmtM(null, '%'), '--');
  });
  test('agoS / msS', () => {
    assert.equal(C.agoS(400), '<1s');
    assert.equal(C.agoS(7400), '7.4s');
    assert.equal(C.agoS(42000), '42s');
    assert.equal(C.agoS(3 * 60000), '3m');
    assert.equal(C.agoS(2 * 3600e3), '2h');
    assert.equal(C.agoS(null), '--');
    assert.equal(C.msS(37.6), '38ms');
  });
  test('parseUsd reads GMGN titles', () => {
    assert.equal(C.parseUsd('PUMPKART ↑ $76.62K | GMGN.AI'), 76620);
    assert.equal(C.parseUsd('$1.2M'), 1.2e6);
    assert.equal(C.parseUsd('$950'), 950);
    assert.equal(C.parseUsd('no price'), null);
  });
  test('parseMc reads user input', () => {
    assert.equal(C.parseMc('12.5k'), 12500);
    assert.equal(C.parseMc('$1.2M'), 1.2e6);
    assert.equal(C.parseMc('800'), 800);
    assert.ok(Number.isNaN(C.parseMc('abc')));
  });
  test('scalePx multiplies every px by --k, negatives included', () => {
    assert.equal(C.scalePx('top:-4px;width:12.5px'), 'top:calc(-4 * var(--k));width:calc(12.5 * var(--k))');
  });
});

test.describe('pump.fun curve', () => {
  const solUsd = 150;
  test('supplyCost on the curve includes price impact (≥ the linear cost)', () => {
    const c = C.supplyCost(1, MINT, 6970, solUsd);
    assert.equal(c.curve, true);
    assert.ok(c.sol > (6970 / solUsd) * 0.01, 'curve cost should exceed linear cost');
    close(c.mSol, 6970 / solUsd);
  });
  test('supplyCost off the curve is linear', () => {
    const c = C.supplyCost(2, 'So11111111111111111111111111111111111111112', 1e6, solUsd);
    assert.equal(c.curve, false);
    close(c.sol, (1e6 / solUsd) * 0.02);
  });
  test('supplyCost needs mcap, price and pct', () => {
    assert.equal(C.supplyCost(1, MINT, 0, solUsd), null);
    assert.equal(C.supplyCost(1, MINT, 6970, 0), null);
    assert.equal(C.supplyCost(0, MINT, 6970, solUsd), null);
  });
  test('buyImpact matches ((x+dx)/x)² − 1 and grows with size', () => {
    const a = C.buyImpact(0.5, MINT, 6970, solUsd), b = C.buyImpact(2, MINT, 6970, solUsd);
    const mSol = 6970 / solUsd, x = Math.sqrt((C.PUMP.K * mSol) / C.PUMP.SUPPLY), dx = 0.5 / C.PUMP.FEE;
    close(a.impact, (((x + dx) / x) ** 2 - 1) * 100);
    assert.ok(b.impact > a.impact);
    assert.ok(a.avgMc > 6970, 'average fill is above the current mcap');
  });
  test('buyImpact is null after migration or for non-pump mints', () => {
    assert.equal(C.buyImpact(1, MINT, 500 * solUsd, solUsd), null);
    assert.equal(C.buyImpact(1, 'So11111111111111111111111111111111111111112', 6970, solUsd), null);
  });
  test('curvePct: 0 at launch, 100 past migration', () => {
    const launch = (30 * 30 * C.PUMP.SUPPLY) / C.PUMP.K; // mcap in SOL at 30 virtual SOL
    close(C.curvePct(MINT, launch * solUsd, solUsd), 0, 1e-6);
    assert.equal(C.curvePct(MINT, 400 * solUsd, solUsd), 100);
    assert.equal(C.curvePct('So11111111111111111111111111111111111111112', 6970, solUsd), null);
  });
  test('pickUnit finds the unit within 3× of the reference', () => {
    assert.equal(C.pickUnit(7000, 6970, 150), 1); // already USD mcap
    assert.equal(C.pickUnit(46.5, 6970, 150), 150); // mcap in SOL
    assert.equal(C.pickUnit(0.00000697, 6970, 150), C.PUMP.SUPPLY); // USD price
    assert.equal(C.pickUnit(1, 6970, 150), null); // nothing plausible
    assert.equal(C.pickUnit(7000, 0, 150), null); // no reference yet
  });
});

test.describe('multi-wallet buys', () => {
  const bal = { A: 2, B: 0.05, C: 1 };
  const balOf = (w) => (w in bal ? bal[w] : null);
  test('each: every wallet buys the amount; poor wallets are skipped', () => {
    const r = C.buyLegs(0.5, ['A', 'B', 'C'], { reserve: 0.01, balOf });
    assert.deepEqual(r.legs, [{ w: 'A', amt: 0.5 }, { w: 'C', amt: 0.5 }]);
    assert.deepEqual(r.skipped, ['B']);
  });
  test('split: the total is divided across the wallets that can afford it', () => {
    const r = C.buyLegs(1, ['A', 'B', 'C'], { split: true, reserve: 0.01, balOf });
    assert.deepEqual(r.legs.map((x) => x.amt), [0.5, 0.5]);
  });
  test('split + jitter keeps the total (±rounding)', () => {
    let i = 0; const seq = [0.1, 0.9, 0.5, 0.3];
    const r = C.buyLegs(1, ['A', 'C', 'X'], { split: true, jitterPct: 20, balOf, rand: () => seq[i++ % seq.length] });
    const sum = r.legs.reduce((a, x) => a + x.amt, 0);
    assert.ok(Math.abs(sum - 1) < 0.001, String(sum));
    assert.ok(new Set(r.legs.map((x) => x.amt)).size > 1, 'amounts differ');
  });
  test('unknown balances are not skipped; nobody can pay → no legs', () => {
    assert.equal(C.buyLegs(0.1, ['X'], { balOf }).legs.length, 1);
    assert.deepEqual(C.buyLegs(5, ['B'], { balOf }), { legs: [], skipped: ['B'] });
  });
  test('scaleLegs rescales to a new total', () => {
    const r = C.scaleLegs([{ w: 'A', amt: 1 }, { w: 'B', amt: 3 }], 2);
    assert.deepEqual(r, [{ w: 'A', amt: 0.5 }, { w: 'B', amt: 1.5 }]);
  });
  test('rng is deterministic per seed', () => {
    const a = C.rng(42), b = C.rng(42);
    for (let k = 0; k < 5; k++) assert.equal(a(), b());
  });
  test('matchFlows moves surplus to deficits, ignores dust', () => {
    const tx = C.matchFlows(['A', 'B', 'C'], { A: 3, B: 0, C: 0 }, { A: 1, B: 1, C: 1.0005 }, 0.01);
    assert.deepEqual(tx.map((t) => [t.from, t.to]).sort(), [['A', 'B'], ['A', 'C']]);
    close(tx.reduce((a, t) => a + t.amt, 0), 2);
    assert.deepEqual(C.matchFlows(['A'], { A: 1 }, { A: 1.001 }, 0.01), []);
  });
});

test.describe('holdings', () => {
  test('cost of a bag = worth − pnl unless AG gives the cost', () => {
    assert.equal(C.bagCost({ worthSol: 0.3, pnlSol: 0.07 }), 0.3 - 0.07);
    assert.equal(C.costOf({ costSol: 1, worthSol: 3, pnlSol: 1 }), 1);
    assert.equal(C.soldOf({ proceedsSol: '0.4' }), 0.4);
  });
  test('avgEntry is cost-weighted', () => {
    const rows = [{ avgEntryMcap: 5000, worthSol: 1, pnlSol: 0 }, { avgEntryMcap: 8000, worthSol: 3, pnlSol: 0 }];
    assert.equal(C.avgEntry(rows), (5000 + 8000 * 3) / 4);
    assert.equal(C.avgEntry([{ avgEntryMcap: 5000, worthSol: 1 }]), null); // no cost known
    assert.equal(C.avgEntry([{ avgEntryMcap: 5000, worthSol: 1 }], true), 5000); // worth as weight
  });
});

test.describe('AG intel', () => {
  test('metric reads plain and boxed values', () => {
    assert.equal(C.metric({ a: '4.2' }, 'a'), 4.2);
    assert.equal(C.metric({ a: { value: 3 } }, 'a'), 3);
    assert.equal(C.metric({ a: '' }, 'a'), null);
    assert.equal(C.metric(null, 'a'), null);
  });
  test('riskLevel for "higher is worse" and "higher is better"', () => {
    const dev = ['creatorHoldingPct', 'Dev hold', '%', 1, 5, 10], sm = ['smCount', 'Smart money', '', -1, 1, 0];
    assert.equal(C.riskLevel(dev, 2), 'ok');
    assert.equal(C.riskLevel(dev, 6), 'mid');
    assert.equal(C.riskLevel(dev, 12), 'bad');
    assert.equal(C.riskLevel(sm, 4), 'ok');
    assert.equal(C.riskLevel(sm, 0), 'mid');
    assert.equal(C.riskLevel(['x', 'X', '', 0], 9), 'n');
  });
  test('flowOf bins the last 5 minutes', () => {
    const now = 1_000_000;
    const f = C.flowOf([
      { side: 'buy', solAmount: 2, isSmartMoney: true, blockTime: now - 20 },
      { side: 'buy', solAmount: 1, walletType: 1, blockTime: now - 70 },
      { side: 'sell', solAmount: 0.5, isSmartMoney: true, blockTime: now - 130 },
      { side: 'sell', solAmount: 9, blockTime: now - 900 }, // too old
    ], now);
    assert.equal(f.net, 2.5);
    assert.deepEqual([f.smB, f.smS, f.fresh], [1, 1, 1]);
    assert.equal(f.bins[4].b, 2);
    assert.equal(f.bins[3].b, 1);
    assert.equal(f.bins[2].s, 0.5);
  });
  test('profileChips finds known metrics, percent-normalised', () => {
    const chips = C.profileChips({ stats: { freshPct: 18.2, bundledRatio: 0.023, smartMoneyCount: 4, other: 1 } });
    assert.deepEqual(chips, [{ k: 'Fresh', v: '18.2%' }, { k: 'Bundled', v: '2.3%' }, { k: 'Smart money', v: '4' }]);
  });
  test('tradeRows normalises sides and timestamps, oldest first', () => {
    const r = C.tradeRows({ trades: [{ side: 'SELL', solAmount: 1, blockTime: 20 }, { type: 'buy', amountSol: 2, createdAt: '1970-01-01T00:00:10Z' }] });
    assert.deepEqual(r.map((x) => [x.side, x.sol, x.t]), [['BUY', 2, 10000], ['SELL', 1, 20000]]);
    assert.equal(C.tradeRows({}), null);
  });
});

test.describe('hidden coins come back on a new AG signal', () => {
  const T = 1_700_000_000_000;
  test('sigTime handles seconds, ms and ISO strings', () => {
    assert.equal(C.sigTime({ signalAt: 1_700_000_000 }), T);
    assert.equal(C.sigTime({ blockTime: T }), T);
    assert.equal(C.sigTime({ createdAt: new Date(T).toISOString() }), T);
    assert.equal(C.sigTime({}), null);
  });
  test('a timed signal after the hide is a hit; one before is not', () => {
    assert.equal(C.newSignal({ t: T, n: 0 }, [{ signalAt: T / 1000 - 60 }]).hit, false);
    assert.equal(C.newSignal({ t: T, n: 0 }, [{ signalAt: T / 1000 + 5 }]).hit, true);
    assert.equal(C.newSignal({ t: T, n: 0 }, [], { signalAt: T / 1000 + 5 }).hit, true);
  });
  test('untimed signals: first look sets the baseline, a new one is a hit', () => {
    const meta = { t: T, n: null };
    assert.deepEqual(C.newSignal(meta, [{ presetName: 'a' }]), { hit: false, baseline: true });
    assert.equal(meta.n, 1);
    assert.equal(C.newSignal(meta, [{ presetName: 'a' }]).hit, false);
    assert.equal(C.newSignal(meta, [{ presetName: 'a' }, { presetName: 'b' }]).hit, true);
  });
});

test.describe('relay', () => {
  const now = 1_000_000;
  test('agPathAllowed: only the whitelisted AG endpoints', () => {
    assert.ok(C.agPathAllowed('POST', `/api/tokens/${MINT}/buy`));
    assert.ok(C.agPathAllowed('GET', '/api/performance/holdings?source=live'));
    assert.ok(C.agPathAllowed('GET', `/api/swaps/by-token/${MINT}`));
    assert.ok(!C.agPathAllowed('DELETE', `/api/tokens/${MINT}/buy`));
    assert.ok(!C.agPathAllowed('POST', '/api/wallets/withdraw'));
    assert.ok(!C.agPathAllowed('GET', `/api/tokens/${MINT}/buy/../../admin`));
    assert.ok(!C.agPathAllowed('GET', '/api/performance/holdings?x=<script>'));
  });
  test('relayMode: v2 owner, legacy heartbeat, down', () => {
    assert.equal(C.relayMode({ id: 'a', at: now - 2000 }, now - 1000, now).mode, 'v2');
    assert.equal(C.relayMode(null, now - 5000, now).mode, 'legacy');
    assert.equal(C.relayMode({ id: 'a', at: now - 60000 }, now - 60000, now).mode, 'down');
    assert.equal(C.relayMode(null, 0, now).age, null);
  });
  test('authExpired: fresh 401/403 only', () => {
    assert.equal(C.authExpired({ ok: false, status: 401, at: now - 1000 }, now), true);
    assert.equal(C.authExpired({ ok: false, status: 403, at: now - 1000 }, now), true);
    assert.equal(C.authExpired({ ok: false, status: 500, at: now - 1000 }, now), false);
    assert.equal(C.authExpired({ ok: false, status: 401, at: now - 300000 }, now), false);
    assert.equal(C.authExpired(null, now), false);
  });
  test('healthLevel: red beats amber beats green; a pending reload is amber', () => {
    assert.equal(C.healthLevel([{ c: 'g' }, { c: 'y' }, { c: 'r' }]), 'r');
    assert.equal(C.healthLevel([{ c: 'g' }, { c: 'y' }]), 'y');
    assert.equal(C.healthLevel([{ c: 'g' }, { c: 'n' }]), 'g');
    assert.equal(C.healthLevel([{ c: 'g' }], { a: 'reload' }), 'y');
  });
});

test.describe('agBus', () => {
  const resp = (status, j) => Promise.resolve({ status, ok: status < 300, json: () => Promise.resolve(j) });
  test('one in-flight request per path, then cached for maxAge', async () => {
    let n = 0;
    const bus = C.agBus({}, () => { n++; return resp(200, { n }); });
    const [a, b] = await Promise.all([bus.get('/x', 1000), bus.get('/x', 1000)]);
    assert.equal(n, 1);
    assert.deepEqual(a, b);
    await bus.get('/x', 1000);
    assert.equal(n, 1);
    bus.drop('/x');
    await bus.get('/x', 1000);
    assert.equal(n, 2);
  });
  test('errors become {ok:false} and are cached at most 3s', async () => {
    let n = 0;
    const bus = C.agBus({}, () => { n++; return n === 1 ? Promise.reject(new Error('down')) : resp(200, {}); });
    const r = await bus.get('/y', 60000);
    assert.equal(r.ok, false);
    assert.equal(r.status, 0);
    await bus.get('/y', 60000);
    assert.equal(n, 1); // still inside the 3s error window
  });
  test('reuses a bus already shared on the window', () => {
    const W = {};
    const a = C.agBus(W, () => resp(200, {}));
    assert.equal(C.agBus(W, () => resp(200, {})), a);
  });
});

test.describe('site adapters', () => {
  const loc = (u) => { const x = new URL(u); return { pathname: x.pathname, search: x.search }; };
  const site = (id) => C.SITES.find((s) => s.id === id);

  test('siteFor picks the terminal from the hostname', () => {
    assert.equal(C.siteFor('gmgn.ai').id, 'gmgn');
    assert.equal(C.siteFor('www.gmgn.ai').id, 'gmgn');
    assert.equal(C.siteFor('trojan.com').id, 'trojan');
    assert.equal(C.siteFor('www.trojan.com').id, 'trojan');
    assert.equal(C.siteFor('backtester.alphagardeners.xyz'), null);
    assert.equal(C.siteFor('nottrojan.com'), null);
    assert.equal(C.siteFor('axiom.trade').id, 'axiom');
    assert.equal(C.siteFor('axiom.trade.evil.com'), null);
    assert.equal(C.siteFor('gmgn.ai.evil.com'), null);
  });

  test('every site has the full adapter shape', () => {
    for (const s of C.SITES) {
      for (const k of ['mint', 'symbol', 'cardMint', 'tokenUrl']) assert.equal(typeof s[k], 'function', `${s.id}.${k}`);
      for (const k of ['id', 'name', 'cards', 'cardRow']) assert.equal(typeof s[k], 'string', `${s.id}.${k}`);
      if (!s.cardAttr) assert.equal(s.cardMint(s.tokenUrl(MINT)), MINT, `${s.id}: tokenUrl ⇄ cardMint`);
      else assert.equal(s.cardMint(MINT), MINT, `${s.id}: cardMint(${s.cardAttr})`);
    }
  });

  test('gmgn', () => {
    const g = site('gmgn');
    assert.equal(g.mint(loc('https://gmgn.ai/sol/token/' + MINT)), MINT);
    assert.equal(g.mint(loc('https://gmgn.ai/sol/token/abc123_' + MINT)), MINT);
    assert.equal(g.mint(loc('https://gmgn.ai/trend')), null);
    assert.equal(g.symbol('PUMPKART ↑ $76.62K | GMGN.AI | The Fastest…'), 'PUMPKART');
    assert.equal(g.symbol('GMGN.AI | The Fastest Multi-Chain Meme Trading Terminal'), '');
    assert.equal(g.cardMint('/sol/token/' + MINT), MINT);
  });

  test('trojan', () => {
    const t = site('trojan');
    assert.equal(t.mint(loc(`https://trojan.com/terminal?token=${MINT}&chain=sol`)), MINT);
    assert.equal(t.mint(loc(`https://trojan.com/terminal?chain=sol&token=${MINT}`)), MINT);
    assert.equal(t.mint(loc('https://trojan.com/trenches')), null);
    assert.equal(t.mint(loc(`https://trojan.com/swap?token=${MINT}`)), null);
    assert.equal(t.mint(loc('https://trojan.com/terminal?token=notamint')), null);
    assert.equal(t.symbol('Datacenter $7.73K | Trojan'), 'Datacenter');
    assert.equal(t.symbol('Golem Emet ↑ $1.2M | Trojan'), 'Golem Emet');
    assert.equal(t.symbol('Trenches | Trojan'), '');
    assert.equal(t.cardMint(`/terminal?token=${MINT}&a=1&b=2`), MINT);
    assert.equal(t.cardMint(`https://trojan.com/terminal?x=1&token=${MINT}`), MINT);
    assert.equal(t.cardMint('https://pump.fun/' + MINT), null);
    assert.equal(C.parseUsd('Datacenter $7.73K | Trojan'), 7730);
  });

  test('axiom', () => {
    const a = site('axiom'), PAIR = 'D47ZQ7BcNvDhjviQattcvm4WcJLouqTXwkU4QER5vePn';
    const doc = (href) => ({ querySelector: (sel) => (href && /solscan|pump\.fun/.test(sel) ? { getAttribute: () => href } : null) });
    assert.equal(a.mint(loc('https://axiom.trade/meme/' + PAIR), doc('https://solscan.io/token/' + MINT)), MINT);
    assert.equal(a.mint(loc('https://axiom.trade/meme/' + PAIR), doc('https://pump.fun/coin/' + MINT)), MINT);
    assert.equal(a.mint(loc('https://axiom.trade/meme/' + PAIR), doc(null)), null, 'page not rendered yet');
    assert.equal(a.mint(loc('https://axiom.trade/pulse'), doc('https://solscan.io/token/' + MINT)), null, 'only on a coin page');
    assert.equal(a.mint(loc('https://axiom.trade/meme/' + PAIR), null), null);
    assert.equal(a.symbol('SIQ ↓ $3.44K | Axiom SOL'), 'SIQ');
    assert.equal(a.symbol('Fomo wif Sword $22.5K | Axiom SOL'), 'Fomo wif Sword');
    assert.equal(a.symbol('Axiom SOL | Pulse'), '');
    assert.equal(a.cardMint(MINT), MINT);
    assert.equal(a.cardMint('not a mint'), null);
    assert.equal(a.tokenUrl(MINT), '/meme/' + MINT);
    assert.equal(C.parseUsd('SIQ ↓ $3.44K | Axiom SOL'), 3440);
  });

  test('srcName labels tick sources', () => {
    assert.equal(C.srcName('ag'), 'AG');
    assert.equal(C.srcName('gmgn'), 'GMGN');
    assert.equal(C.srcName('trojan'), 'Trojan');
    assert.equal(C.srcName('axiom'), 'Axiom');
  });
});
