/* global __gm, __gmL, __sockH, __emits, __fire, __relay */
// AG Trade Widget – end-to-end tests: the real userscript in Chromium (Playwright) with GM_* shims, a fake
// socket.io and a mocked AG backend. Run: npm run test:e2e  (or node test/e2e/widget.e2e.js [path/to/script])
// Screenshots of every screen land in ./shots
const pw = require('playwright');
const { chromium } = pw;
const fs = require('fs');
const path = require('path');
const SCRIPT = fs.readFileSync(process.argv[2] || path.join(__dirname, '..', '..', 'ag-trade-widget.user.js'), 'utf8');
const OUT = path.join(__dirname, 'shots');
const VER = (SCRIPT.match(/@version\s+(\S+)/) || [])[1]; // the script's own version (GM_info shim)
const VRE = VER.replace(/\./g, '\\.');
fs.mkdirSync(OUT, { recursive: true });
const MINT = 'pZguZriDrxLRimkew1MrWcJCZMLDwDndsRFWNAJpump', MINT2 = 'DabcatXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXpump';
const W = ['Wmain11111111111111111111111111111111111111', 'Wsnip22222222222222222222222222222222222222', 'Wsnip33333333333333333333333333333333333333', 'Wbag444444444444444444444444444444444444444'];

let pass = 0, fail = 0;
const results = [];
function ok(name, cond, info) { (cond ? pass++ : fail++); results.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + info : ''}`); }

function backend() {
  return {
    calls: [],
    devNow: '10.0%',
    tpslPositions: () => [
      { botPositionId: 101, walletAddress: W[0], isClosed: false, avgBuyMcap: 5300, levels: [{ orderId: 1, type: 'STOP_LOSS', percentage: 50, amountPct: 100, managed: true, executed: false }] },
      { botPositionId: 102, walletAddress: W[1], isClosed: false, avgBuyMcap: 5250, levels: [] },
      { botPositionId: 103, walletAddress: W[2], isClosed: false, avgBuyMcap: 5250, levels: [] },
    ],
    holdings: () => ({ byWallet: {
      [W[0]]: { holdings: [{ tokenAddress: MINT, symbol: 'JEVABLE', worthSol: 0.3, worthUsd: 45, pnlSol: 0.07, pnlPct: 30.4, avgEntryMcap: 5300 }] },
      [W[1]]: { holdings: [{ tokenAddress: MINT, symbol: 'JEVABLE', worthSol: 0.252, worthUsd: 37.8, pnlSol: 0.062, pnlPct: 32.6, avgEntryMcap: 5250 }] },
      [W[3]]: { holdings: [{ tokenAddress: MINT2, symbol: 'DABCAT', worthSol: 0.4, worthUsd: 60, pnlSol: -0.1, pnlPct: -20, avgEntryMcap: 24000 }] },
    } }),
    handle(method, path, body) {
      this.calls.push({ method, path, body });
      if (this.authDown) return { __status: 401, error: 'unauthorized' };
      const u = new URL('https://x' + path);
      if (u.pathname.includes('wallets-list')) return { solPrice: 150, wallets: [{ address: W[0], label: 'Main', isMain: true, balanceSol: 2.8 }, { address: W[1], label: 'Sniper 2', balanceSol: 1.0 }, { address: W[2], label: 'Sniper 3', balanceSol: 0.4 }, { address: W[3], label: 'Bag 1', balanceSol: 0.6 }] };
      if (u.pathname.includes('/holdings')) return this.holdings();
      if (u.pathname.includes('my-trades')) return { pnl: { costSol: 0.42, proceedsSol: 0 }, trades: [{ side: 'buy', solAmount: 0.21, mcap: 5300, blockTime: 1791280000, walletAddress: W[0] }, { side: 'buy', solAmount: 0.21, mcap: 5250, blockTime: 1791280005, walletAddress: W[1] }] };
      if (u.pathname.endsWith('/tpsl') && method === 'GET') return { positions: this.tpslPositions() };
      if (u.pathname.endsWith('/tpsl') && method === 'POST') return { ok: true };
      if (u.pathname.includes('creator-holdings')) return { available: true, figures: { creator: { launch: '12.0%', now: this.devNow } } };
      if (u.pathname.includes('/performance/positions')) return { positions: [{ isClosed: true, closedAt: new Date().toISOString(), realizedPnlSol: -1.0 }, { isClosed: true, closedAt: '2020-01-01T00:00:00Z', realizedPnlSol: -9 }] };
      if (u.pathname.includes('/profile')) { if (this.noProfile) return { found: false }; const now = Date.now() / 1000; return { symbol: 'JEVABLE', signalAt: now - 360, firstSignalMcap: 4470, signalMcap: 4470, currentMcap: 6970, athMcap: 9380, winPredPercent: 41,
        metrics: { creatorHoldingPct: 0, bundledPct: 2.3, topHoldersPct: 31, drainedPct: 4, smCount: 4, holdersCount: 539, agScore: 72, liquidityPct: 12, volMcapPct: 180, kycCount: 3 },
        firstMetrics: { creatorHoldingPct: 4.1, bundledPct: 6, topHoldersPct: 28, drainedPct: 0, smCount: 2, holdersCount: 327, agScore: 60, liquidityPct: 18, volMcapPct: 90, kycCount: 1 } }; }
      if (u.pathname.includes('recent-swaps')) { const t = Date.now() / 1000; return { swaps: [{ side: 'buy', solAmount: 2, isSmartMoney: true, blockTime: t - 20 }, { side: 'buy', solAmount: 1, walletType: 1, blockTime: t - 70 }, { side: 'sell', solAmount: 0.5, isSmartMoney: true, blockTime: t - 130 }, { side: 'buy', solAmount: 0.7, walletType: 1, blockTime: t - 200 }, { side: 'sell', solAmount: 9, blockTime: t - 900 }] }; }
      if (u.pathname.includes('/swaps/by-token/')) { const m = u.pathname.split('/').pop(); if (this.sigsFor && this.sigsFor[m]) return { swaps: this.sigsFor[m] }; return { swaps: [{ presetName: 'Migrated runners', signalMcap: 4470 }, { presetName: 'SM follow', signalMcap: 5100 }] }; }
      if (u.pathname.includes('/annotations')) return {};
      return { ok: true };
    },
  };
}

async function setup(browser, { env = 'ag', tw = {}, orders = [], viewport = { width: 1100, height: 1100 }, body = '', path: pth, title = 'JEVABLE ↑ $6.97K | GMGN.AI' } = {}) {
  const page = await browser.newPage({ viewport, deviceScaleFactor: 1.5 });
  const be = backend();
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon|fonts\.g/.test(m.text())) errs.push(m.text()); });
  await page.exposeFunction('__be', (method, path, body) => be.handle(method, path, body ? JSON.parse(body) : null));
  const html = '<!doctype html><html><head><meta charset="utf-8"><title>' + title + '</title></head><body style="background:#0b0c0f;margin:0;height:3000px"><input id="outside" style="position:absolute;right:10px;top:10px">' + body + '</body></html>';
  await page.route('**/*', async (r) => {
    const u = new URL(r.request().url());
    if (u.hostname.includes('fonts.g')) return r.fulfill({ status: 200, body: '' });
    if (u.pathname.startsWith('/api/')) {
      let b = null; try { b = r.request().postDataJSON(); } catch (_) {}
      const j = be.handle(r.request().method(), u.pathname + u.search, b);
      return r.fulfill({ status: (j && j.__status) || 200, contentType: 'application/json', body: JSON.stringify(j) });
    }
    return r.fulfill({ status: 200, contentType: 'text/html', body: html });
  });
  const url = pth || (env === 'ag' ? 'https://backtester.alphagardeners.xyz/#token/' + MINT : 'https://gmgn.ai/sol/token/' + MINT);
  await page.goto(url);
  await page.evaluate(([tw, orders, env, ver]) => {
    localStorage.setItem('agtwTest', '1');
    window.GM_info = { script: { version: ver } }; window.__VER = ver;
    window.__gm = { tw: Object.assign({ mode: 'live', wallets: { live: [], paper: [] } }, tw), twOrders: orders, agRelayAt: env !== 'ag' ? 0 : Date.now() };
    window.__gmL = {};
    window.GM_getValue = (k, d) => (k in __gm ? JSON.parse(JSON.stringify(__gm[k])) : d);
    window.GM_setValue = (k, v) => { const o = __gm[k]; __gm[k] = JSON.parse(JSON.stringify(v)); (__gmL[k] || []).forEach((f) => f(k, o, v, false)); };
    window.GM_addValueChangeListener = (k, f) => { (__gmL[k] = __gmL[k] || []).push(f); };
    window.GM_xmlhttpRequest = (o) => { const u = new URL(o.url); window.__be(o.method, u.pathname + u.search, o.data || null).then((j) => setTimeout(() => o.onload({ status: (j && j.__status) || 200, responseText: JSON.stringify(j) }), 5)); };
    window.unsafeWindow = window;
    window.__opened = []; window.GM_openInTab = (u, o) => { window.__opened.push({ u, o }); };
    window.__fire = (k, v) => (__gmL[k] || []).forEach((f) => f(k, null, v, true));
    window.__sockH = {}; window.__emits = [];
    window.io = () => ({ connected: true, on: (e, f) => { (__sockH[e] = __sockH[e] || []).push(f); if (e === 'connect') setTimeout(f, 30); }, emit: (...a) => __emits.push(a.join(' ')) });
    window.__sock = (e, d) => (__sockH[e] || []).forEach((f) => f(d));
  }, [tw, orders, env, VER]);
  await page.addScriptTag({ content: SCRIPT });
  await page.waitForTimeout(900);
  const api = {
    page, be, errs,
    posts: (re) => be.calls.filter((c) => c.method === 'POST' && re.test(c.path)),
    clear: () => { be.calls.length = 0; },
    tick: (mcap, mint = MINT) => page.evaluate(([m, v]) => window.__fire('twTick', { mint: m, mcap: v, at: Date.now(), src: 'gmgn' }), [mint, mcap]),
    click: (sel) => page.click('#agtw ' + sel),
    modal: () => page.evaluate(() => { const m = document.querySelector('#agtw .mbox'); return m ? m.innerText.replace(/\s+/g, ' ') : null; }),
    modalBtn: (label) => page.evaluate((l) => { const b = [...document.querySelectorAll('#agtw .mbox .ma button')].find((x) => x.innerText.trim().startsWith(l)); if (b) b.click(); return !!b; }, label),
    gm: (k) => page.evaluate((k) => window.__gm[k], k),
    hook: (fn, ...a) => page.evaluate(([fn, a]) => window.__agtw[fn](...a), [fn, a]),
    shot: (name) => page.locator('#agtw').screenshot({ path: `${OUT}/${name}.png` }),
    wait: (ms) => page.waitForTimeout(ms),
  };
  return api;
}

async function main() {
  const browser = await chromium.launch();
  try {
    // ---------------------------------------------------------------- 1 · selection: buys use the group, sells use holders
    {
      const t = await setup(browser, { tw: { wallets: { live: [W[0], W[1], W[2]] }, buyMode: 'split', confirmAbove: 5, safety: { dupSec: 0 } } });
      await t.tick(6970); await t.wait(400);
      await t.shot('01-main');
      t.clear();
      await t.click('[data-bu="0.5"]'); await t.wait(500);
      const buys = t.posts(/\/buy$/);
      ok('buy uses the 3-wallet group even though only 2 wallets hold the coin', buys.length === 3 && new Set(buys.map((b) => b.body.walletAddress)).size === 3, `${buys.length} buys`);
      ok('split total ≈ 0.5 SOL', Math.abs(buys.reduce((a, b) => a + b.body.amount, 0) - 0.5) < 0.002);
      t.clear();
      await t.click('[data-su="25"]'); await t.wait(500);
      const sells = t.posts(/\/sell$/);
      ok('sell 25% uses only the 2 holders (auto)', sells.length === 2 && sells.every((s) => [W[0], W[1]].includes(s.body.walletAddress) && s.body.percent === 25));
      ok('no page errors (selection)', !t.errs.length, t.errs.join(' | '));
      await t.page.close();
    }
    // ---------------------------------------------------------------- 2 · safety rails
    {
      const t = await setup(browser, { tw: { wallets: { live: [W[0], W[1]] }, buyMode: 'split', confirmAbove: 5, safety: { maxPerCoin: 0.6, dailyLoss: 0, impactWarn: 10, dupSec: 3 } } });
      await t.tick(6970); await t.wait(400);
      t.clear();
      await t.click('[data-bu="1"]'); await t.wait(300);
      const m = await t.modal();
      ok('per-coin cap opens a confirm with the room left', !!m && /per-coin cap/.test(m) && /Buy 0\.\d+ ◎/.test(m), m);
      await t.shot('02-cap-modal');
      await t.modalBtn('Buy 0.'); await t.wait(500);
      const b = t.posts(/\/buy$/), tot = b.reduce((a, x) => a + x.body.amount, 0);
      ok('"Buy room" trims the order to the cap room', b.length === 2 && tot > 0.17 && tot < 0.185, `total ${tot.toFixed(4)} (room = 0.6 − 0.42 in = 0.18)`);
      t.clear();
      await t.click('[data-bu="0.1"]'); await t.wait(300);
      const m2 = await t.modal();
      ok('duplicate buy within 3s asks first', !!m2 && /You bought JEVABLE/.test(m2), m2);
      await t.page.keyboard.press('Escape'); await t.wait(300);
      ok('Esc cancels: nothing sent', t.posts(/\/buy$/).length === 0 && !(await t.modal()));
      await t.page.close();
    }
    {
      const t = await setup(browser, { tw: { wallets: { live: [W[0]] }, confirmAbove: 5, buyUnit: 'pct', safety: { maxPerCoin: 0, dailyLoss: 0.5, impactWarn: 10, dupSec: 0 } } });
      await t.tick(6970); await t.hook('loadDaily'); await t.wait(400);
      await t.shot('03-pct-impact-tiles');
      const hot = await t.page.$$eval('#agtw .t.b.hot', (x) => x.length);
      ok('% tiles above the impact threshold are flagged (5% ≈ +13%)', hot >= 1, `${hot} flagged`);
      t.clear();
      await t.click('[data-bu="5"]'); await t.wait(300);
      const m = await t.modal();
      ok('5% of supply: impact + daily-lock warnings in one dialog', !!m && /Price impact/.test(m) && /Daily loss limit hit/.test(m) && /Override/.test(m), m);
      await t.shot('04-impact-daily-modal');
      await t.modalBtn('Cancel'); await t.wait(200);
      ok('Cancel sends nothing', t.posts(/\/buy$/).length === 0);
      ok('no page errors (rails)', !t.errs.length, t.errs.join(' | '));
      await t.page.close();
    }
    // ---------------------------------------------------------------- 3 · exit strategy attached on AG
    {
      const t = await setup(browser, { tw: { wallets: { live: [W[0], W[1]] }, buyMode: 'each', confirmAbove: 5, stratId: 'runner', adv: true, safety: { dupSec: 0 } } });
      await t.tick(6970); await t.wait(600);
      await t.shot('05-adv-strategy');
      t.clear();
      await t.click('[data-bu="0.1"]'); await t.wait(4200);
      const p = t.posts(/\/tpsl$/);
      const lv = p[0] && p[0].body.levels;
      ok('after the buy, TP/SL is posted for both new positions', p.length === 2 && new Set(p.map((x) => x.body.botPositionId)).size === 2, `${p.length} posts`);
      ok('levels map to AG format', lv && lv.length === 4 && lv[0].type === 'TAKE_PROFIT' && lv[0].percentage === 100 && lv[0].amountPct === 50 && lv[3].type === 'STOP_LOSS' && lv[3].percentage === 35, JSON.stringify(lv));
      ok('existing AG levels sent as "expected" (no blind overwrite)', p.find((x) => x.body.botPositionId === 101).body.expected.levels.length === 1);
      const ex = (await t.gm('twOrders')).find((o) => o.type === 'exitx');
      ok('break-even rule armed as a browser order', !!ex && ex.be === true);
      // strategy editor
      await t.click('[data-a="sedit"]'); await t.wait(200);
      await t.page.fill('#agtw [data-se="p:0"]', '150'); await t.wait(100);
      await t.shot('06-strategy-editor');
      await t.click('[data-a="ssave"]'); await t.wait(200);
      const s = (await t.gm('tw')).strats.find((x) => x.id === 'runner');
      ok('strategy editor saves new levels', s && s.levels[0].p === 150, JSON.stringify(s && s.levels[0]));
      t.clear();
      await t.click('[data-a="sapply"]'); await t.wait(200);
      await t.modalBtn('Apply on AG'); await t.wait(800);
      ok('"Apply to position" replaces TP/SL on the open positions', t.posts(/\/tpsl$/).length === 2);
      // break-even: TP1 executed on position 101 → SL moved to 1%
      t.be.tpslPositions = () => [{ botPositionId: 101, walletAddress: W[0], isClosed: false, levels: [{ orderId: 1, type: 'TAKE_PROFIT', percentage: 150, amountPct: 50, executed: true }, { orderId: 2, type: 'STOP_LOSS', percentage: 35, amountPct: 100, managed: true, executed: false }] }];
      await t.page.evaluate(() => { const l = window.__gm.twOrders; l.forEach((o) => { if (o.type === 'exitx') o.beAt = 0; }); window.GM_setValue('twOrders', l); });
      t.clear();
      await t.hook('watch'); await t.wait(500);
      const beP = t.posts(/\/tpsl$/);
      ok('break-even: SL moved to −1% after TP1 filled', beP.length === 1 && beP[0].body.levels.find((x) => x.type === 'STOP_LOSS').percentage === 1, JSON.stringify(beP.map((x) => x.body.levels)));
      ok('no page errors (exits)', !t.errs.length, t.errs.join(' | '));
      await t.page.close();
    }
    // ---------------------------------------------------------------- 4 · triggers
    {
      const t = await setup(browser, { tw: { wallets: { live: [W[0], W[1]] }, buyMode: 'split', confirmAbove: 5, safety: { dupSec: 0 } } });
      await t.tick(10000); await t.wait(400);
      await t.click('[data-a="p:trig"]'); await t.wait(200);
      await t.click('[data-tq="-30"]'); await t.wait(150);
      await t.shot('07-trigger-form');
      await t.click('[data-a="arm"]'); await t.wait(200);
      await t.modalBtn('Arm'); await t.wait(200);
      let o = (await t.gm('twOrders')).find((x) => x.type === 'dip');
      ok('dip buy armed at −30% (7.0K) with the buy group', o && Math.abs(o.target - 7000) < 60 && o.wallets.length === 2, o && `${o.target}`);
      t.clear();
      await t.tick(8000); await t.hook('watch'); await t.wait(300);
      ok('no buy while above target', t.posts(/\/buy$/).length === 0);
      await t.tick(6900); await t.hook('watch'); await t.wait(600);
      ok('dip fires when mcap ≤ target (split over 2 wallets)', t.posts(/\/buy$/).length === 2);
      o = (await t.gm('twOrders')).find((x) => x.type === 'dip');
      ok('dip order marked done', o.status === 'done');
      // take profit at mcap + trailing + DCA, injected directly
      const now = Date.now();
      const extra = [
        { id: 'tp1', type: 'tpmc', mint: MINT, sym: 'JEVABLE', mode: 'live', created: now, status: 'active', state: {}, log: [], target: 12000, pct: 50, wallets: [W[0], W[1]], refMcap: 6900 },
        { id: 'tr1', type: 'trail', mint: MINT, sym: 'JEVABLE', mode: 'live', created: now, status: 'active', state: {}, log: [], pct: 20, peak: 6900, wallets: [W[0], W[1]], refMcap: 6900 },
        { id: 'dc1', type: 'dca', mint: MINT, sym: 'JEVABLE', mode: 'live', created: now, status: 'active', state: {}, log: [], total: 0.2, slices: 2, every: 5, done: 0, nextAt: now, split: false, wallets: [W[0]], refMcap: 6900 },
      ];
      await t.page.evaluate((x) => { window.GM_setValue('twOrders', window.__gm.twOrders.concat(x)); }, extra);
      t.clear();
      await t.tick(12500); await t.hook('watch'); await t.wait(600);
      const s1 = t.posts(/\/sell$/);
      ok('TP at mcap sells 50% on holders', s1.filter((x) => x.body.percent === 50).length === 2);
      ok('DCA slice 1 bought 0.1', t.posts(/\/buy$/).some((x) => Math.abs(x.body.amount - 0.1) < 1e-6));
      t.clear();
      await t.tick(9500); await t.hook('watch'); await t.wait(600); // −24% from the 12.5K peak → trailing (−20%) fires
      ok('trailing stop sells 100% after −20% from peak', t.posts(/\/sell$/).filter((x) => x.body.percent === 100).length === 2);
      await t.click('[data-a="p:trig"]'); await t.wait(100); await t.click('[data-a="p:trig"]'); await t.wait(300);
      await t.shot('08-triggers-armed');
      await t.wait(4800); t.clear(); await t.hook('watch'); await t.wait(500);
      const dc = (await t.gm('twOrders')).find((x) => x.id === 'dc1');
      ok('DCA slice 2 after the interval → done', dc.status === 'done' && dc.done === 2, `${dc.status} ${dc.done}/2`);
      ok('no page errors (triggers)', !t.errs.length, t.errs.join(' | '));
      await t.page.close();
    }
    // ---------------------------------------------------------------- 5 · hotkeys
    {
      const t = await setup(browser, { tw: { wallets: { live: [W[0]] }, confirmAbove: 5, hotkeys: 'on', safety: { dupSec: 0 } } });
      await t.tick(6970); await t.wait(300);
      await t.shot('09-hotkey-hints');
      t.clear();
      await t.page.keyboard.press('2'); await t.wait(400);
      ok('key 2 buys tile 2 (0.1 SOL)', t.posts(/\/buy$/).length === 1 && t.posts(/\/buy$/)[0].body.amount === 0.1);
      t.clear();
      await t.page.keyboard.press('Shift+Digit1'); await t.wait(500);
      ok('Shift+1 sells tile 1 (10%)', t.posts(/\/sell$/).length === 2 && t.posts(/\/sell$/)[0].body.percent === 10);
      t.clear();
      await t.page.click('#outside'); await t.page.keyboard.press('1'); await t.wait(300);
      ok('typing in a page input does not trade', t.posts(/\/(buy|sell)$/).length === 0);
      await t.page.mouse.click(600, 900);
      await t.page.keyboard.press('u'); await t.wait(150);
      ok('U cycles the buy unit', (await t.gm('tw')).buyUnit === 'usd');
      await t.page.keyboard.press('d'); await t.wait(150);
      ok('D opens the dip trigger', await t.page.$('#agtw [data-tt="dip"].on') !== null);
      await t.page.keyboard.press('Escape'); await t.wait(150);
      ok('Esc closes the panel', await t.page.$('#agtw .olp') === null);
      ok('no page errors (hotkeys)', !t.errs.length, t.errs.join(' | '));
      await t.page.close();
    }
    // ---------------------------------------------------------------- 6 · positions, alerts, info, share
    {
      const t = await setup(browser, { tw: { wallets: { live: [W[0], W[1]] }, confirmAbove: 5, safety: { dupSec: 0, dailyLoss: 3 } } });
      await t.tick(6970); await t.hook('loadHeld'); await t.hook('loadDaily'); await t.wait(300);
      await t.click('[data-a="p:pos"]'); await t.wait(400);
      const rows = await t.page.$$eval('#agtw .prw', (x) => x.length);
      ok('positions panel lists both coins', rows === 2, `${rows} rows`);
      await t.shot('10-positions');
      t.clear();
      await t.page.click(`#agtw [data-psell="${MINT2}"][data-x="100"]`); await t.wait(500);
      const s = t.posts(/\/sell$/);
      ok('row 100% sells DABCAT from its holder only', s.length === 1 && s[0].path.includes(MINT2) && s[0].body.walletAddress === W[3]);
      // dev alert with auto-sell off → card with actions
      await t.hook('pollDev'); t.be.devNow = '5.0%'; await t.hook('pollDev'); await t.wait(300);
      const al = await t.page.evaluate(() => (document.querySelector('#agtw .al.dev') || {}).innerText || '');
      ok('dev sell (10% → 5%) raises an alert card', /Dev sold 5\.0% of supply/.test(al), al.replace(/\s+/g, ' '));
      // whale
      await t.page.evaluate((m) => window.__sock('swap:new', { tokenAddress: m, side: 'sell', solAmount: 12, wallet: 'WhaleXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX' }), MINT); await t.wait(300);
      ok('whale sell ≥ 5 SOL raises an alert', /Whale sold 12/.test(await t.page.evaluate(() => document.querySelector('#agtw .als').innerText)));
      await t.click('[data-a="panelx"]'); await t.wait(200);
      await t.shot('11-alerts');
      t.clear();
      ok('only the 2 newest alerts show, older ones are summarised', /older alert/.test(await t.page.evaluate(() => document.querySelector('#agtw .als').innerText)));
      await t.page.click(`#agtw .al.dev [data-alsell]`); await t.wait(500);
      ok('alert "Sell 100%" sells every holder of that coin', t.posts(/\/sell$/).length >= 1 && t.posts(/\/sell$/).every((x) => x.body.percent === 100));
      // info + share
      await t.click('[data-a="p:info"]'); await t.wait(700);
      const info = await t.page.evaluate(() => document.querySelector('#agtw .olp').innerText.replace(/\s+/g, ' '));
      ok('info: AG profile chips', /Bundled 2\.3%/.test(info) && /Dev hold/.test(info), info.slice(0, 160));
      ok('info: your trades rows', (await t.page.$$eval('#agtw .tlr', (x) => x.length)) === 2);
      ok('info: connection status', /Price stream/.test(info) && /AG feed/.test(info));
      await t.shot('12-info');
      await t.page.click('#agtw .olp [data-a="p:share"]'); await t.wait(500);
      const img = await t.page.evaluate(() => { const i = document.querySelector('#agtw .shimg'); return i ? i.src.length : 0; });
      ok('share: PNG card rendered', img > 5000, `${img} chars`);
      await t.shot('13-share');
      ok('no page errors (positions/alerts/info)', !t.errs.length, t.errs.join(' | '));
      await t.page.close();
    }
    // ---------------------------------------------------------------- 7 · GMGN tab: live mode switch dialog, settings, collapsed, scaling
    {
      const t = await setup(browser, { env: 'gmgn', tw: { mode: 'paper', wallets: { live: [W[0], W[1]] } } });
      await t.wait(800);
      await t.click('[data-a="mode"]'); await t.wait(200);
      const m = await t.modal();
      ok('PAPER → LIVE asks in the widget dialog', !!m && /Switch to LIVE/.test(m));
      await t.shot('14-live-switch');
      await t.modalBtn('Go LIVE'); await t.wait(500);
      ok('mode switched to live', (await t.gm('tw')).mode === 'live');
      await t.click('[data-a="p:set"]'); await t.wait(300);
      await t.shot('15-settings');
      const h = await t.page.evaluate(() => document.getElementById('agtw').getBoundingClientRect().height);
      ok('settings panel scrolls inside the widget (widget fits the screen)', h <= 1100, `${h}px`);
      await t.click('[data-a="panelx"]'); await t.click('[data-a="col"]'); await t.wait(300);
      await t.shot('16-collapsed');
      ok('no page errors (GMGN)', !t.errs.length, t.errs.join(' | '));
      await t.page.close();
    }
    // ---------------------------------------------------------------- 8 · live feed: AG socket units, re-pricing, no reset while scrolling / typing
    {
      const t = await setup(browser, { tw: { wallets: { live: [W[0], W[1]] } } });
      await t.wait(300);
      ok('subscribes the coin on AG’s feed', (await t.page.evaluate(() => window.__emits)).some((e) => e.startsWith('subscribe:token')));
      await t.tick(6970); await t.wait(100);
      await t.page.evaluate((m) => window.__sock('candle:update', { tokenAddress: m, interval: '30s', candle: { c: 46.47 } }), MINT);
      await t.page.evaluate((m) => window.__sock('candle:update', { tokenAddress: m, interval: '30s', candle: { c: 56.67 } }), MINT);
      await t.wait(300);
      ok('AG candle in SOL-mcap units is calibrated to USD ($8.5K)', /\$8\.5K/.test(await t.page.evaluate(() => document.querySelector('#agtw .mc').innerText)));
      ok('PnL re-priced live from the tick', /LIVE/.test(await t.page.evaluate(() => document.querySelector('#agtw .pc').innerText)));
      // wallet list: 22 extra wallets, scroll, stream ticks, type
      t.be.handle = ((orig) => function (m, p, b) { const j = orig.call(this, m, p, b); if (p.includes('wallets-list')) j.wallets = j.wallets.concat(Array.from({ length: 22 }, (_, i) => ({ address: 'Zz' + String(i).padStart(2, '0') + 'X'.repeat(38), label: 'W' + (i + 5), balanceSol: 0.0015 }))); return j; })(t.be.handle);
      await t.click('[data-a="p:wal"]'); await t.wait(900);
      await t.page.evaluate(() => { document.querySelector('#agtw .wl2').scrollTop = 300; });
      await t.page.fill('#agtw [data-a=camt]', '0.75');
      for (let i = 0; i < 6; i++) { await t.tick(8600 + i * 100); await t.wait(120); }
      const st8 = await t.page.evaluate(() => [document.querySelector('#agtw .wl2').scrollTop, document.querySelector('#agtw [data-a=camt]').value]);
      ok('wallet list keeps its scroll position through live ticks', st8[0] === 300, String(st8[0]));
      ok('typed custom amount survives live ticks', st8[1] === '0.75');
      ok('no page errors (live feed)', !t.errs.length, t.errs.join(' | '));
      await t.page.close();
    }
    // ---------------------------------------------------------------- 9 · AG Intel panel (opt-in, coin pages only)
    {
      const t0 = await setup(browser, { tw: { wallets: { live: [W[0], W[1]] } } });
      await t0.wait(1200);
      ok('Intel side panel is off by default', !(await t0.page.$('#agtw .intel')));
      await t0.page.close();
      const t = await setup(browser, { tw: { wallets: { live: [W[0], W[1]] }, intel: { on: true, open: true }, v32: 1 } });
      await t.tick(6970); await t.wait(1500);
      const txt = await t.page.evaluate(() => (document.querySelector('#agtw .intel') || {}).innerText || '');
      ok('Intel panel docks next to the widget on a coin page', !!txt && /AG INTEL/.test(txt));
      ok('hero: AG score, 2 signals + presets, multiple since signal', /72/.test(txt) && /2 signals · Migrated runners, SM follow/.test(txt) && /1\.56×/.test(txt), txt.replace(/\s+/g, ' ').slice(0, 220));
      ok('ATH multiple + win pred', /ATH 2\.10×/.test(txt) && /win pred 41%/.test(txt));
      ok('risk tiles show signal → now', /Dev hold\s*0\.0%\s*4\.1% → 0\.0%/.test(txt) && /Top holders\s*31%/.test(txt), txt.replace(/\s+/g, ' ').slice(200, 480));
      const topLv = await t.page.$eval('#agtw .itile:nth-child(3)', (e) => e.className);
      ok('top holders 31% flagged "watch"', /mid/.test(topLv), topLv);
      ok('flow: 5-min net, smart money 1 buy / 1 sell, 2 fresh buyers', /net \+◎ 3\.20/.test(txt) && /1↑ 1↓/.test(txt) && /FRESH BUYERS\s*2/.test(txt), (txt.match(/Flow[\s\S]{0,160}/) || [''])[0].replace(/\s+/g, ' '));
      ok('holders +212 since signal; creator launch → now', /\+212 since signal/.test(txt) && /dev 12\.0% → 10\.0%/.test(txt));
      await t.click('[data-a="imore"]'); await t.wait(200);
      ok('all AG metrics expand', /Vol \/ MCap/.test(await t.page.evaluate(() => document.querySelector('#agtw .intel').innerText)));
      await t.shot('17-intel-docked');
      await t.click('.intel [data-a="idip"]'); await t.wait(200);
      ok('"Dip −30%" opens the dip trigger prefilled', (await t.page.evaluate(() => window.__agtw.ui.tf.target)) === '4.9K');
      await t.click('[data-a="panelx"]'); await t.click('.intel [data-a="intel"]'); await t.wait(200);
      ok('collapses to a slim tab', !!(await t.page.$('#agtw .intel.tab')));
      await t.shot('18-intel-tab');
      const box = await t.page.evaluate(() => { const r = document.getElementById('agtw').getBoundingClientRect(); return [r.right, window.innerWidth]; });
      ok('widget + panel stay on screen', box[0] <= box[1] + 1, box.join(' / '));
      ok('no page errors (intel)', !t.errs.length, t.errs.join(' | '));
      await t.page.close();
    }
    {
      const t = await setup(browser, { tw: { wallets: { live: [W[0]] }, intel: { on: true, open: true }, v32: 1 } });
      t.be.noProfile = true;
      await t.page.evaluate(() => { window.__agtw.ui.x = 1; }); await t.hook('loadPos'); await t.wait(1500);
      const txt = await t.page.evaluate(() => (document.querySelector('#agtw .intel') || {}).innerText || '');
      ok('no AG profile → clear message instead of empty tiles', /no profile|no signal|Loading/i.test(txt), txt.slice(0, 120));
      await t.page.close();
    }
    // ---------------------------------------------------------------- 10 · GMGN list page: no panel, AG pill + peek on cards, hide coin
    {
      const cards = [MINT, MINT2].map((m, i) => `<div href="/sol/token/${m}" style="position:relative;height:96px;margin:10px 0 0 420px;width:560px;background:#16181c;border:1px solid #222;color:#ddd;padding:8px;box-sizing:border-box">${i ? 'DABCAT' : 'JEVABLE'} card</div>`).join('');
      const t = await setup(browser, { env: 'gmgn', path: 'https://gmgn.ai/trend', body: cards, tw: { wallets: { live: [W[0]] } } });
      await t.wait(2500);
      ok('no Intel panel on a list page', !(await t.page.$('#agtw .intel')));
      const pill = await t.page.evaluate(() => (document.querySelector('.agtw-c .ip') || {}).innerText || '');
      ok('card shows the AG risk pill (dev · bundled · top · smart money)', /D 0\.0%/.test(pill) && /B 2\.3%/.test(pill) && /T 31%/.test(pill) && /SM 4/.test(pill), pill);
      await t.page.hover('.agtw-c .ip'); await t.wait(300);
      const peek = await t.page.evaluate(() => { const p = document.querySelector('.agtw-peek'); return p && p.style.display !== 'none' ? p.innerText : ''; });
      ok('hovering the pill opens the AG peek', /1\.56× signal/.test(peek) && /Hide coin/.test(peek), peek.replace(/\s+/g, ' ').slice(0, 120));
      await t.page.screenshot({ path: `${OUT}/19-cards-peek.png`, clip: { x: 400, y: 0, width: 620, height: 330 } });
      await t.page.click('.agtw-peek [data-phide]'); await t.wait(400);
      ok('"Hide coin" hides that card', await t.page.evaluate((m) => document.querySelector(`div[href="/sol/token/${m}"]`).style.display === 'none', MINT));
      ok('no page errors (cards)', !t.errs.length, t.errs.join(' | '));
      await t.page.close();
    }
    // ---------------------------------------------------------------- 10b · Trojan: Trenches cards + token page
    {
      const chip = `<a href="/terminal?token=${MINT}&x=1" style="display:block;height:28px;width:200px;margin:0 0 0 420px;background:#222;color:#ddd">JEVABLE chip</a>`;
      const cards = [MINT, MINT2].map((m, i) => `<a href="/terminal?token=${m}&chain=sol" style="display:block;position:relative;height:120px;margin:10px 0 0 420px;width:472px;background:#16181c;border:1px solid #222;color:#ddd;padding:8px;box-sizing:border-box"><img alt="${i ? 'DABCAT' : 'JEVABLE'}" width="1" height="1">0.69 V $5.28K MC</a>`).join('');
      const t = await setup(browser, { env: 'trojan', path: 'https://trojan.com/trenches', title: 'Trenches | Trojan', body: chip + cards, tw: { wallets: { live: [W[0]] } } });
      await t.wait(2500);
      const r = await t.page.evaluate(([m, m2]) => ({
        chip: !!document.querySelector(`a[href*="x=1"] .agtw-c`),
        c1: (document.querySelector(`a[href="/terminal?token=${m}&chain=sol"] .agtw-c`) || {}).innerText || '',
        c2: !!document.querySelector(`a[href="/terminal?token=${m2}&chain=sol"] .agtw-c`),
      }), [MINT, MINT2]);
      ok('Trojan: overlay on Trenches cards', r.c2 && /◎/.test(r.c1), r.c1);
      ok('Trojan: 28px ticker chips are left alone', !r.chip);
      const href0 = t.page.url();
      await t.page.click(`a[href="/terminal?token=${MINT}&chain=sol"] .agtw-c .qb`); await t.wait(500);
      ok('Trojan: ⚡ on a card does not open the coin', t.page.url() === href0, t.page.url());
      ok('no page errors (Trojan cards)', !t.errs.length, t.errs.join(' | '));
      await t.page.close();
    }
    {
      const t = await setup(browser, { env: 'trojan', path: `https://trojan.com/terminal?token=${MINT}&chain=sol`, title: 'DATACENTER $6.97K | Trojan', tw: { wallets: { live: [W[0]] } } });
      await t.wait(1500);
      const tk = await t.page.evaluate((m) => { const x = window.__agtw.ticks[m]; return x ? { mcap: x.mcap, src: x.src } : null; }, MINT);
      ok('Trojan token page: mint from ?token= and live mcap from the title', tk && tk.mcap === 6970 && tk.src === 'trojan', JSON.stringify(tk));
      const head = await t.page.evaluate(() => (document.querySelector('#agtw') || {}).innerText || '');
      ok('Trojan token page: widget shows the symbol from the title', /DATACENTER/.test(head), (head.match(/.{0,30}DATACENTER.{0,30}/) || [head.slice(0, 80)])[0]);
      ok('no page errors (Trojan token)', !t.errs.length, t.errs.join(' | '));
      await t.page.close();
    }
    // ---------------------------------------------------------------- 10c · Axiom: Pulse cards + token page (mint read from the page)
    {
      const cards = [MINT, MINT2].map((m, i) => `<div data-pulse-token-address="${m}" style="position:relative;height:116px;margin:10px 0 0 420px;width:491px;background:#16181c;border:1px solid #222;color:#ddd;padding:8px;box-sizing:border-box"><img alt="Pump V1" width="1" height="1"><img alt="${i ? 'DABCAT' : 'JEVABLE'}" width="1" height="1"><a href="https://pump.fun/coin/${m}">pf</a> V $36K MC $22.5K</div>`).join('');
      const t = await setup(browser, { env: 'axiom', path: 'https://axiom.trade/pulse', title: 'Axiom SOL | Pulse', body: cards, tw: { wallets: { live: [W[0]] } } });
      await t.wait(2500);
      const r = await t.page.evaluate(([m, m2]) => ({ c1: (document.querySelector(`[data-pulse-token-address="${m}"] .agtw-c`) || {}).innerText || '', c2: !!document.querySelector(`[data-pulse-token-address="${m2}"] .agtw-c`), mint: !!(document.querySelector('#agtw') || {}).innerText && /Open a token/.test(document.querySelector('#agtw').innerText) }), [MINT, MINT2]);
      ok('Axiom: overlay on Pulse cards', r.c2 && /◎/.test(r.c1), r.c1);
      ok('Axiom: Pulse is not a coin page (no mint)', r.mint);
      ok('no page errors (Axiom cards)', !t.errs.length, t.errs.join(' | '));
      await t.page.close();
    }
    {
      const PAIR = 'D47ZQ7BcNvDhjviQattcvm4WcJLouqTXwkU4QER5vePn';
      const t = await setup(browser, { env: 'axiom', path: 'https://axiom.trade/meme/' + PAIR, title: 'SIQ ↓ $6.97K | Axiom SOL', body: `<a href="https://solscan.io/token/${MINT}">solscan</a>`, tw: { wallets: { live: [W[0]] } } });
      await t.wait(1500);
      const tk = await t.page.evaluate((m) => { const x = window.__agtw.ticks[m]; return x ? { mcap: x.mcap, src: x.src } : null; }, MINT);
      ok('Axiom token page: mint from the page link (URL has the pair) + live mcap from the title', tk && tk.mcap === 6970 && tk.src === 'axiom', JSON.stringify(tk));
      const head = await t.page.evaluate(() => (document.querySelector('#agtw') || {}).innerText || '');
      ok('Axiom token page: widget shows the symbol', /\bSIQ\b/.test(head) && !/SIQ\s*[^\sA-Za-z0-9]{2}/.test(head), (head.match(/.{0,20}SIQ.{0,20}/) || [head.slice(0, 60)])[0]);
      // in-app navigation to another coin: the old link lingers in the DOM → the old mint must not stick to the new page
      await t.page.evaluate(() => history.pushState({}, '', '/meme/2Y1aBcDeFgHiJkLmNoPqRsTuVwXyZ123456789ab'));
      await t.wait(900);
      const stale = await t.page.evaluate(() => /Open a token/.test(document.querySelector('#agtw').innerText));
      await t.page.evaluate((m) => { document.querySelector('a[href*="solscan"]').href = 'https://solscan.io/token/' + m; }, MINT2);
      await t.wait(900);
      const nowM2 = await t.page.evaluate((m) => (document.querySelector('#agtw').innerText || '').includes(m.slice(0, 4)), MINT2);
      ok('Axiom: after navigating, the previous coin is not reused; the new one is picked up', stale && nowM2, `stale-cleared=${stale} new=${nowM2}`);
      ok('no page errors (Axiom token)', !t.errs.length, t.errs.join(' | '));
      await t.page.close();
    }
    // ---------------------------------------------------------------- 11 · holdings bar at the top
    {
      const t = await setup(browser, { env: 'gmgn', tw: { wallets: { live: [W[0]] } } });
      await t.wait(1800);
      const bar = await t.page.evaluate(() => { const b = document.getElementById('agtwBar'); return b && b.style.display !== 'none' ? b.innerText.replace(/\s+/g, ' ') : ''; });
      ok('holdings bar lists both open positions with PnL', /JEVABLE/.test(bar) && /DABCAT/.test(bar) && /◎ −0\.100 \(-20\.0%\)/.test(bar), bar);
      await t.page.screenshot({ path: `${OUT}/20-holdings-bar.png`, clip: { x: 0, y: 0, width: 1100, height: 60 } });
      t.clear();
      const sel = `#agtwBar [data-bar="sell"][data-m="${MINT2}"]`;
      await t.page.click(sel); await t.wait(400);
      ok('first click only arms the 100% sell', t.posts(/\/sell$/).length === 0 && /Sure\? 100%/.test(await t.page.$eval(sel, (e) => e.innerText)));
      await t.page.screenshot({ path: `${OUT}/21-holdings-bar-armed.png`, clip: { x: 0, y: 0, width: 1100, height: 60 } });
      await t.page.click(sel); await t.wait(2600); // GMGN tab without a backtester tab: 1.5s relay nudge, then direct
      const s2 = t.posts(/\/sell$/);
      ok('second click sells 100% from that coin’s holder', s2.length === 1 && s2[0].path.includes(MINT2) && s2[0].body.percent === 100 && s2[0].body.walletAddress === W[3]);
      t.clear();
      await t.page.click(sel); await t.wait(2800); await t.page.click(sel); await t.wait(400);
      ok('arming expires after 2.5s (a late click re-arms, no sell)', t.posts(/\/sell$/).length === 0);
      await t.page.click('#agtwBar [data-bar="toggle"]'); await t.wait(300);
      ok('the AG tag hides the bar', await t.page.evaluate(() => document.getElementById('agtwBar').style.display === 'none'));
      await t.page.mouse.move(700, 700); await t.page.evaluate(() => { window.__agtw.st.hotkeys = 'on'; }); await t.page.keyboard.press('b'); await t.wait(300);
      ok('B brings it back', await t.page.evaluate(() => document.getElementById('agtwBar').style.display !== 'none'));
      ok('no page errors (bar)', !t.errs.length, t.errs.join(' | '));
      await t.page.close();
    }
    // ---------------------------------------------------------------- 12 · wide (horizontal) layout
    {
      const t = await setup(browser, { env: 'ag', viewport: { width: 1400, height: 1000 }, tw: { wallets: { live: [W[0]] } } });
      await t.wait(1200);
      const box = () => t.page.evaluate(() => { const r = document.querySelector('#agtw .in').getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x) }; });
      const tall = await box();
      ok('tall by default (no .wide)', !(await t.page.$('#agtw.wide')), JSON.stringify(tall));
      await t.page.screenshot({ path: `${OUT}/22-tall.png` });
      const rw = await t.page.$eval('#agtw .rw', (e) => { const r = e.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; });
      await t.page.mouse.move(rw[0], rw[1]); await t.page.mouse.down();
      await t.page.mouse.move(rw[0] + 200, rw[1], { steps: 6 }); await t.page.mouse.move(rw[0] + 400, rw[1], { steps: 6 }); await t.page.mouse.up(); await t.wait(500);
      const wide = await box();
      ok('dragging the right edge widens the widget', wide.w > tall.w + 250, `${tall.w} → ${wide.w}`);
      ok('past 600 it switches to the 2-column layout', !!(await t.page.$('#agtw.wide')));
      const cols = await t.page.evaluate(() => { const b = document.querySelector('#agtw .sbuy').getBoundingClientRect(), s = document.querySelector('#agtw .ssell').getBoundingClientRect(); return { bx: b.x, sx: s.x, by: b.y, sy: s.y, sb: s.bottom, bb: b.bottom }; });
      ok('buy and sell sit side by side', cols.sx > cols.bx + 150 && Math.abs(cols.sy - cols.by) < 80, JSON.stringify(cols));
      ok('wide is noticeably shorter than tall', wide.h < tall.h * 0.8, `${tall.h}px → ${wide.h}px`);
      ok('width is saved', (await t.page.evaluate(() => window.__agtw.st.w)) >= 600);
      await t.page.screenshot({ path: `${OUT}/23-wide.png` });
      await t.page.click('#agtw .rw', { clickCount: 2 }); await t.wait(400);
      ok('double-click on the edge resets to tall', !(await t.page.$('#agtw.wide')) && (await t.page.evaluate(() => window.__agtw.st.w)) === 380);
      await t.page.click('#agtw [data-a="p:set"]'); await t.wait(300);
      await t.page.click('#agtw [data-lw="720"]'); await t.wait(400);
      ok('Settings → Layout → Wide switches to 2 columns', !!(await t.page.$('#agtw.wide')) && (await box()).w > 650);
      await t.page.screenshot({ path: `${OUT}/24-wide-settings.png` });
      await t.page.click('#agtw [data-lw="380"]'); await t.wait(400);
      ok('Settings → Tall goes back', !(await t.page.$('#agtw.wide')));
      ok('no page errors (wide)', !t.errs.length, t.errs.join(' | '));
      await t.page.close();
    }
    // ---------------------------------------------------------------- 13 · a hidden coin comes back when AG signals it
    {
      const cards = [MINT, MINT2].map((m, i) => `<div href="/sol/token/${m}" style="position:relative;height:96px;margin:10px 0 0 420px;width:560px;background:#16181c;border:1px solid #222;color:#ddd;padding:8px;box-sizing:border-box">${i ? 'DABCAT' : 'JEVABLE'} card</div>`).join('');
      const t = await setup(browser, { env: 'gmgn', path: 'https://gmgn.ai/trend', body: cards, tw: { wallets: { live: [W[0]] } } });
      t.be.sigsFor = { [MINT2]: [] }; // no AG signal yet on DABCAT
      await t.wait(2500);
      await t.page.hover(`div[href="/sol/token/${MINT2}"] .ip[data-peek]`); await t.wait(500);
      await t.page.click('.agtw-peek [data-phide]'); await t.wait(400);
      const shown = () => t.page.evaluate((m) => document.querySelector(`div[href="/sol/token/${m}"]`).style.display !== 'none', MINT2);
      ok('hiding records when it was hidden', !(await shown()) && (await t.page.evaluate((m) => !!window.__agtw.st.hiddenMeta[m].t, MINT2)));
      const rescan = async () => { await t.page.evaluate(() => { for (const k in window.__agtw.hidChk) delete window.__agtw.hidChk[k]; window.__agtw.scanCards(); }); await t.wait(2600); };
      await rescan();
      ok('no new signal → it stays hidden', !(await shown()));
      t.be.sigsFor[MINT2] = [{ presetName: 'Old preset', signalAt: Math.floor(Date.now() / 1000) - 3600 }];
      await rescan();
      ok('a signal older than the hide does not bring it back', !(await shown()));
      t.be.sigsFor[MINT2].push({ presetName: 'Migrated runners', signalAt: Math.floor(Date.now() / 1000) + 5 });
      await rescan();
      ok('a new AG signal unhides the coin', await shown());
      const tag = await t.page.evaluate((m) => { const c = document.querySelector(`div[href="/sol/token/${m}"]`); return (c.querySelector('.agtw-c .sg') || {}).innerText || '' ; }, MINT2);
      ok('the card is flagged "AG SIGNAL"', /AG SIGNAL/.test(tag), tag);
      ok('toast names the preset', await t.page.evaluate(() => [...document.querySelectorAll('.agtw-toast')].some((e) => /AG signal on .*Migrated runners/.test(e.innerText))));
      ok('removed from the hidden list', await t.page.evaluate((m) => !window.__agtw.st.hiddenCoins.includes(m), MINT2));
      await t.page.screenshot({ path: `${OUT}/25-unhidden-on-signal.png`, clip: { x: 400, y: 0, width: 620, height: 240 } });
      ok('no page errors (unhide on signal)', !t.errs.length, t.errs.join(' | '));
      await t.page.close();
    }
    // ---------------------------------------------------------------- 14 · GMGN ⇄ backtester relay: ack, fallback, health footbar
    {
      const t = await setup(browser, { env: 'gmgn', tw: { wallets: { live: [W[0]] }, confirmAbove: 99, safety: { dupSec: 0 } } });
      // a fake backtester tab: owns the relay, acks + answers calls, answers pings with a health snapshot
      await t.page.evaluate(() => {
        window.__relay = { mode: 'ok', v: window.__VER, sess: { ok: true, status: 200, ms: 180 }, relayed: [] };
        const own = () => { __gm.agRelayOwner = { id: 'tabA', at: Date.now(), v: __relay.v, vis: false }; __gm.agRelayAt = Date.now(); };
        own(); window.__ownT = setInterval(() => { if (__relay.mode !== 'gone') own(); }, 1000);
        const set0 = window.GM_setValue;
        window.GM_setValue = (k, v) => {
          set0(k, v);
          const R = window.__relay;
          if (k === 'agRpc' && R.mode !== 'silent' && R.mode !== 'gone') {
            setTimeout(() => __fire('agRpcAck', { id: v.id, at: Date.now() }), 15);
            if (R.mode === 'ok') Promise.all(v.calls.map((c) => R.sess.ok ? window.__be(c.method, c.path, c.body ? JSON.stringify(c.body) : null).then((j) => ({ status: 200, ok: true, j })) : { status: 401, ok: false, j: { error: 'unauthorized' } }))
              .then((results) => { R.relayed.push(...v.calls.map((c) => c.path)); setTimeout(() => __fire('agRpcRes', { id: v.id, results }), 30); });
          }
          if (k === 'agPing' && (R.mode === 'ok' || R.mode === 'ackonly')) { const now = Date.now();
            setTimeout(() => __fire('agPong', { id: v.id, h: { v: R.v, at: now, vis: false, leader: true, sess: Object.assign({ at: now }, R.sess), sock: { ok: true, since: now - 60000, last: now - 1200, ping: now - 3000, re: 1, subs: 2 }, log: [{ t: now - 5000, m: 'AG socket reconnected after 3.1 s · resubscribing', lvl: 'i' }] } }), 25); }
        };
      });
      const fb = () => t.page.evaluate(() => { const f = document.querySelector('#agtw .hf'); return f ? { cls: f.className, txt: f.innerText.replace(/\s+/g, ' ') } : null; });
      await t.hook('healthTick'); await t.page.evaluate(() => window.GM_setValue('agPing', { id: window.__agtw.hs.pingId = 'p1', at: window.__agtw.hs.pingAt = Date.now() })); await t.wait(1300);
      let f = await fb();
      ok('footbar shows Relay ms · AG ms · Feed · Orders', f && /Relay \d+ ?ms/.test(f.txt) && /AG \d+ ?ms/.test(f.txt) && /Feed/.test(f.txt) && /Orders AG tab/.test(f.txt), f && f.txt);
      ok('healthy = quiet footbar (no action button)', f && /\bg\b/.test(f.cls) && !(await t.page.$('#agtw .hfa')), f && f.cls);
      await t.page.locator('#agtw').screenshot({ path: `${OUT}/26-footbar-healthy.png` });
      t.clear();
      await t.click('[data-bu="0.1"]'); await t.wait(900);
      const relayed = await t.page.evaluate(() => window.__relay.relayed);
      ok('a buy goes through the backtester tab exactly once', t.posts(/\/buy$/).length === 1 && relayed.some((p) => /\/buy$/.test(p)), JSON.stringify(relayed));
      // frozen backtester tab: nothing acks → direct after 1.5s, once
      await t.page.evaluate(() => { window.__relay.mode = 'silent'; window.__relay.relayed = []; }); t.clear();
      const t0 = Date.now(); await t.click('[data-bu="0.1"]');
      for (let i = 0; i < 40 && !t.posts(/\/buy$/).length; i++) await t.wait(100);
      const dt = Date.now() - t0;
      ok('no ack in 1.5 s → the buy goes direct (not lost, not doubled)', t.posts(/\/buy$/).length === 1 && dt < 2600 && !(await t.page.evaluate(() => window.__relay.relayed.length)), dt + ' ms');
      t.clear(); const t1 = Date.now(); await t.click('[data-bu="0.1"]');
      for (let i = 0; i < 30 && !t.posts(/\/buy$/).length; i++) await t.wait(50);
      ok('next calls skip the sleeping tab for 15 s (no 1.5 s wait each time)', Date.now() - t1 < 800, (Date.now() - t1) + ' ms');
      ok('the event log says why', /did not answer in 1\.5s → sent direct/.test(JSON.stringify(await t.page.evaluate(() => window.__agtw.hs.log))));
      // acked but no result: an order is never resent
      await t.page.evaluate(() => { window.__relay.mode = 'ackonly'; window.__agtw.H.lostMs = 1200; window.GM_setValue('agPing', { id: window.__agtw.hs.pingId = 'p2', at: window.__agtw.hs.pingAt = Date.now() }); }); await t.wait(300);
      await t.page.evaluate(() => { window.__agtw.hs.pongAt = Date.now(); }); // relay looks alive again
      t.clear();
      await t.page.evaluate(() => { window.__agtw.H.skipAfterMiss = 0; }); // don't skip the relay after the earlier miss
      await t.click('[data-bu="0.1"]'); await t.wait(1800);
      ok('acked but no answer → the order is NOT re-sent direct', t.posts(/\/buy$/).length === 0 && /took the order but did not answer/.test(await t.page.evaluate(() => [...document.querySelectorAll('.agtw-toast')].map((e) => e.innerText).join(' | '))));
      await t.page.evaluate(() => { window.__agtw.H.lostMs = 20000; window.__agtw.H.skipAfterMiss = 15000; window.__relay.mode = 'ok'; });
      // AG session expired
      await t.page.evaluate(() => { window.__relay.sess = { ok: false, status: 401, ms: 90 }; window.GM_setValue('agPing', { id: window.__agtw.hs.pingId = 'p3', at: window.__agtw.hs.pingAt = Date.now() }); }); await t.wait(300);
      await t.hook('healthTick'); await t.wait(200);
      f = await fb();
      ok('401 → red footbar with "Log in"', f && /\br\b/.test(f.cls) && /AG 401/.test(f.txt) && /Log in/.test(f.txt), f && f.txt);
      await t.page.locator('#agtw').screenshot({ path: `${OUT}/27-footbar-401.png` });
      t.clear(); await t.click('[data-bu="0.1"]'); await t.wait(500);
      ok('buys are refused up front with the reason', t.posts(/\/buy$/).length === 0 && /session expired \(401\)/.test(await t.page.evaluate(() => [...document.querySelectorAll('.agtw-toast')].map((e) => e.innerText).join(' | '))));
      await t.page.evaluate(() => { window.__relay.sess = { ok: true, status: 200, ms: 170 }; window.GM_setValue('agPing', { id: window.__agtw.hs.pingId = 'p4', at: window.__agtw.hs.pingAt = Date.now() }); }); await t.wait(300);
      // version mismatch
      await t.page.evaluate(() => { window.__relay.v = '3.4.0'; window.__gm.agRelayOwner.v = '3.4.0'; }); await t.wait(1100); await t.hook('healthTick');
      f = await fb();
      ok(`older script in the backtester tab → amber "Reload AG tab (3.4.0 → ${VER})"`, f && /\by\b/.test(f.cls) && new RegExp(`Reload AG tab \\(3\\.4\\.0 → ${VRE}\\)`).test(f.txt), f && f.txt);
      await t.page.click('#agtw .hfa'); await t.wait(200);
      ok('…which asks that tab to reload', (await t.gm('agCmd') || {}).cmd === 'reload');
      await t.page.evaluate(() => { window.__relay.v = window.__VER; });
      // panel
      await t.page.click('#agtw .hfi'); await t.wait(400);
      const pan = await t.page.evaluate(() => { const p = document.querySelector('#agtw .olp'); return p ? p.innerText.replace(/\s+/g, ' ') : ''; });
      ok('clicking the footbar opens the connection panel', /Connection/.test(pan) && /Relay · backtester tab/.test(pan) && /AG socket\s*connected/.test(pan) && /LAST EVENTS/.test(pan), pan.slice(0, 260));
      ok('the panel merges events from both tabs', /AG socket reconnected after 3\.1 s/.test(pan) && /sent direct/.test(pan));
      await t.page.locator('#agtw').screenshot({ path: `${OUT}/28-health-panel.png` });
      await t.page.click('#agtw [data-ha="reconnect"]'); await t.wait(200);
      ok('Reconnect asks the backtester tab to reconnect', (await t.gm('agCmd') || {}).cmd === 'reconnect');
      // backtester tab closed: auto re-open in the background, rate-limited
      await t.page.evaluate(() => { window.__relay.mode = 'gone'; delete window.__gm.agRelayOwner; window.__gm.agRelayAt = Date.now() - 40000; window.__opened.length = 0; });
      await t.hook('healthTick'); await t.hook('healthTick'); await t.wait(200);
      const op = await t.page.evaluate(() => window.__opened);
      ok('gone for 30 s → re-opened once, in the background', op.length === 1 && op[0].o.active === false && /backtester\.alphagardeners\.xyz/.test(op[0].u), JSON.stringify(op));
      f = await fb();
      ok('footbar: Relay closed · AG direct · "Open AG"', f && /Relay closed/.test(f.txt) && /Open AG/.test(f.txt), f && f.txt);
      await t.page.evaluate(() => { window.__agtw.st.autoReopen = false; window.__gm.agReopenAt = 0; window.__opened.length = 0; }); await t.hook('healthTick');
      ok('auto re-open can be turned off', (await t.page.evaluate(() => window.__opened.length)) === 0);
      await t.page.evaluate(() => clearInterval(window.__ownT));
      ok('no page errors (relay)', !t.errs.length, t.errs.join(' | '));
      await t.page.close();
    }
    // ---------------------------------------------------------------- 15 · backtester side: one relay owner, ack, ping, session
    {
      const t = await setup(browser, { env: 'ag', tw: { wallets: { live: [W[0]] } } });
      await t.wait(1800);
      const own = await t.gm('agRelayOwner');
      ok('the backtester tab claims the relay (with its version)', own && own.id && own.v === VER, JSON.stringify(own));
      const rpc = (id, ageMs, ack = 1500) => t.page.evaluate(([id, a, k, m]) => window.__fire('agRpc', { id, at: Date.now() - a, ackMs: k, calls: [{ method: 'GET', path: `/api/tokens/${m}/profile` }] }), [id, ageMs, ack, MINT]);
      const runs = () => t.be.calls.filter((c) => c.path === `/api/tokens/${MINT}/profile`).length;
      t.clear(); await rpc('r1', 0); await t.wait(500);
      ok('owner acks then answers', (await t.gm('agRpcAck') || {}).id === 'r1' && (await t.gm('agRpcRes') || {}).id === 'r1' && runs() === 1);
      await rpc('r1', 0); await t.wait(300);
      ok('the same call id never runs twice', runs() === 1);
      await rpc('r2', 2000); await t.wait(300);
      ok('a call older than 0.7 s is dropped (the GMGN tab already went direct)', runs() === 1 && (await t.gm('agRpcAck')).id === 'r1');
      await t.page.evaluate(() => { window.__gm.agRelayOwner = { id: 'otherTab', at: Date.now(), v: window.__VER }; });
      await rpc('r3', 0); await t.wait(300);
      ok('a standby backtester tab ignores calls (no double buys with 2 AG tabs)', runs() === 1);
      await t.page.evaluate(() => { window.__gm.agRelayOwner.at = Date.now() - 20000; }); await t.wait(3300); // lease expired → this tab takes over on its next beat
      await rpc('r4', 0); await t.wait(400);
      ok('…and takes over when the owner goes away', (await t.gm('agRpcRes')).id === 'r4' && (await t.gm('agRelayOwner')).id === own.id, runs() + ' ' + JSON.stringify(await t.gm('agRelayOwner')));
      await t.page.evaluate(() => window.__fire('agPing', { id: 'pp', at: Date.now() })); await t.wait(200);
      const pong = await t.gm('agPong');
      ok('answers pings with a health snapshot (version, session, socket, watcher)', pong && pong.id === 'pp' && pong.h.v === VER && pong.h.sess && pong.h.sess.ok && pong.h.sock && 'leader' in pong.h, JSON.stringify(pong && pong.h).slice(0, 200));
      const f = await t.page.evaluate(() => document.querySelector('#agtw .hf').innerText.replace(/\s+/g, ' '));
      ok('backtester footbar: Relay this tab · AG ms · Feed · Orders', /Relay this tab/.test(f) && /AG \d+ ?ms/.test(f) && /Orders/.test(f), f);
      t.be.authDown = true;
      await t.page.evaluate(() => window.__fire('agCmd', { cmd: 'wake', at: Date.now() })); await t.wait(600); await t.hook('healthTick');
      const f2 = await t.page.evaluate(() => { const e = document.querySelector('#agtw .hf'); return e.className + ' ' + e.innerText.replace(/\s+/g, ' '); });
      ok('expired AG session is detected (red, Log in)', /\br\b/.test(f2) && /AG 401/.test(f2) && /Log in/.test(f2), f2);
      t.be.authDown = false;
      ok('no page errors (relay owner)', !t.errs.filter((e) => !/status of 401/.test(e)).length, t.errs.join(' | '));
      await t.page.close();
    }
  } catch (e) { fail++; results.push('CRASH ' + (e && e.stack || e)); }
  await browser.close();
  console.log(results.join('\n'));
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
if (require.main === module) main(); else module.exports = { setup, backend, chromium, MINT, MINT2, W };
