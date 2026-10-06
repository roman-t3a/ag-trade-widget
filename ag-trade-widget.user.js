// ==UserScript==
// @name         AG Trade Widget
// @namespace    milerius.ag.trade
// @version      3.0.0
// @description  Floating quick buy/sell panel (GMGN / Axiom style) that trades through your Alpha Gardeners wallets. Buy in SOL / USD / % of supply, sell in % or SOL, wallet groups, split buys (jitter / stagger), consolidate / split planner, edit-in-place presets, auto exits, USD PnL, paper or LIVE. Works on the AG backtester and on GMGN.
// @match        https://backtester.alphagardeners.xyz/*
// @match        https://gmgn.ai/*
// @match        https://*.gmgn.ai/*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addValueChangeListener
// @grant        unsafeWindow
// @connect      backtester.alphagardeners.xyz
// @require      https://cdn.jsdelivr.net/npm/socket.io-client@4.7.5/dist/socket.io.min.js
// ==/UserScript==

(function () {
  'use strict';
  const MINT_RE = /[1-9A-HJ-NP-Za-km-z]{32,44}/;

  if (/(^|\.)gmgn\.ai$/.test(location.hostname)) {
    // ---------------------------------------------------------------- GMGN
    // Token = the GMGN token page you're on. Orders are relayed through your open backtester tab.
    tradeWidget('gmgn',
      () => (location.pathname.match(/\/sol\/token\/(?:[A-Za-z0-9]+_)?([1-9A-HJ-NP-Za-km-z]{32,44})/) || [])[1] || null,
      () => { // title: "PUMPKART ↑ $76.62K | GMGN.AI …"
        const t = document.title, m = t.match(/^\s*\$?([^\s↑↓|$]{1,20})\s*[↑↓]/) || t.match(/^\s*\$?([A-Za-z0-9._-]{1,20})\s/);
        return m && !/^gmgn/i.test(m[1]) ? m[1] : '';
      },
      null);
    return;
  }

  // ------------------------------------------------------------ backtester
  const W = unsafeWindow;
  const bus = agBus(W, (u, o) => W.fetch(u, o));
  // Read-only GETs go through the shared bus: one in-flight request + a short cache per path, shared with
  // AG Intel (its trailing SL polls the same holdings). maxAge per endpoint, in ms:
  const GET_AGE = [[/^\/api\/performance\/holdings/, 1500], [/^\/api\/performance\/wallets-list/, 30000],
    [/\/my-trades/, 2500], [/\/annotations$/, 2000], [/\/profile$/, 5000]];
  // Same-origin call, exactly like AG's own Buy / Sell buttons.
  const agLocalCall = (method, path, body) => {
    if (method === 'GET') { const a = GET_AGE.find(([re]) => re.test(path)); if (a) return bus.get(path, a[1]); }
    return W.fetch(path, {
      method, credentials: 'same-origin', headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined,
    }).then(async (r) => ({ status: r.status, ok: r.ok, j: await r.json().catch(() => ({})) })).catch((e) => ({ status: 0, ok: false, j: { error: String(e) } }))
      .then((r) => { if (method === 'POST') { bus.drop('/api/performance/'); bus.drop('/api/tokens/'); } return r; }); // positions changed
  };

  // Orders placed from the GMGN widget arrive here; only whitelisted AG endpoints are executed.
  GM_addValueChangeListener('agRpc', async (_k, _o, v, remote) => {
    if (!remote || !v || !Array.isArray(v.calls) || Date.now() - v.at > 15000) return;
    const results = await Promise.all(v.calls.map((c) => agPathAllowed(c.method, c.path)
      ? agLocalCall(c.method, c.path, c.body) : { status: 0, ok: false, j: { error: 'blocked path' } }));
    GM_setValue('agRpcRes', { id: v.id, results });
  });
  // Heartbeat that survives Chrome's background-tab throttling (worker timer) and freezing (Web Lock).
  const beat = () => GM_setValue('agRelayAt', Date.now());
  beat();
  setInterval(beat, 5000);
  try {
    const wk = new Worker(URL.createObjectURL(new Blob(['setInterval(()=>postMessage(0),5000)'], { type: 'text/javascript' })));
    wk.onmessage = () => { if (document.hidden) beat(); };
  } catch (_) {}
  try { if (navigator.locks) navigator.locks.request('ag-trade-keepalive', () => new Promise(() => {})); } catch (_) {}
  GM_addValueChangeListener('twPing', (_k, _o, _v, remote) => { if (remote) beat(); });

  // Token selected in the backtester: #token/<mint> in the URL, else the active Live Terminal card.
  const cardRow = (el) => {
    const fk = Object.keys(el).find((k) => k.startsWith('__reactFiber'));
    let f = fk && el[fk];
    for (let i = 0; i < 4 && f; i++, f = f.return) { const p = f.memoizedProps; if (p && p.s && p.s.tokenAddress) return p; }
    return null;
  };
  let lastCardEl = null;
  function activeCard() {
    // fast path: the card that was active last time is usually still the active one
    if (lastCardEl && lastCardEl.isConnected) { const p = cardRow(lastCardEl); if (p && p.active) return p.s; }
    for (const el of document.querySelectorAll('div[role="button"].shrink-0.rounded-lg.cursor-pointer')) {
      const p = cardRow(el);
      if (p && p.active) { lastCardEl = el; return p.s; }
    }
    return null;
  }
  let lastRow = null;
  const agMint = () => {
    const h = location.hash.match(/#token\/([1-9A-HJ-NP-Za-km-z]{32,44})/);
    if (h) return h[1];
    const r = activeCard();
    if (r) lastRow = r;
    return lastRow ? lastRow.tokenAddress : null;
  };
  const agSymbol = (m) => (lastRow && lastRow.tokenAddress === m && (lastRow.symbol || lastRow.token)) ||
    (document.title.match(/^\$?([A-Za-z0-9]{1,15})\s/) || [])[1] || '';
  tradeWidget('ag', agMint, agSymbol, agLocalCall);

  function agPathAllowed(method, path) {
    return /^(GET|POST)$/.test(method) &&
      /^\/api\/(tokens\/[1-9A-HJ-NP-Za-km-z]{32,44}\/(buy|sell|profile|my-trades|annotations|tpsl|creator-holdings)|performance\/(wallets-list|holdings|positions|wallets\/tx-settings-all))(\?[\w=&.-]*)?$/.test(path);
  }

  function tradeWidget(env, getMint, getSymbol, localCall) {
    const AG = 'https://backtester.alphagardeners.xyz';
    const DEF_PRESET = () => ({ buy: [0.01, 0.1, 0.5, 1, 0.25, 2, 5, 10], sell: [10, 25, 50, 100, 5, 15, 33, 75], sup: [0.1, 0.25, 0.5, 1, 1.5, 2, 3, 5], usd: [5, 10, 25, 50, 100, 250, 500, 1000], sellSol: [0.05, 0.1, 0.25, 0.5, 1, 2, 0, 0], slippage: 60, fee: 0.001, mev: 'JITO' });
    const st = Object.assign({ mode: 'paper', preset: 0, wallets: { live: [] }, confirmAbove: 2, presets: [DEF_PRESET(), DEF_PRESET(), DEF_PRESET()],
      migPct: 100, protect: { arm: 70, floor: 15, pct: 100 }, qb: 0.1, cards: true,
      // multi-wallet (GMGN / Axiom style)
      groups: [],        // [{id, name, mode, wallets:[addr]}]
      buyMode: 'each',   // 'each' = amount per wallet · 'split' = amount is the total, divided across wallets
      jitter: 0,         // ±% random variation per wallet (sums stay exact in split mode)
      stagger: 0,        // ms between wallets (randomised 0.5–1.5×), 0 = all at once
      reserve: 0.01,     // SOL kept in each wallet for fees / rent (buys + planner)
      buyUnit: 'sol',    // buy buttons: 'sol' amounts · 'usd' amounts · 'pct' = % of the token supply
      sellUnit: 'pct',   // sell buttons: 'pct' of the bag · 'sol' = a SOL value
      variance: 15,      // token split planner: ±% per wallet
      adv: true,         // show the exit-strategy / auto-exits block
      safety: { maxPerCoin: 0, dailyLoss: 0, impactWarn: 10, dupSec: 3 },
      strats: [
        { id: 'runner', name: 'Runner', levels: [{ t: 'TP', p: 100, a: 50 }, { t: 'TP', p: 300, a: 25 }, { t: 'TP', p: 900, a: 25 }, { t: 'SL', p: 35, a: 100 }], be: true, trail: 0 },
        { id: 'scalp', name: 'Scalp', levels: [{ t: 'TP', p: 50, a: 100 }, { t: 'SL', p: 20, a: 100 }], be: false, trail: 0 },
      ],
      stratId: null,     // exit strategy attached to buys (null = none)
      hotkeys: 'hover',  // 'on' | 'hover' (only while the pointer is over the widget) | 'off'
      kbHints: true,
      alerts: {},
      scale: 1,          // widget size (drag the corner grip; double-click resets)
      autoFit: true,     // shrink to fit the screen height when needed
    }, GM_getValue('tw', {}));
    st.wallets = Object.assign({ live: [], paper: [] }, st.wallets || {});
    st.protect = Object.assign({ arm: 70, floor: 15, pct: 100 }, st.protect || {});
    if (!Array.isArray(st.groups)) st.groups = [];
    if (!Array.isArray(st.strats)) st.strats = [];
    st.safety = Object.assign({ maxPerCoin: 0, dailyLoss: 0, impactWarn: 10, dupSec: 3 }, st.safety || {});
    { const A = st.alerts || {};
      st.alerts = { dev: Object.assign({ on: true, pct: 1, auto: false }, A.dev), whale: Object.assign({ on: true, sol: 5 }, A.whale), move: Object.assign({ on: false, pct: 30 }, A.move),
        fills: A.fills !== false, sound: A.sound !== false, desktop: !!A.desktop }; }
    const pos0 = GM_getValue('twPos_' + env, {});
    const ui = { collapsed: !!pos0.collapsed, panel: null, busy: '', edit: false, draft: {}, plan: null, filt: { sol: false, tok: false }, modal: null, stratEdit: null, posSort: 'pnl', shareHide: false,
      alertsSeen: {}, alertsGone: {}, tf: { tab: 'dip', target: '', amount: '0.5', pct: '50', trail: '25', total: '1', slices: '5', every: '30', expiry: '60', attach: true } };
    const save = () => GM_setValue('tw', st);
    const savePos = () => GM_setValue('twPos_' + env, { x: el.offsetLeft, y: el.offsetTop, collapsed: ui.collapsed });
    const id = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
    const escH = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const tail = (a) => (a ? a.slice(0, 4) + '…' + a.slice(-4) : '');
    const sol = (v) => (v == null || isNaN(v) ? '--' : (Math.abs(v) >= 100 ? v.toFixed(1) : Math.abs(v) >= 1 ? v.toFixed(2) : v.toFixed(3)));
    const P = () => { const p = st.presets[st.preset] || (st.presets[st.preset] = DEF_PRESET()); const d = DEF_PRESET(); for (const k of ['buy', 'sell', 'sup', 'usd', 'sellSol']) if (!Array.isArray(p[k])) p[k] = d[k]; return p; };
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const labelOf = (w) => (wallets.find((x) => x.address === w) || {}).label || tail(w);
    const balOf = (w) => num((wallets.find((x) => x.address === w) || {}).balanceSol);
    const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));

    // ---------------------------------------------------------- transport
    function direct(c) {
      return new Promise((res) => GM_xmlhttpRequest({
        method: c.method, url: AG + c.path, timeout: 20000,
        headers: c.body ? { 'Content-Type': 'application/json' } : {}, data: c.body ? JSON.stringify(c.body) : undefined,
        onload: (r) => { let j = null; try { j = JSON.parse(r.responseText); } catch (_) {} res({ status: r.status, ok: r.status >= 200 && r.status < 300, j: j || {} }); },
        onerror: () => res({ status: 0, ok: false, j: { error: 'network error' } }),
        ontimeout: () => res({ status: 0, ok: false, j: { error: 'timeout' } }),
      }));
    }
    const pending = new Map();
    if (env !== 'ag') GM_addValueChangeListener('agRpcRes', (_k, _o, v) => { const f = v && pending.get(v.id); if (f) { pending.delete(v.id); f(v.results); } });
    function relay(calls) {
      return new Promise((res) => {
        const rid = id();
        pending.set(rid, res);
        GM_setValue('agRpc', { id: rid, at: Date.now(), calls });
        setTimeout(() => { if (pending.has(rid)) { pending.delete(rid); res(null); } }, 20000);
      });
    }
    // isOrder: never re-send an order through a second path after a relay timeout (avoid double buys)
    async function call(calls, isOrder) {
      if (env === 'ag') return Promise.all(calls.map((c) => localCall(c.method, c.path, c.body)));
      let alive = Date.now() - (GM_getValue('agRelayAt', 0) || 0) < 30000;
      if (!alive) { // nudge a throttled backtester tab, then re-check
        GM_setValue('twPing', Date.now());
        await new Promise((r) => setTimeout(r, 1500));
        alive = Date.now() - (GM_getValue('agRelayAt', 0) || 0) < 30000;
      }
      if (alive) {
        const r = await relay(calls);
        if (r) return r;
        if (isOrder) return calls.map(() => ({ status: 0, ok: false, j: { error: 'no answer from the backtester tab – check Positions before retrying' } }));
      }
      return Promise.all(calls.map(direct));
    }

    // ---------------------------------------------------------- data
    let wallets = [], walletErr = '', pos = null, lastMint = null, sym = '', usdRate = null, autoPending = false;
    let trades = null; // AG's per-token P&L summary {cost, proceeds}: survives a full sell (like AG's own token header)
    // Live wallet selection used for orders: the wallets holding the current token (auto, per token),
    // otherwise your saved default selection.
    const buySel = () => st.wallets[st.mode] || [];           // wallets you BUY with (groups / picker)
    const selected = () => ui.autoSel || buySel();               // wallets you SELL from: the holders of the coin (auto) or your selection
    // paper with nothing selected = all paper wallets (sells / auto orders)
    const inSel = (w) => { const s = selected(); return (st.mode === 'paper' && !s.length) || s.includes(w); };
    function setSel(list) { st.wallets[st.mode] = list; save(); }
    async function loadWallets(fresh) {
      if (fresh && env === 'ag') bus.drop('/api/performance/wallets-list');
      const [r] = await call([{ method: 'GET', path: `/api/performance/wallets-list?source=${st.mode}` }]);
      if (r && r.ok && Array.isArray(r.j.wallets)) {
        wallets = r.j.wallets; walletErr = '';
        if (num(r.j.solPrice) > 0) usdRate = num(r.j.solPrice); // AG's own SOL/USD
        const valid = (st.wallets[st.mode] || []).filter((a) => wallets.some((w) => w.address === a));
        const main = wallets.find((w) => w.isMain) || wallets[0];
        st.wallets[st.mode] = valid.length || st.mode === 'paper' ? valid : main && main.address ? [main.address] : [];
        save();
      } else { wallets = []; walletErr = (r && r.j && r.j.error) || (r ? 'HTTP ' + r.status : 'no response'); }
      render();
    }
    let posBusy = null;
    function loadPos() { return posBusy || (posBusy = loadPos0().finally(() => { posBusy = null; })); } // never overlap
    async function loadPos0() {
      const mint = getMint();
      if (!mint) { pos = null; return render(); }
      const [r, t] = await call([
        { method: 'GET', path: `/api/performance/holdings?source=${st.mode}` },
        { method: 'GET', path: `/api/tokens/${mint}/my-trades${st.mode === 'paper' ? '?source=paper' : ''}` },
      ]);
      if (mint !== getMint()) return;
      const pnl = t && t.ok && t.j ? t.j.pnl : null;
      const c = pnl ? num(pnl.costSol) : null, pr = pnl ? num(pnl.proceedsSol) : null;
      trades = c > 0 ? { cost: c, proceeds: pr || 0 } : null;
      pos = {};
      if (r && r.ok && r.j.byWallet) for (const [w, x] of Object.entries(r.j.byWallet)) for (const h of x.holdings || []) {
        const ws = num(h.worthSol), wu = num(h.worthUsd);
        if (ws > 0 && wu > 0) usdRate = wu / ws; // SOL→USD from AG's own valuation
        if (h.tokenAddress === mint) pos[w] = h;
      }
      posRef = { mint, mcap: mcapNow(mint), at: Date.now() }; livePosCache = {};
      if (autoPending) {
        autoPending = false;
        const holders = Object.keys(pos).filter((w) => !wallets.length || wallets.some((x) => x.address === w));
        ui.autoSel = holders.length ? holders : null;
      }
      render();
    }
    const num = (...v) => { for (const x of v) if (x != null && x !== '' && !isNaN(Number(x))) return Number(x); return null; };
    // AG holding rows carry {worthSol, worthUsd, pnlSol, pnlUsd, pnlPct, avgEntryMcap}: no explicit cost,
    // so the cost of the bag a wallet still holds = worthSol − pnlSol.
    const bagCost = (h) => { const w = num(h.worthSol), p = num(h.pnlSol); return w != null && p != null ? w - p : null; };
    const costOf = (h) => num(h.costSol, h.boughtSol) ?? bagCost(h);
    const soldOf = (h) => num(h.proceedsSol, h.soldSol);
    // Sell initials for one wallet: sell the SOL value that its current bag cost (= take the entry out, ride the rest free).
    function initPlan(h) {
      const worth = num(h.worthSol), cost = bagCost(h);
      if (cost == null || !(worth > 0)) return { skip: 'no price data yet' };
      if (!(cost > 0)) return { skip: 'initials already out' };
      if (worth <= cost) return { skip: `not in profit (${(num(h.pnlPct) || 0).toFixed(1)}%)` };
      return { pct: Math.min(100, Math.ceil((cost / worth) * 1000) / 10), need: cost };
    }
    const heldBy = () => Object.entries(livePos() || {}).filter(([w]) => inSel(w));
    function summary() {
      if (!pos) return null;
      const ws = heldBy();
      // Bought / Sold / PnL: token totals from AG's my-trades (all wallets in this mode), so they stay after selling.
      const fromTrades = () => {
        if (!trades) return null;
        const bag = Object.values(livePos()).reduce((a, h) => a + (num(h.worthSol) || 0), 0);
        const ps = trades.proceeds - trades.cost + bag;
        return { bought: trades.cost, sold: trades.proceeds, pnlSol: ps, pnl: (ps / trades.cost) * 100 };
      };
      if (!ws.length) return Object.assign({ bal: 0, balUsd: 0, bought: null, sold: null, pnl: null, pnlSol: null }, fromTrades() || {});
      let bal = 0, balUsd = 0, bought = 0, sold = 0, hasB = false, hasS = false, pnlW = 0, pnlBase = 0, pnlSol = 0, hasP = false;
      for (const [, h] of ws) {
        const worth = num(h.worthSol) || 0, b = costOf(h), sd = soldOf(h);
        bal += worth; balUsd += num(h.worthUsd) ?? (usdRate ? worth * usdRate : 0);
        if (b != null) { bought += b; hasB = true; }
        if (sd != null) { sold += sd; hasS = true; }
        if (h.pnlPct != null) { const wgt = b || worth || 1; pnlW += h.pnlPct * wgt; pnlBase += wgt; }
        const ps = num(h.pnlSol);
        if (ps != null) { pnlSol += ps; hasP = true; }
      }
      return Object.assign({ bal, balUsd, bought: hasB ? bought : null, sold: hasS ? sold : null, pnl: pnlBase ? pnlW / pnlBase : null, pnlSol: hasP ? pnlSol : null }, fromTrades() || {});
    }
    const usd = (solV) => (solV == null || !usdRate ? '' : '$' + (Math.abs(solV * usdRate) >= 1000 ? (solV * usdRate / 1000).toFixed(1) + 'K' : (solV * usdRate).toFixed(solV * usdRate >= 100 ? 0 : 2)));

    // ---------------------------------------------------------- buy by % of supply (GMGN / Axiom style)
    // Market cap comes from the page (GMGN tab title "$6.97K", or the active AG Live Terminal card) and is
    // converted with AG's SOL/USD. Pump.fun coins still on the bonding curve are priced on the curve itself
    // (virtual reserves 30 SOL × 1.073B tokens, constant product, ~1.25% fee), so big % buys include their
    // own price impact. Migrated / other coins: mcap × % (no pool depth known → real cost is a bit higher).
    const PUMP_K = 30 * 1.073e9, SUPPLY = 1e9, CURVE_END_MCAP_SOL = 400, PUMP_FEE = 1.0125;
    const parseUsd = (t) => { const m = String(t || '').match(/\$\s?([\d.,]+)\s?([KMB])?/i); if (!m) return null; const v = parseFloat(m[1].replace(/,/g, '')); return v * ({ K: 1e3, M: 1e6, B: 1e9 }[(m[2] || '').toUpperCase()] || 1); };
    function mcapUsd(mint) {
      if (env === 'ag' && lastRow && lastRow.tokenAddress === mint) { const v = num(lastRow.currentMcap, lastRow.mcap, lastRow.signalMcap); if (v > 0) return v; }
      return env === 'ag' ? null : parseUsd(document.title);
    }
    function supplyCost(pct, mint) {
      const mu = mcapNow(mint);
      if (!(mu > 0) || !(usdRate > 0) || !(pct > 0)) return null;
      const mSol = mu / usdRate, dy = (pct / 100) * SUPPLY, p = mSol / SUPPLY;
      if (/pump$/i.test(mint) && mSol < CURVE_END_MCAP_SOL) {
        const x = Math.sqrt(PUMP_K * p), y = Math.sqrt(PUMP_K / p);
        if (dy < y * 0.98) return { sol: ((x * dy) / (y - dy)) * PUMP_FEE, curve: true, mSol, mu };
      }
      return { sol: (mSol * pct) / 100, curve: false, mSol, mu };
    }
    // % mode: "each" → every wallet gets pct% (priced as one combined buy, then divided); "split" → pct% in total.
    function pctWallets() { return st.mode === 'live' ? Math.max(1, buySel().length) : 1; }
    function pctToSol(pct, mint) {
      const n = pctWallets(), each = st.buyMode !== 'split' && n > 1;
      const c = supplyCost(each ? pct * n : pct, mint);
      if (!c) return null;
      return Object.assign(c, { amount: +(each ? c.sol / n : c.sol).toFixed(4), totalPct: each ? pct * n : pct });
    }
    function buyPct(pct) {
      const mint = getMint();
      pct = Number(pct);
      if (!mint) return toast('Open a token first', true);
      if (!(pct > 0)) return;
      if (pct > 20) return toast('% of supply is capped at 20% per click', true);
      const c = pctToSol(pct, mint);
      if (!c) return toast(usdRate ? 'No market cap for this token yet (GMGN title / AG card) – use SOL mode' : 'No SOL price yet – open the wallet list once', true);
      buy(c.amount, null, null, `${c.totalPct}% of supply ≈ ${sol(c.amount * (st.buyMode !== 'split' ? pctWallets() : 1))} SOL @ $${(c.mu / 1000).toFixed(1)}K mcap${c.curve ? ' (bonding curve)' : ' (no pool depth: real cost a bit higher)'}`);
    }

    // ---------------------------------------------------------- live price stream (websocket-style)
    // Ticks (market cap in USD per mint) come from:
    //  • GMGN tab  – GMGN's own websocket, which rewrites the tab title on every price change ("PUMPKART ↑ $76.62K")
    //  • AG tab    – AG's Socket.IO feed (the same one its chart uses): subscribe:token → swap:new / candle:update
    // Both tabs share ticks through Tampermonkey storage. Between AG holdings polls the PnL is re-priced on every tick:
    // value now = value at the last AG snapshot × (mcap now / mcap at that snapshot). AG stays the source of truth (5s sync).
    const DEBUG = (() => { try { return localStorage.getItem('agtwDebug') === '1'; } catch (_) { return false; } })();
    const ticks = {};                 // mint → { mcap, at, src, dir }
    const stream = { ok: false };     // AG socket connected (AG tab) / last remote tick seen (GMGN tab)
    let posRef = null, livePosCache = {}, lastPub = 0, lastFast = 0;
    function mcapNow(mint) { const t = mint && ticks[mint]; return t && Date.now() - t.at < 30000 ? t.mcap : mcapUsd(mint); }
    const isLive = (mint) => { const t = mint && ticks[mint]; return !!t && Date.now() - t.at < 6000; };
    function putTick(mint, mcap, src, publish) {
      if (!mint || !(mcap >= 1000)) return;
      const t = ticks[mint];
      if (t && Math.abs(Math.log(mcap / t.mcap)) > Math.log(20) && Date.now() - t.at < 60000) return; // glitch guard
      ticks[mint] = { mcap, at: Date.now(), src, dir: t ? (mcap > t.mcap ? 1 : mcap < t.mcap ? -1 : t.dir) : 0 };
      if (posRef && posRef.mint === mint && !(posRef.mcap > 0)) posRef.mcap = mcap; // first price seen after a snapshot = its anchor
      checkMove(mint, mcap);
      if (publish && Date.now() - lastPub > 250) { lastPub = Date.now(); GM_setValue('twTick', { mint, mcap, at: Date.now(), src }); }
      if (mint === getMint()) render();
      // auto orders: re-check Protect right away instead of waiting for the 2.5s poll (decisions still use AG's numbers)
      if (env === 'ag' && Date.now() - lastFast > 1000 && loadOrders().some((o) => o.status === 'active' && o.mint === mint && o.type === 'protect')) { lastFast = Date.now(); watch(); }
    }
    // AG positions re-priced with the live mcap (display only)
    function livePos() {
      const m = getMint();
      if (!pos || !posRef || posRef.mint !== m || !(posRef.mcap > 0)) return pos;
      const now = mcapNow(m), f = now / posRef.mcap;
      if (!(f > 0.05 && f < 20) || f === 1) return pos;
      if (livePosCache.f === f && livePosCache.src === pos) return livePosCache.v;
      const out = {};
      for (const [w, h] of Object.entries(pos)) {
        const ws = num(h.worthSol), ps = num(h.pnlSol);
        if (ws == null) { out[w] = h; continue; }
        const nw = ws * f, cost = ps != null ? ws - ps : null;
        out[w] = Object.assign({}, h, { worthSol: nw, worthUsd: num(h.worthUsd) != null ? num(h.worthUsd) * f : h.worthUsd,
          pnlSol: ps != null ? ps + nw - ws : ps, pnlPct: cost > 0 ? (nw / cost - 1) * 100 : h.pnlPct });
      }
      livePosCache = { f, src: pos, v: out };
      return out;
    }
    // AG payloads: the unit of each numeric field (USD mcap, SOL mcap, USD/SOL price) is calibrated once against a
    // known mcap (GMGN title / AG card), then reused for that event+field.
    const unitPick = {};
    function pickMcap(ev, d, mint) {
      const c = d.candle || {};
      const cands = [['mcap', num(d.mcapUsd, d.marketCapUsd, d.mcap, d.marketCap, d.currentMcap)], ['cmcap', num(c.mcapUsd, c.mcap, c.marketCap)],
        ['close', num(c.c, c.close)], ['price', num(d.priceUsd, d.price, d.priceSol, d.tokenPrice)]];
      const ref = mcapNow(mint) || (loadOrders().find((o) => o.mint === mint && o.refMcap) || {}).refMcap || (heldAll[mint] && heldAll[mint].entry);
      for (const [f, v] of cands) {
        if (!(v > 0)) continue;
        const k = ev + ':' + f;
        let mul = unitPick[k];
        if (mul == null) {
          if (!(ref > 0)) continue; // wait for a reference before trusting an unknown unit
          let best = null, bd = Infinity;
          for (const m of [1, usdRate || 0, SUPPLY, SUPPLY * (usdRate || 0)]) if (m > 0) { const dd = Math.abs(Math.log((v * m) / ref)); if (dd < bd) { bd = dd; best = m; } }
          if (bd > Math.log(3)) continue;
          mul = unitPick[k] = best;
          if (DEBUG) console.log('[AG widget] unit for', k, '=', best);
        }
        return v * mul;
      }
      return null;
    }
    function startStream() {
      // shared ticks from the other tab
      GM_addValueChangeListener('twTick', (_k, _o, v, remote) => { if (remote && v && v.mint) { stream.at = Date.now(); putTick(v.mint, v.mcap, v.src, false); } });
      GM_addValueChangeListener('twPosPing', (_k, _o, _v, remote) => { if (remote) { loadPos(); if (env !== 'ag') loadHeld(); } });
      if (env !== 'ag') {
        const rd = () => { const m = getMint(), v = parseUsd(document.title); if (m && v) putTick(m, v, 'gmgn', true); };
        new MutationObserver(rd).observe(document.head, { childList: true, subtree: true, characterData: true });
        rd();
        // ask the backtester tab to subscribe this token on AG's feed too (backup source, and for the order watcher)
        setInterval(() => { const m = getMint(); if (m && !document.hidden) GM_setValue('twWant', { mint: m, at: Date.now() }); }, 15000);
        return;
      }
      const IO = typeof io === 'function' ? io : (typeof W.io === 'function' ? W.io : null);
      if (!IO) { console.warn('[AG widget] socket.io client not loaded – live stream off, polling only'); return; }
      let sock;
      try { sock = IO(location.origin, { withCredentials: true, transports: ['websocket', 'polling'] }); } catch (e) { console.warn('[AG widget] socket failed', e); return; }
      const subs = new Set();
      const want = () => {
        const s = new Set(), m = getMint(), r = GM_getValue('twWant', null);
        if (m) s.add(m);
        if (r && r.mint && Date.now() - r.at < 60000) s.add(r.mint);
        for (const o of loadOrders()) if (o.status === 'active') s.add(o.mint);
        for (const k of Object.keys(heldAll).slice(0, 10)) s.add(k); // whale alerts + live PnL on your positions
        return s;
      };
      const sync = () => {
        if (!sock.connected) return;
        const w = want();
        for (const m of w) if (!subs.has(m)) { sock.emit('subscribe:token', m); subs.add(m); }
        for (const m of [...subs]) if (!w.has(m)) { sock.emit('unsubscribe:token', m); subs.delete(m); }
      };
      sock.on('connect', () => { stream.ok = true; subs.clear(); sync(); render(); });
      sock.on('disconnect', () => { stream.ok = false; render(); });
      setInterval(sync, 2000);
      const onData = (ev) => (d) => {
        if (DEBUG) console.log('[AG widget]', ev, d);
        const mint = d && (d.tokenAddress || d.mint);
        if (!mint) return;
        const v = pickMcap(ev, d, mint);
        if (v) putTick(mint, v, 'ag', true);
      };
      sock.on('swap:new', (d) => { onData('swap:new')(d); try { onSwap(d); } catch (_) {} });
      sock.on('performance:order-executed', (d) => { const m = d && (d.tokenAddress || d.mint); bus.drop('/api/'); loadPos(); loadHeld(); if (getMint() === m) loadSrv(true);
        if (st.alerts.fills) notify(`AG executed an exit${m ? ' on ' + ((heldAll[m] || {}).sym || tail(m)) : ''}`, 'TP / SL order filled on AG', 'fill', m); GM_setValue('twPosPing', Date.now()); });
      sock.on('candle:update', onData('candle:update'));
      // fills / closes pushed by AG → refresh positions now instead of on the next poll (both tabs)
      ['performance:position-opened', 'performance:position-updated', 'performance:position-update', 'performance:position-closed'].forEach((ev) => sock.on(ev, () => {
        bus.drop('/api/performance/'); bus.drop('/api/tokens/'); loadPos(); GM_setValue('twPosPing', Date.now());
      }));
    }

    // ---------------------------------------------------------- orders
    function report(side, res, label, quiet) {
      const ok = res.filter((r) => r && r.ok).length, bad = res.filter((r) => !r || !r.ok);
      const errs = [...new Set(bad.map((r) => (r && r.j && (r.j.error || r.j.message)) || (r && r.status === 409 ? 'already in progress' : 'failed')))];
      if (!quiet || !ok) toast(`${side} ${label}: ${ok}/${res.length} submitted${errs.length ? ' · ' + errs.join('; ') : ''}`, !ok);
      setTimeout(loadPos, 2500); setTimeout(loadPos, 8000); setTimeout(loadHeld, 3000);
      return ok;
    }
    // Multi-wallet buy legs (GMGN / Axiom conventions):
    //  each  → every wallet buys `amount`          split → `amount` is the total, divided across wallets
    //  jitter → ±% random size per wallet (split keeps the exact total) so the buys don't look bundled
    //  wallets whose known balance can't cover their leg + the fee reserve are skipped (split re-divides)
    function buyLegs(amount, ws, split, jitterPct) {
      const j = Math.min(0.5, Math.max(0, Number(jitterPct) || 0) / 100);
      const reserve = Math.max(0, Number(st.reserve) || 0);
      let elig = ws.slice();
      for (let pass = 0; pass < 4 && elig.length; pass++) {
        const base = split ? amount / elig.length : amount;
        const next = elig.filter((w) => { const b = balOf(w); return b == null || b >= base * (1 + j) + reserve; });
        if (next.length === elig.length) break;
        elig = next;
      }
      const skipped = ws.filter((w) => !elig.includes(w)).map((w) => `${labelOf(w)} (${sol(balOf(w))}◎)`);
      if (!elig.length) return { legs: [], skipped };
      const base = split ? amount / elig.length : amount;
      let amts = elig.map(() => base * (1 + (Math.random() * 2 - 1) * j));
      if (split && j) { const s = amts.reduce((a, b) => a + b, 0); amts = amts.map((a) => (a * amount) / s); }
      amts = amts.map((a) => Math.max(0.0001, Math.floor(a * 1e4) / 1e4));
      const legs = elig.map((w, i) => ({ w, amt: amts[i] }));
      if (Number(st.stagger) > 0) legs.sort(() => Math.random() - 0.5); // random order when staggering
      return { legs, skipped };
    }
    const scaleLegs = (legs, total) => { const s = legs.reduce((a, x) => a + x.amt, 0); return s > 0 ? legs.map((x) => ({ w: x.w, amt: Math.max(0.0001, Math.floor(((x.amt * total) / s) * 1e4) / 1e4) })) : legs; };

    // ---------------------------------------------------------- safety rails (LIVE)
    const SF = () => Object.assign({ maxPerCoin: 0, dailyLoss: 0, impactWarn: 10, dupSec: 3 }, st.safety || {});
    let daily = null; // { mode, sum (SOL, realized on positions closed today), n, at }
    async function loadDaily() {
      const mode = st.mode;
      const [r] = await call([{ method: 'GET', path: `/api/performance/positions?page=1&limit=100&sortKey=closedAt&sortDir=desc&source=${mode}` }]);
      if (!r || !r.ok || !Array.isArray(r.j.positions)) { daily = { mode, sum: null, n: 0, at: Date.now() }; return; }
      const mid = new Date(); mid.setHours(0, 0, 0, 0);
      let sum = 0, n = 0;
      for (const p of r.j.positions) {
        const t = p.closedAt ? new Date(p.closedAt).getTime() : 0, v = num(p.realizedPnlSol);
        if (p.isClosed !== false && t >= mid.getTime() && v != null) { sum += v; n++; }
      }
      daily = { mode, sum, n, at: Date.now() };
      render();
    }
    // SOL currently in a coin (cost of the open bags, every wallet of the mode)
    function coinCost(mint) {
      if (mint === getMint() && pos) return Object.values(pos).reduce((a, h) => a + Math.max(0, bagCost(h) || 0), 0);
      const h = heldAll[mint];
      return h ? Math.max(0, h.worth - h.pnl) : 0;
    }
    // pump.fun bonding curve: price impact of a buy (final price vs now) and the average fill market cap
    function buyImpact(totalSol, mint) {
      const mu = mcapNow(mint);
      if (!(totalSol > 0) || !(mu > 0) || !(usdRate > 0) || !/pump$/i.test(mint)) return null;
      const mSol = mu / usdRate;
      if (mSol >= CURVE_END_MCAP_SOL) return null;
      const x = Math.sqrt((PUMP_K * mSol) / SUPPLY), y = PUMP_K / x, dx = totalSol / PUMP_FEE, dy = y - PUMP_K / (x + dx);
      return { impact: (((x + dx) / x) ** 2 - 1) * 100, avgMc: dy > 0 ? (dx / dy) * SUPPLY * usdRate : null };
    }
    const lastBuyAt = (mint) => (GM_getValue('twLastBuy', {}) || {})[mint] || 0;
    function markBuy(mint) { const m = GM_getValue('twLastBuy', {}) || {}; m[mint] = Date.now(); for (const k of Object.keys(m)) if (Date.now() - m[k] > 600e3) delete m[k]; GM_setValue('twLastBuy', m); }

    // One buy engine for buttons, hotkeys, cards and trigger orders.
    //  interactive: LIVE confirm / rail warnings go through the in-widget dialog (override possible)
    //  non-interactive (orders): rails are enforced – trimmed to the per-coin room or skipped
    async function execBuy({ mint, symb, wallets: ws, amount, split, mode, note, interactive, strat, jitter }) {
      mode = mode || st.mode;
      const live = mode === 'live', S = SF();
      if (live && !ws.length) { if (interactive) toast('Pick at least one wallet to buy with', true); return { ok: 0, err: 'no wallet' }; }
      let { legs, skipped } = live ? buyLegs(amount, ws, split, jitter) : { legs: [{ w: null, amt: amount }], skipped: [] };
      if (!legs.length) { const m = `no selected wallet can cover it (+${st.reserve} SOL reserve) · ${skipped.join(', ')}`; if (interactive) toast('Buy: ' + m, true); return { ok: 0, err: m }; }
      let total = +legs.reduce((a, x) => a + x.amt, 0).toFixed(6);
      const name = symb || (mint === getMint() ? sym : '') || tail(mint);
      // rails
      const warn = [];
      let room = null, locked = false, dup = false;
      if (live) {
        if (S.maxPerCoin > 0) { room = +(S.maxPerCoin - coinCost(mint)).toFixed(4); if (total > room + 1e-9) warn.push(room > 0.001 ? `Over your ${S.maxPerCoin} ◎ per-coin cap: ${sol(coinCost(mint))} ◎ already in, only ${sol(room)} ◎ fits.` : `Your ${S.maxPerCoin} ◎ per-coin cap is used up (${sol(coinCost(mint))} ◎ in).`); }
        if (S.dailyLoss > 0 && daily && daily.mode === mode && daily.sum != null && daily.sum <= -S.dailyLoss) { locked = true; warn.push(`Daily loss limit hit: ${sol(daily.sum)} ◎ closed today (limit −${S.dailyLoss} ◎). Buys are locked until midnight.`); }
        if (S.dupSec > 0 && Date.now() - lastBuyAt(mint) < S.dupSec * 1000) { dup = true; warn.push(`You bought ${name} ${((Date.now() - lastBuyAt(mint)) / 1000).toFixed(1)}s ago.`); }
      }
      const imp = buyImpact(total, mint);
      const impHot = live && imp && imp.impact >= S.impactWarn;
      if (!interactive) {
        if (locked) return { ok: 0, err: 'daily loss limit hit' };
        if (dup) return { ok: 0, err: 'bought this coin moments ago' };
        if (room != null && total > room + 1e-9) { if (room <= 0.001) return { ok: 0, err: 'per-coin cap reached' }; legs = scaleLegs(legs, room); total = +legs.reduce((a, x) => a + x.amt, 0).toFixed(6); }
      } else if (live && (total > Number(st.confirmAbove || 0) || warn.length || impHot)) {
        const acts = [{ label: 'Cancel', v: null, kind: 'ghost' }];
        if (room != null && room > 0.001 && total > room && !locked) acts.push({ label: `Buy ${sol(room)} ◎`, v: 'room', kind: 'ok' });
        acts.push(warn.length || impHot ? { label: impHot && !warn.length ? `Buy anyway · ${sol(total)} ◎` : 'Override', v: 'go', kind: 'danger' } : { label: `Buy ${sol(total)} ◎`, v: 'go', kind: 'pri' });
        const v = await ask({
          tone: warn.length || impHot ? 'warn' : 'live', title: impHot && !warn.length ? 'High price impact' : 'Confirm LIVE buy',
          sub: `${name} · ${note || sol(amount) + ' ◎'}${legs.length > 1 ? ` · ${split ? 'split' : 'each'} ${legs.length}` : ''}`,
          stats: [{ k: 'Cost', v: `${sol(total)} ◎` }, imp ? { k: 'Price impact', v: `+${imp.impact.toFixed(1)}%`, bad: imp.impact >= S.impactWarn } : { k: 'Wallets', v: String(legs.length) },
            imp && imp.avgMc ? { k: 'Avg fill mcap', v: '$' + kfmt(imp.avgMc) } : { k: 'USD', v: usdS(total) || '--' }],
          lines: legs.length > 1 ? legs.map((x) => `${labelOf(x.w)} · ${sol(x.amt)} ◎`) : [],
          warn: warn.concat(skipped.length ? [`Skipped (low balance): ${skipped.join(', ')}`] : []),
          note: strat ? `Exit strategy “${strat.name}” is attached when the buy fills.` : '',
          actions: acts,
        });
        if (!v) return { ok: 0, err: 'cancelled' };
        if (v === 'room') { legs = scaleLegs(legs, room); total = +legs.reduce((a, x) => a + x.amt, 0).toFixed(6); }
      }
      if (interactive) { ui.busy = 'buy'; render(); }
      const mk = (x) => ({ method: 'POST', path: `/api/tokens/${mint}/buy`, body: { amount: x.amt, source: mode, idempotencyKey: id(), ...(x.w ? { walletAddress: x.w } : {}) } });
      let res;
      if (Number(st.stagger) > 0 && legs.length > 1) {
        res = [];
        for (let i = 0; i < legs.length; i++) {
          if (i) await sleep(Number(st.stagger) * (0.5 + Math.random()));
          if (interactive) { ui.busy = `buy ${i + 1}/${legs.length}`; render(); }
          const [r] = await call([mk(legs[i])], true);
          res.push(r);
        }
      } else res = await call(legs.map(mk), true);
      if (interactive) { ui.busy = ''; render(); }
      const okN = res.filter((r) => r && r.ok).length;
      if (okN) markBuy(mint);
      const lbl = legs.length > 1 ? (split ? `${sol(total)} SOL ÷${legs.length}` : `${sol(legs[0].amt)} SOL ×${legs.length}`) : `${sol(legs[0].amt)} SOL`;
      report('Buy', res, `${note ? note.split(' @')[0] + ' · ' : ''}${lbl}${mint !== getMint() ? ' of ' + name : ''}`);
      if (okN && st.alerts && st.alerts.fills) notify(`Bought ${name}`, `${okN}/${res.length} filled · ${lbl}`, 'fill', mint);
      if (skipped.length && interactive) setTimeout(() => toast('Skipped (low balance): ' + skipped.join(', '), true), 1200);
      if (live) setTimeout(() => loadWallets(true), 8000);
      if (okN && strat) attachExit(mint, mode, legs.filter((x, i) => res[i] && res[i].ok).map((x) => x.w), strat, name);
      return { ok: okN, total };
    }
    const buyStrat = () => (st.adv && st.stratId ? st.strats.find((s) => s.id === st.stratId) || null : null);
    async function buy(amount, mintArg, symArg, note) {
      const mint = mintArg || getMint();
      amount = Number(amount);
      if (!mint) return toast('Open a token first', true);
      if (!(amount > 0) || ui.busy) return;
      return execBuy({ mint, symb: symArg, wallets: st.mode === 'live' ? buySel().slice() : [null], amount, split: st.buyMode === 'split', note, interactive: true, strat: buyStrat(), jitter: st.jitter });
    }
    // Sells: `wallets` = addresses to sell from (every holder of the coin when null)
    async function execSell({ mint, symb, pct, wallets: only, mode, interactive, label }) {
      mode = mode || st.mode;
      pct = Math.min(100, Number(pct));
      if (!(pct > 0)) return { ok: 0 };
      let ws;
      if (mint === getMint()) { await loadPos(); ws = Object.keys(pos || {}); }
      else { await loadHeld(); ws = Object.keys((heldAll[mint] || {}).wallets || {}); }
      if (only) ws = ws.filter((w) => only.includes(w));
      if (!ws.length) { if (interactive) toast('No position in the selected wallet(s)', true); return { ok: 0, err: 'no position' }; }
      if (interactive) { ui.busy = 'sell'; render(); }
      const res = await call(ws.map((w) => ({ method: 'POST', path: `/api/tokens/${mint}/sell`, body: { percent: pct, source: mode, idempotencyKey: id(), walletAddress: w } })), true);
      if (interactive) { ui.busy = ''; render(); }
      const okN = report('Sell', res, `${label || pct + '%'}${ws.length > 1 ? ' ×' + ws.length : ''}${mint !== getMint() ? ' of ' + (symb || tail(mint)) : ''}`);
      if (okN && st.alerts && st.alerts.fills) notify(`Sold ${symb || (mint === getMint() ? sym : '') || tail(mint)}`, `${label || pct + '%'} on ${okN}/${res.length} wallet(s)`, 'fill', mint);
      return { ok: okN };
    }
    async function sell(pct) {
      const mint = getMint();
      if (!mint) return toast('Open a token first', true);
      if (!(Number(pct) > 0) || ui.busy) return;
      return execSell({ mint, pct, wallets: st.mode === 'paper' && !selected().length ? null : selected(), interactive: true });
    }
    // Sell initials: per wallet, sell just enough to take out what you put in (cost − already sold).
    async function sellInit(mintArg) {
      const mint = mintArg || getMint();
      if (!mint) return toast('Open a token first', true);
      if (ui.busy) return;
      let entries;
      if (mint === getMint()) { await loadPos(); entries = heldBy(); }
      else { await loadHeld(); entries = Object.entries((heldAll[mint] || {}).wallets || {}); }
      const plan = [], skipped = [];
      for (const [w, h] of entries) {
        const ip = initPlan(h);
        if (ip.skip) { skipped.push(`${labelOf(w)}: ${ip.skip}`); continue; }
        plan.push({ w, pct: ip.pct, need: ip.need });
      }
      const name = mint === getMint() ? sym : (heldAll[mint] || {}).sym || tail(mint);
      if (!plan.length) return toast('Sell initials: nothing to sell · ' + (skipped.join(' · ') || 'no position in the selected wallet(s)'), true);
      if (st.mode === 'live') {
        const v = await ask({ tone: 'live', title: 'Sell initials', sub: `${name} · take your entry out, ride the rest`,
          lines: plan.map((x) => `${labelOf(x.w)} · sell ${x.pct}% ≈ ${sol(x.need)} ◎`), warn: skipped.length ? ['Skipped: ' + skipped.join('; ')] : [],
          actions: [{ label: 'Cancel', v: null, kind: 'ghost' }, { label: `Sell initials (${plan.length})`, v: 'go', kind: 'pri' }] });
        if (!v) return;
      }
      ui.busy = 'sell init'; render();
      const res = await call(plan.map((x) => ({ method: 'POST', path: `/api/tokens/${mint}/sell`, body: { percent: x.pct, source: st.mode, idempotencyKey: id(), walletAddress: x.w } })), true);
      ui.busy = ''; render();
      report('Sell initials', res, plan.length > 1 ? `×${plan.length}` : `${plan[0].pct}%`);
      if (skipped.length) setTimeout(() => toast('Skipped: ' + skipped.join(' · ')), 1200);
    }

    // ---------------------------------------------------------- exit strategies (AG server-side TP / SL)
    // AG keeps TP/SL levels per bot position (/api/tokens/<mint>/tpsl) and runs them itself, so they keep
    // working with Chrome closed. Levels: {type TAKE_PROFIT|STOP_LOSS, percentage (gain % / loss %), amountPct (% of bag)}.
    // Break-even after TP1 and the trailing stop are browser rules (an 'exitx' order run by the backtester tab).
    const stratLevels = (s) => (s.levels || []).filter((l) => Number(l.p) > 0 && Number(l.a) > 0)
      .map((l) => ({ type: l.t === 'SL' ? 'STOP_LOSS' : 'TAKE_PROFIT', percentage: Math.round(Math.min(l.t === 'SL' ? 99 : 100000, Number(l.p))), amountPct: Math.round(Math.min(100, Number(l.a))) }));
    const openLevels = (p) => (p.levels || []).filter((x) => x.managed !== false && !x.executed && (x.type === 'TAKE_PROFIT' || x.type === 'STOP_LOSS'));
    async function tpslPositions(mint, mode) {
      const [r] = await call([{ method: 'GET', path: `/api/tokens/${mint}/tpsl?source=${mode}` }]);
      return r && r.ok && Array.isArray(r.j.positions) ? r.j.positions.filter((p) => p && !p.isClosed && p.botPositionId != null) : null;
    }
    async function saveLevels(mint, mode, p, levels) {
      const [r] = await call([{ method: 'POST', path: `/api/tokens/${mint}/tpsl`, body: { source: mode, botPositionId: p.botPositionId, levels, expected: { levels: openLevels(p) } } }], true);
      return r;
    }
    // wallets: addresses that just bought (null = paper's single account). Waits for AG to open the positions.
    async function attachExit(mint, mode, wallets, strat, name, quiet) {
      const levels = stratLevels(strat), want = new Set(wallets.map((w) => w || '*'));
      const done = [], fail = [], until = Date.now() + 45000;
      while (want.size && Date.now() < until) {
        await sleep(2500);
        const ps = await tpslPositions(mint, mode);
        if (!ps) continue;
        for (const p of ps) {
          const key = want.has(p.walletAddress) ? p.walletAddress : want.has('*') ? '*' : null;
          if (!key) continue;
          want.delete(key);
          const r = await saveLevels(mint, mode, p, levels);
          (r && r.ok ? done : fail).push(p.walletAddress ? labelOf(p.walletAddress) : 'paper');
        }
      }
      for (const k of want) fail.push(k === '*' ? 'paper' : labelOf(k) + ' (no position yet)');
      if (done.length) {
        const ex = GM_getValue('twExits', {}) || {};
        ex[mode + ':' + mint] = { name: strat.name, at: Date.now() }; GM_setValue('twExits', ex);
        if ((strat.be || Number(strat.trail) > 0)) addExitx(mint, mode, wallets, strat, name);
      }
      if (!quiet || fail.length) toast(`${name}: exit “${strat.name}” ${done.length ? 'set on ' + done.length + ' position' + (done.length > 1 ? 's' : '') : 'not set'}${fail.length ? ' · failed: ' + fail.join(', ') : ''}`, !done.length);
      if (getMint() === mint) loadSrv(true);
      return done.length;
    }
    // apply the chosen strategy to the positions you already hold in this coin
    async function applyExitNow() {
      const mint = getMint(), s = st.strats.find((x) => x.id === st.stratId);
      if (!mint || !s) return toast('Pick a strategy first', true);
      const ws = st.mode === 'live' ? heldBy().map(([w]) => w) : [null];
      if (!ws.length) return toast('No open position to attach it to', true);
      const v = await ask({ tone: 'live', title: `Apply “${s.name}”`, sub: `${sym || tail(mint)} · ${ws.length} position${ws.length > 1 ? 's' : ''} · replaces their current TP / SL on AG`,
        lines: stratLevels(s).map((l) => `${l.type === 'STOP_LOSS' ? 'SL −' : 'TP +'}${l.percentage}% → sell ${l.amountPct}%`),
        actions: [{ label: 'Cancel', v: null, kind: 'ghost' }, { label: 'Apply on AG', v: 'go', kind: 'pri' }] });
      if (!v) return;
      ui.busy = 'exit'; render();
      const until = Date.now(); void until;
      const ps = await tpslPositions(mint, st.mode) || [];
      let ok = 0;
      for (const p of ps) {
        if (st.mode === 'live' && !ws.includes(p.walletAddress)) continue;
        const r = await saveLevels(mint, st.mode, p, stratLevels(s));
        if (r && r.ok) ok++;
      }
      ui.busy = ''; render();
      toast(ok ? `“${s.name}” set on ${ok} position${ok > 1 ? 's' : ''} (runs on AG)` : 'Could not set it: AG has no open position for these wallets yet', !ok);
      if (ok && (s.be || Number(s.trail) > 0)) addExitx(mint, st.mode, ws, s, sym || tail(mint));
      loadSrv(true);
    }
    // what AG currently holds for this coin (shown under Adv.)
    let srv = { mint: null, list: null, at: 0 };
    async function loadSrv(force) {
      const mint = getMint();
      if (!mint || (!force && srv.mint === mint && Date.now() - srv.at < 20000)) return;
      srv = { mint, list: srv.mint === mint ? srv.list : null, at: Date.now() };
      const ps = await tpslPositions(mint, st.mode);
      if (getMint() !== mint) return;
      srv = { mint, list: ps, at: Date.now() };
      render();
    }

    // ---------------------------------------------------------- wallet groups
    // Named wallet sets per mode (Axiom / GMGN "wallet groups"): one click selects the group for buys,
    // sells and new auto orders.
    const groupsHere = () => st.groups.filter((g) => g.mode === st.mode);
    function useGroup(gid) {
      if (gid === '__all' || gid === '__main') {
        const list = gid === '__all' ? wallets.map((w) => w.address).filter(Boolean) : [(wallets.find((w) => w.isMain) || {}).address].filter(Boolean);
        ui.autoSel = null; st.wallets[st.mode] = list; save(); return render();
      }
      const g = st.groups.find((x) => x.id === gid);
      if (!g) return;
      const list = wallets.length ? g.wallets.filter((a) => wallets.some((w) => w.address === a)) : g.wallets.slice();
      if (!list.length) return toast(`Group "${g.name}": none of its wallets exist in ${st.mode} anymore`, true);
      ui.autoSel = null; st.wallets[st.mode] = list; save();
      toast(`Group "${g.name}" · ${list.length} wallet${list.length > 1 ? 's' : ''}${list.length < g.wallets.length ? ` (${g.wallets.length - list.length} missing)` : ''}`);
      render();
    }
    function saveGroup() {
      const ws = selected().slice();
      if (!ws.length) return toast('Select wallets first, then save them as a group', true);
      const name = (prompt(`Name for this ${st.mode} wallet group (${ws.length} wallet${ws.length > 1 ? 's' : ''}):`, `G${groupsHere().length + 1}`) || '').trim().slice(0, 16);
      if (!name) return;
      const ex = st.groups.find((g) => g.mode === st.mode && g.name.toLowerCase() === name.toLowerCase());
      if (ex) { if (!confirm(`Overwrite group "${ex.name}"?`)) return; ex.wallets = ws; }
      else st.groups.push({ id: id(), name, mode: st.mode, wallets: ws });
      save(); render(); toast(`Group "${name}" saved`);
    }
    function delGroup(gid) {
      const g = st.groups.find((x) => x.id === gid);
      if (!g || !confirm(`Delete group "${g.name}"?`)) return;
      st.groups = st.groups.filter((x) => x.id !== gid); save(); render();
    }

    // ---------------------------------------------------------- wallet tools: consolidate / split planner
    // AG keeps the wallet keys server-side and exposes no wallet-to-wallet transfer endpoint (yet), so these PLAN
    // the transfers GMGN / Axiom style, for you to run. Kinds:
    //  tokCons = move all of the current token into one wallet    tokSplit = spread it over the selection (± variance)
    //  solEven = even out SOL across the selection                solCons  = sweep SOL (above the reserve) into one wallet
    const PLAN_INFO = {
      tokCons: (s) => `Move all ${s} to one of the selected wallets`,
      tokSplit: (s) => `Split ${s} between all selected wallets with ${st.variance}% variance`,
      solEven: () => 'Even out SOL between the selected wallets',
      solCons: () => `Sweep SOL into one wallet (keeping ${st.reserve} ◎ in each)`,
    };
    function rng(seed) { let x = (seed % 2147483646) + 1; return () => ((x = (x * 16807) % 2147483647) / 2147483647); }
    function matchFlows(ws, have, want, MIN) { // greedy: biggest donor → biggest receiver
      const don = ws.filter((w) => have[w] - want[w] >= MIN).map((w) => ({ w, x: have[w] - want[w] })).sort((a, b) => b.x - a.x);
      const rec = ws.filter((w) => want[w] - have[w] >= MIN).map((w) => ({ w, x: want[w] - have[w] })).sort((a, b) => b.x - a.x);
      const tx = [];
      let i = 0, k = 0;
      while (i < don.length && k < rec.length) {
        const a = Math.min(don[i].x, rec[k].x);
        if (a >= MIN) tx.push({ from: don[i].w, to: rec[k].w, amt: a });
        don[i].x -= a; rec[k].x -= a;
        if (don[i].x < MIN) i++;
        if (rec[k].x < MIN) k++;
      }
      return tx;
    }
    function buildPlan() {
      const p = ui.plan;
      if (!p) return null;
      if (st.mode !== 'live') return { err: 'Wallet tools are for LIVE wallets.' };
      const sel = selected(), reserve = Math.max(0, Number(st.reserve) || 0);
      if (p.kind.startsWith('tok')) {
        if (!getMint()) return { err: 'Open a token first.' };
        // token amounts are handled as their SOL value (AG holdings rows carry worthSol, not raw amounts)
        const worth = Object.fromEntries(sel.map((w) => [w, pos && pos[w] ? num(pos[w].worthSol) || 0 : 0]));
        const total = sel.reduce((a, w) => a + worth[w], 0);
        if (!(total > 0)) return { err: `No ${sym || 'token'} in the selected wallets.` };
        if (p.kind === 'tokCons') {
          const dest = sel.includes(p.dest) ? p.dest : sel.slice().sort((a, b) => worth[b] - worth[a])[0];
          p.dest = dest;
          return { unit: 'tok', total, dest, tx: sel.filter((w) => w !== dest && worth[w] > 0).map((w) => ({ from: w, to: dest, amt: worth[w] })) };
        }
        if (sel.length < 2) return { err: 'Select at least 2 wallets.' };
        const r = rng(p.seed), v = Math.min(50, Math.max(0, Number(st.variance) || 0)) / 100;
        let wts = sel.map(() => 1 + (r() * 2 - 1) * v);
        const s = wts.reduce((a, b) => a + b, 0);
        wts = wts.map((x) => x / s);
        const want = Object.fromEntries(sel.map((w, i) => [w, total * wts[i]]));
        return { unit: 'tok', total, tx: matchFlows(sel, worth, want, total * 0.002) };
      }
      const ws = sel.filter((w) => balOf(w) != null);
      if (ws.length < 2) return { err: 'Select at least 2 wallets (with known balances).' };
      const bal = Object.fromEntries(ws.map((w) => [w, balOf(w)]));
      const total = ws.reduce((a, w) => a + bal[w], 0);
      if (p.kind === 'solCons') {
        const dest = ws.includes(p.dest) ? p.dest : (ws.find((w) => (wallets.find((x) => x.address === w) || {}).isMain) || ws[0]);
        p.dest = dest;
        return { unit: 'sol', total, dest, tx: ws.filter((w) => w !== dest).map((w) => ({ from: w, to: dest, amt: Math.floor((bal[w] - reserve) * 1e4) / 1e4 })).filter((t) => t.amt >= 0.001) };
      }
      const target = total / ws.length;
      return { unit: 'sol', total, target, tx: matchFlows(ws, bal, Object.fromEntries(ws.map((w) => [w, target])), 0.001).map((t) => Object.assign(t, { amt: Math.floor(t.amt * 1e4) / 1e4 })) };
    }
    function planText(pl) {
      return pl.tx.map((t) => {
        const amt = pl.unit === 'tok'
          ? `${tokEst(t.amt) != null ? '≈' + kfmt(tokEst(t.amt)) + ' ' : ''}${sym || 'token'} (${sol(t.amt)} SOL worth)`
          : `${t.amt} SOL`;
        return `${amt}  ${labelOf(t.from)} (${t.from}) -> ${labelOf(t.to)} (${t.to})`;
      }).join('\n');
    }
    function copy(text, what) {
      (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(() => toast(`Copied ${what}`), () => { prompt('Copy:', text); });
    }

    // ---------------------------------------------------------- auto & trigger orders
    // Saved in this script's storage (shared by the GMGN and backtester tabs) and executed by ONE backtester tab
    // (leader lock), so keep the backtester open for them to fire. Types:
    //  mig / miginit = sell X% / initials when the coin migrates (AG's /annotations → migration.t)
    //  protect       = per wallet: once PnL ≥ +arm%, sell if it falls back to ≤ +floor%
    //  dip           = buy when the live mcap ≤ target            tpmc  = sell X% when the live mcap ≥ target
    //  trail         = sell 100% when the mcap drops X% from its peak since arming
    //  dca           = buy `total` in N slices every S seconds
    //  exitx         = browser part of an exit strategy: stop-loss → break-even after TP1, trailing stop
    const loadOrders = () => GM_getValue('twOrders', []) || [];
    const saveOrders = (list) => GM_setValue('twOrders', list.filter((o) => o.status === 'active' || Date.now() - (o.doneAt || 0) < 6 * 3600e3).slice(-200));
    const mc$ = (v) => '$' + kfmt(v);
    function orderLabel(o) {
      switch (o.type) {
        case 'mig': return `Sell ${o.pct}% @ migration`;
        case 'miginit': return 'Sell initials @ migration';
        case 'protect': return `Protect +${o.arm}%→+${o.floor}% (sell ${o.pct}%)`;
        case 'dip': return `Buy ${sol(o.amount)} ◎${o.split && (o.wallets || []).length > 1 ? ' ÷' + o.wallets.length : ''} at ≤ ${mc$(o.target)}`;
        case 'tpmc': return `Sell ${o.pct}% at ≥ ${mc$(o.target)}`;
        case 'trail': return `Trailing stop −${o.pct}% from peak`;
        case 'dca': return `DCA ${sol(o.total)} ◎ in ${o.slices} × ${o.every}s`;
        case 'exitx': return `Exit extras${o.be ? ' · SL→break-even after TP1' : ''}${o.trail ? ` · trail −${o.trail}%` : ''}`;
        default: return o.type;
      }
    }
    const orderTag = (o) => ({ mig: 'MIG', miginit: 'MIG', protect: 'PROTECT', dip: 'DIP', tpmc: 'TP', trail: 'TRAIL', dca: 'DCA', exitx: 'EXIT' }[o.type] || o.type.toUpperCase());
    function pushOrder(o, silent) {
      const list = loadOrders();
      list.push(o); saveOrders(list);
      if (!silent) toast(`Armed: ${o.sym} · ${orderLabel(o)}${env !== 'ag' && Date.now() - (GM_getValue('agRelayAt', 0) || 0) > 30000 ? ' · open the backtester tab so it can run' : ''}`);
      render();
    }
    function baseOrder(type, mint, extra) {
      return Object.assign({ id: id(), type, mint, sym: (mint === getMint() ? sym : (heldAll[mint] || {}).sym) || tail(mint), mode: st.mode, created: Date.now(), status: 'active', state: {}, log: [] }, extra);
    }
    async function addOrder(type) {
      const mint = getMint();
      if (!mint) return toast('Open a token first', true);
      const live = st.mode === 'live', ws = selected().length ? selected().slice() : null; // null = all (paper only)
      if (live && !ws) return toast('Select at least one wallet', true);
      const o = baseOrder(type, mint, { wallets: ws, pct: type === 'protect' ? Number(st.protect.pct) || 100 : Number(st.migPct) || 100, arm: Number(st.protect.arm), floor: Number(st.protect.floor) });
      if (type === 'protect' && !(o.arm > o.floor)) return toast('Protect: arm % must be above the sell-back %', true);
      if (loadOrders().some((x) => x.status === 'active' && x.mint === mint && x.type === type && x.mode === st.mode)) return toast('That order already exists for this token', true);
      if (live && !(await ask({ tone: 'live', title: 'Arm auto exit', sub: `${o.sym} · ${orderLabel(o)}`, lines: (ws || []).map(labelOf), note: 'Runs from your open backtester tab.',
        actions: [{ label: 'Cancel', v: null, kind: 'ghost' }, { label: 'Arm', v: 'go', kind: 'pri' }] }))) return;
      pushOrder(o);
    }
    function addExitx(mint, mode, wallets, strat, name) {
      const list = loadOrders().filter((x) => !(x.status === 'active' && x.type === 'exitx' && x.mint === mint && x.mode === mode));
      saveOrders(list);
      pushOrder(baseOrder('exitx', mint, { sym: name || tail(mint), mode, wallets: wallets.filter(Boolean).length ? wallets.filter(Boolean) : null, be: !!strat.be, trail: Number(strat.trail) || 0 }), true);
    }
    // the trigger form (⚡ panel)
    async function addTrigger() {
      const mint = getMint(), f = ui.tf, mc = mcapNow(mint);
      if (!mint) return toast('Open a token first', true);
      const live = st.mode === 'live', bws = live ? buySel().slice() : [null];
      const tgt = parseMc(f.target);
      let o;
      if (f.tab === 'dip') {
        const amount = Number(f.amount);
        if (!(tgt > 0) || !(amount > 0)) return toast('Set a target market cap and an amount', true);
        if (mc && tgt >= mc) return toast(`The target must be below the current mcap (${mc$(mc)})`, true);
        if (live && !bws.length) return toast('Pick wallets to buy with', true);
        const exp = Number(f.expiry) || 0;
        o = baseOrder('dip', mint, { target: tgt, amount, split: st.buyMode === 'split', wallets: live ? bws : null, expires: exp ? Date.now() + exp * 60e3 : 0, stratId: f.attach ? st.stratId : null, refMcap: mc });
      } else if (f.tab === 'tp') {
        const pct = Math.min(100, Number(f.pct) || 0);
        if (!(tgt > 0) || !(pct > 0)) return toast('Set a target market cap and a sell %', true);
        if (mc && tgt <= mc) return toast(`The target must be above the current mcap (${mc$(mc)})`, true);
        o = baseOrder('tpmc', mint, { target: tgt, pct, wallets: live ? selected().slice() : null, refMcap: mc });
      } else if (f.tab === 'trail') {
        const pct = Number(f.trail) || 0;
        if (!(pct > 0 && pct < 95)) return toast('Set a trailing % between 1 and 95', true);
        if (!mc) return toast('No live market cap for this coin yet', true);
        o = baseOrder('trail', mint, { pct, peak: mc, wallets: live ? selected().slice() : null, refMcap: mc });
      } else {
        const total = Number(f.total), slices = Math.round(Number(f.slices) || 0), every = Math.max(5, Number(f.every) || 0);
        if (!(total > 0) || !(slices >= 2)) return toast('Set a total and at least 2 slices', true);
        if (live && !bws.length) return toast('Pick wallets to buy with', true);
        o = baseOrder('dca', mint, { total, slices, every, done: 0, nextAt: Date.now(), split: st.buyMode === 'split', wallets: live ? bws : null, stratId: f.attach ? st.stratId : null, refMcap: mc });
      }
      if (live && !(await ask({ tone: 'live', title: 'Arm trigger', sub: `${o.sym} · ${orderLabel(o)}`,
        lines: (o.wallets || []).map(labelOf), note: 'Runs from your open backtester tab, on the live market cap.',
        actions: [{ label: 'Cancel', v: null, kind: 'ghost' }, { label: 'Arm', v: 'go', kind: 'pri' }] }))) return;
      pushOrder(o);
    }
    function cancelOrder(oid) {
      const list = loadOrders(), o = list.find((x) => x.id === oid);
      if (!o || o.status !== 'active') return;
      o.status = 'cancelled'; o.doneAt = Date.now(); saveOrders(list); render();
    }
    // ---- watcher (backtester tab only)
    const me = id();
    let leaseAt = 0;
    function isLeader() {
      const l = GM_getValue('twLeader', null), now = Date.now();
      if (!l || now - l.at > 8000 || l.id === me) {
        if (now - leaseAt > 3000) { leaseAt = now; GM_setValue('twLeader', { id: me, at: now }); } // lease is 8s: renew every 3s, not every tick
        return true;
      }
      return false;
    }
    const liveMc = (mint) => { const t = ticks[mint]; return t && Date.now() - t.at < 20000 ? t.mcap : null; };
    let watching = false;
    async function watch() {
      if (watching) return;
      const act = loadOrders().filter((o) => o.status === 'active');
      if (!act.length || !isLeader()) return; // no orders → no storage writes, no requests
      watching = true;
      try {
        const now = Date.now(), upd = new Map(), fullThisTick = new Set(); // mint:wallet already fully sold this tick
        const modes = [...new Set(act.map((o) => o.mode))];
        const migMints = [...new Set(act.filter((o) => o.type === 'mig' || o.type === 'miginit').map((o) => o.mint))];
        const res = await call([
          ...modes.map((m) => ({ method: 'GET', path: `/api/performance/holdings?source=${m}` })),
          ...migMints.map((m) => ({ method: 'GET', path: `/api/tokens/${m}/annotations` })),
        ]);
        const hold = {};
        modes.forEach((m, i) => {
          const r = res[i]; hold[m] = null;
          if (!r || !r.ok || !r.j.byWallet) return; // unknown this tick → don't act
          const map = (hold[m] = {});
          for (const [w, x] of Object.entries(r.j.byWallet)) for (const h of x.holdings || []) {
            if (!h.tokenAddress || (num(h.worthSol) !== null && num(h.worthSol) < 0.0005)) continue; // dust = closed
            (map[h.tokenAddress] = map[h.tokenAddress] || {})[w] = h;
          }
        });
        const migrated = {};
        migMints.forEach((m, i) => { const r = res[modes.length + i]; const t = r && r.ok && r.j && r.j.migration ? Number(r.j.migration.t) : 0; migrated[m] = t > 0; });

        for (const o0 of act) {
          if (!hold[o0.mode]) continue;
          const o = JSON.parse(JSON.stringify(o0));
          const hs = hold[o.mode][o.mint] || {};
          const ws = Object.keys(hs).filter((w) => !o.wallets || o.wallets.includes(w));
          const sells = [];
          const logp = (m) => { o.log.push(`${new Date().toLocaleTimeString()} ${m}`); o.log = o.log.slice(-8); };
          const fin = (st8, m) => { o.status = st8; o.doneAt = now; if (m) logp(m); };
          const mc = liveMc(o.mint);
          if (mc) o.lastMc = +mc.toPrecision(3);
          if (o.type === 'protect') {
            for (const w of ws) {
              const h = hs[w]; if (h.pnlPct == null) continue;
              const s = o.state[w] || (o.state[w] = { peak: h.pnlPct });
              s.peak = Math.max(s.peak, h.pnlPct); s.last = h.pnlPct;
              if (!s.armed && s.peak >= o.arm) { s.armed = now; logp(`armed ${tail(w)} (peak +${s.peak.toFixed(1)}%)`); }
              if (s.armed && !s.sold && h.pnlPct <= o.floor && (s.tries || 0) < 3 && (!s.lastTry || now - s.lastTry > 15000)) sells.push({ w, pct: o.pct });
            }
            const tracked = Object.keys(o.state);
            if (tracked.length && tracked.every((w) => o.state[w].sold || !hs[w])) fin('done', 'position closed');
          } else if (o.type === 'mig' || o.type === 'miginit') {
            if (migrated[o.mint]) {
              if (!o.migSeen) { o.migSeen = now; logp('migration detected'); }
              for (const w of ws) {
                const s = o.state[w] || (o.state[w] = {});
                if (s.sold || (s.tries || 0) >= 3 || (s.lastTry && now - s.lastTry < 15000)) continue;
                if (o.type === 'mig') { sells.push({ w, pct: o.pct }); continue; }
                const ip = initPlan(hs[w]);
                if (ip.skip) { s.sold = 'skip'; logp(`${tail(w)} skipped: ${ip.skip}`); continue; }
                sells.push({ w, pct: ip.pct });
              }
              if (!ws.length || ws.every((w) => o.state[w] && o.state[w].sold)) fin('done', ws.length ? '' : 'migrated, no position left');
            }
          } else if (o.type === 'dip' || o.type === 'dca') {
            if (o.type === 'dip' && o.expires && now > o.expires) fin('expired', 'expired');
            else {
              const due = o.type === 'dip' ? mc && mc <= o.target : now >= (o.nextAt || 0);
              if (o.type === 'dip' && !mc) o.wait = 'no live price';
              else delete o.wait;
              if (due && (!o.lastTry || now - o.lastTry > 10000)) {
                o.lastTry = now; o.tries = (o.tries || 0) + 1;
                const amount = o.type === 'dip' ? o.amount : +(o.total / o.slices).toFixed(4);
                const strat = o.stratId ? st.strats.find((s) => s.id === o.stratId) : null;
                const r = await execBuy({ mint: o.mint, symb: o.sym, wallets: o.wallets || [null], amount, split: o.split, mode: o.mode, interactive: false, strat, note: o.type === 'dip' ? `dip ≤ ${mc$(o.target)}` : `DCA ${(o.done || 0) + 1}/${o.slices}` });
                if (r.ok) {
                  if (o.type === 'dip') fin('done', `BOUGHT ${sol(r.total)} ◎ at ${mc$(mc)}`);
                  else { o.done = (o.done || 0) + 1; o.tries = 0; delete o.lastTry; o.nextAt = now + o.every * 1000; logp(`slice ${o.done}/${o.slices} · ${sol(r.total)} ◎`); if (o.done >= o.slices) fin('done', 'all slices bought'); }
                } else {
                  logp(`buy failed: ${r.err || 'error'}`);
                  if (o.tries >= 3) fin('failed', 'giving up after 3 tries');
                }
              }
            }
          } else if (o.type === 'tpmc' || o.type === 'trail') {
            if (!mc) o.wait = 'no live price';
            else {
              delete o.wait;
              if (o.type === 'trail') o.peak = Math.max(o.peak || mc, mc);
              const hit = o.type === 'tpmc' ? mc >= o.target : mc <= o.peak * (1 - o.pct / 100);
              if (hit) {
                if (!ws.length) fin('done', 'triggered, no position left');
                else for (const w of ws) { const s = o.state[w] || (o.state[w] = {}); if (!s.sold && (s.tries || 0) < 3 && (!s.lastTry || now - s.lastTry > 10000)) sells.push({ w, pct: o.type === 'tpmc' ? o.pct : 100 }); }
                if (!o.hitAt) { o.hitAt = now; logp(`triggered at ${mc$(mc)}`); }
              }
            }
            if (o.hitAt && ws.length && ws.every((w) => o.state[w] && o.state[w].sold)) fin('done');
          } else if (o.type === 'exitx') {
            // trailing on the position's own price (1 + PnL%), which survives partial sells
            if (o.trail) for (const w of ws) {
              const h = hs[w]; if (h.pnlPct == null) continue;
              const s = o.state[w] || (o.state[w] = {}), px = 1 + h.pnlPct / 100;
              s.peak = Math.max(s.peak || px, px);
              if (!s.sold && s.peak > 1 && px <= s.peak * (1 - o.trail / 100) && (s.tries || 0) < 3 && (!s.lastTry || now - s.lastTry > 10000)) { sells.push({ w, pct: 100 }); logp(`trail hit ${tail(w)} (peak +${((s.peak - 1) * 100).toFixed(0)}%)`); }
            }
            if (o.be && (!o.beAt || now - o.beAt > 10000)) {
              o.beAt = now;
              const ps = await tpslPositions(o.mint, o.mode);
              for (const p of ps || []) {
                if (o.wallets && !o.wallets.includes(p.walletAddress)) continue;
                const k = p.walletAddress || '*', s = o.state[k] || (o.state[k] = {});
                const tpHit = (p.levels || []).some((x) => x.type === 'TAKE_PROFIT' && x.executed);
                const sl = openLevels(p).find((x) => x.type === 'STOP_LOSS');
                if (!s.be && tpHit && sl && Number(sl.percentage) > 1) {
                  const lv = openLevels(p).map((x) => ({ type: x.type, percentage: x.type === 'STOP_LOSS' ? 1 : x.percentage, amountPct: x.amountPct }));
                  const r = await saveLevels(o.mint, o.mode, p, lv);
                  if (r && r.ok) { s.be = now; logp(`SL → break-even ${p.walletAddress ? tail(p.walletAddress) : ''}`); toast(`${o.sym}: TP1 hit, stop-loss moved to break-even`); }
                }
              }
            }
            const seen = Object.keys(hs).length;
            if (seen) o.seen = true;
            if (o.seen && !ws.length) fin('done', 'position closed');
          }
          for (let i = sells.length - 1; i >= 0; i--) {
            const k = o.mint + ':' + sells[i].w;
            if (fullThisTick.has(k)) { (o.state[sells[i].w] = o.state[sells[i].w] || {}).sold = 'skip'; sells.splice(i, 1); continue; }
            if (sells[i].pct >= 100) fullThisTick.add(k);
          }
          if (sells.length) {
            const rs = await call(sells.map((x) => ({ method: 'POST', path: `/api/tokens/${o.mint}/sell`,
              body: { percent: x.pct, source: o.mode, idempotencyKey: id(), walletAddress: x.w } })), true);
            sells.forEach((x, i) => {
              const s = o.state[x.w] || (o.state[x.w] = {}), r = rs[i];
              s.tries = (s.tries || 0) + 1; s.lastTry = now;
              if (r && r.ok) { s.sold = now; logp(`SOLD ${x.pct}% ${tail(x.w)}`); }
              else logp(`sell failed ${tail(x.w)}: ${(r && r.j && r.j.error) || 'error'}${s.tries < 3 ? ', will retry' : ', giving up'}`);
            });
            const okN = rs.filter((r) => r && r.ok).length;
            toast(`${o.sym}: ${orderLabel(o)} → sold on ${okN}/${sells.length} wallet(s)`, !okN);
            if (okN && st.alerts.fills) notify(`${o.sym}: ${orderTag(o)} fired`, `${orderLabel(o)} · sold on ${okN} wallet(s)`, 'fill', o.mint);
            if (o.type !== 'protect' && o.type !== 'exitx' && ws.every((w) => o.state[w] && o.state[w].sold)) fin('done');
            if (o.type === 'protect' && ws.length && ws.every((w) => o.state[w] && o.state[w].sold)) fin('done');
          }
          if (JSON.stringify(o) !== JSON.stringify(o0)) upd.set(o.id, o);
        }
        if (upd.size) {
          const cur = loadOrders();
          for (const [oid, o] of upd) { const i = cur.findIndex((x) => x.id === oid); if (i >= 0 && cur[i].status === 'active') cur[i] = o; }
          saveOrders(cur);
        }
      } finally { watching = false; }
    }

    async function pushTx() {
      const p = P();
      if (!(await ask({ tone: 'live', title: `Apply P${st.preset + 1} tx settings`, sub: `to ALL your ${st.mode.toUpperCase()} AG wallets`,
        lines: [`Slippage ${p.slippage}%`, `Priority fee ${p.fee} SOL`, `MEV ${p.mev}`], note: 'These are the wallets’ own AG settings, so the AG bot uses them too.',
        actions: [{ label: 'Cancel', v: null, kind: 'ghost' }, { label: 'Apply', v: 'go', kind: 'pri' }] }))) return;
      const res = await call([
        { method: 'POST', path: '/api/performance/wallets/tx-settings-all', body: { slippage: Number(p.slippage), source: st.mode } },
        { method: 'POST', path: '/api/performance/wallets/tx-settings-all', body: { priorityFeeSol: Number(p.fee), source: st.mode } },
        { method: 'POST', path: '/api/performance/wallets/tx-settings-all', body: { mevProtection: p.mev, source: st.mode } },
      ], true);
      const ok = res.filter((r) => r && r.ok).length;
      toast(ok === 3 ? `P${st.preset + 1} tx settings applied to your ${st.mode} wallets` : `Tx settings: ${ok}/3 applied · ${(res.find((r) => !r || !r.ok) || {}).j?.error || 'error'}`, ok !== 3);
    }

    // ---------------------------------------------------------- UI helpers
    const kfmt = (v) => (v == null || isNaN(v) ? '--' : Math.abs(v) >= 1e9 ? (v / 1e9).toFixed(2) + 'B' : Math.abs(v) >= 1e6 ? (v / 1e6).toFixed(2) + 'M'
      : Math.abs(v) >= 1e3 ? (v / 1e3).toFixed(Math.abs(v) >= 1e5 ? 0 : 1) + 'K' : v.toFixed(Math.abs(v) >= 10 ? 0 : 2));
    const usdV = (v) => (v == null || isNaN(v) ? '' : (v < 0 ? '-' : '') + '$' + (Math.abs(v) >= 1e6 ? (Math.abs(v) / 1e6).toFixed(2) + 'M'
      : Math.abs(v) >= 1e4 ? (Math.abs(v) / 1e3).toFixed(1) + 'K' : Math.abs(v).toFixed(2)));
    const usdS = (solV) => (solV == null || !usdRate ? '' : usdV(solV * usdRate));
    // token amount ≈ value / price, price = mcap / 1B (pump.fun-style supply); shown with "≈"
    function tokEst(worthSol) {
      const mint = getMint(), mu = mint && mcapNow(mint);
      if (!(mu > 0) || !(usdRate > 0) || worthSol == null) return null;
      return worthSol / (mu / usdRate / SUPPLY);
    }
    const tokFmt = (w) => { const t = tokEst(w); return t == null ? sol(w) + ' ◎' : '≈' + kfmt(t); };
    function curvePct(mint) {
      const mu = mcapNow(mint);
      if (!mint || !/pump$/i.test(mint) || !(mu > 0) || !(usdRate > 0)) return null;
      const mSol = mu / usdRate;
      if (mSol >= CURVE_END_MCAP_SOL) return 100;
      return Math.max(0, Math.min(100, ((Math.sqrt((PUMP_K * mSol) / SUPPLY) - 30) / 85) * 100)); // virtual SOL 30 → ~115
    }
    const unitLab = (a, unit) => (unit === 'pct' ? a + '%' : unit === 'usd' ? '$' + (a >= 1000 ? a / 1000 + 'K' : a) : String(a));
    const ini = (w) => {
      const l = labelOf(w), m = l.match(/^([A-Za-z])[A-Za-z]*[\s_-]*(\d+)/);
      return (m ? m[1] + m[2] : l.replace(/[^A-Za-z0-9]/g, '').slice(0, 2)).toUpperCase().slice(0, 3) || '?';
    };
    const sv = (d, w = 14) => `<svg width="${+(w / 12).toFixed(3)}em" height="${+(w / 12).toFixed(3)}em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
    const ICON = {
      wallet: sv('<rect x="3" y="6" width="18" height="13" rx="2"/><path d="M16 12.5h2"/>'),
      down: sv('<path d="M6 9l6 6 6-6"/>', 10),
      edit: sv('<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13 7l4 4"/>', 15),
      clock: sv('<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2 2M9 2h6"/>'),
      gear: sv('<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/>', 15),
      min: sv('<path d="M5 12h14"/>', 15),
      max: sv('<rect x="4" y="4" width="16" height="16" rx="2"/>', 15),
      slip: sv('<path d="M3 17c3-6 6 2 9-4s6-2 9-6"/>', 13),
      gas: sv('<path d="M4 21V5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v16M3 21h12M14 9h2a2 2 0 0 1 2 2v5a1.5 1.5 0 0 0 3 0V8l-3-3"/>', 13),
      shield: sv('<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/>', 13),
      wave: sv('<path d="M4 12h3l2-5 3 10 2-5h6"/>', 13),
      swap: sv('<path d="M4 8h14l-3-3M20 16H6l3 3"/>', 13),
      check: sv('<path d="M5 12l5 5 9-10"/>'),
      copy: sv('<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>', 12),
      arrow: sv('<path d="M5 12h14M13 6l6 6-6 6"/>', 13),
      refresh: sv('<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>'),
      cons: sv('<circle cx="6" cy="5" r="2"/><circle cx="18" cy="5" r="2"/><circle cx="12" cy="19" r="2"/><path d="M6 7c0 5 6 5 6 10M18 7c0 5-6 5-6 10"/>', 15),
      split: sv('<circle cx="12" cy="5" r="2"/><circle cx="5" cy="19" r="2"/><circle cx="12" cy="19" r="2"/><circle cx="19" cy="19" r="2"/><path d="M12 7v10M12 9c0 4-7 4-7 8M12 9c0 4 7 4 7 8"/>', 15),
      even: sv('<path d="M12 3v18M5 7h14M5 7l-3 7h6zM19 7l-3 7h6z"/>', 15),
      sweep: sv('<path d="M12 3v12M7 10l5 5 5-5"/><path d="M4 21h16"/>', 15),
      warn: sv('<path d="M12 3l10 18H2z"/><path d="M12 10v5M12 18h.01"/>', 16),
      bolt: sv('<path d="M13 2L4 14h7l-1 8 9-12h-7z"/>', 15),
      plus: sv('<path d="M12 5v14M5 12h14"/>', 15),
      server: sv('<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/>', 11),
      list: sv('<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>', 15),
      info: sv('<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>', 13),
      x: sv('<path d="M6 6l12 12M18 6L6 18"/>', 14),
      share: sv('<path d="M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7M16 6l-4-4-4 4M12 2v13"/>', 13),
    };

    const CSS = `
    #agtw{--bg:#17191E;--bg2:#1F2228;--bg3:#111316;--ln:#2C3038;--ln2:#24272E;--tx:#E6E8EC;--mut:#8B919C;--mut2:#6E7480;
      --buy:#8FE6B4;--buyB:#4FAF7D;--sell:#F59AA6;--sellB:#B9505F;--acc:#B8F04A;--warn:#F2B84B;--paper:#60A5FA;--vio:#D2C5FF;
      position:fixed;z-index:100001;width:380px;background:var(--bg);border:1px solid var(--ln);
      border-radius:14px;color:var(--tx);font:12px/1.35 'IBM Plex Sans',Inter,system-ui,sans-serif;box-shadow:0 14px 40px #000b;user-select:none;text-align:left}
    #agtw.col{width:auto;min-width:300px}
    #agtw .in{max-height:calc(100vh - 16px);overflow:auto;scrollbar-width:thin;border-radius:inherit}
    #agtw .rz{position:absolute;right:2px;bottom:2px;width:16px;height:16px;cursor:nwse-resize;opacity:.45;border-radius:0 0 12px 0;
      background:linear-gradient(135deg,transparent 0 55%,var(--mut) 55% 62%,transparent 62% 72%,var(--mut) 72% 79%,transparent 79%)}
    #agtw .rz:hover{opacity:1}
    #agtw.col .rz{display:none}
    #agtw *{box-sizing:border-box}
    #agtw .n{font-family:'IBM Plex Mono',ui-monospace,SFMono-Regular,Menlo,monospace;font-variant-numeric:tabular-nums}
    #agtw .sp{flex:1}
    #agtw .mut{color:var(--mut)}#agtw .sm{font-size:10.5px}#agtw .up{color:var(--buy)}#agtw .dn{color:var(--sell)}#agtw .acc{color:var(--acc)}#agtw .y{color:var(--warn)}
    #agtw button{font:inherit;color:inherit;cursor:pointer;background:none;border:0;padding:0;margin:0}
    #agtw button:disabled{opacity:.4;cursor:default}
    #agtw input,#agtw select{font:inherit;color:var(--tx);background:var(--bg3);border:1px solid var(--ln);border-radius:7px;padding:5px 7px;min-width:0;outline:none;margin:0}
    #agtw input:focus,#agtw select:focus{border-color:var(--acc)}
    #agtw input[type=checkbox]{width:15px;height:15px;padding:0;accent-color:#B8F04A;flex:none}
    #agtw svg{display:block;flex:none}
    #agtw .gr{display:flex;gap:6px;padding:8px 10px;border-bottom:1px solid var(--ln2);overflow-x:auto;scrollbar-width:none}
    #agtw .gc{background:var(--bg2);border:1px solid var(--ln);border-radius:8px;padding:3px 9px;color:#C9CDD4;white-space:nowrap}
    #agtw .gc:hover{border-color:#3A3F48}
    #agtw .gc.on{background:var(--acc);border-color:var(--acc);color:#15180F;font-weight:700}
    #agtw .gc.add{border-style:dashed;color:var(--mut);background:none}
    #agtw .hd{display:flex;align-items:center;gap:6px;padding:8px 10px;border-bottom:1px solid var(--ln2);cursor:move}
    #agtw .hd.edit{background:#1C2A12}
    #agtw .md{border-radius:999px;padding:3px 10px;font-size:10.5px;font-weight:700;letter-spacing:.08em;white-space:nowrap}
    #agtw .md.live{background:#5C1414;border:1px solid #F05252;color:#FFE4E4}
    #agtw .md.paper{background:#10233A;border:1px solid #3B82F6;color:#CFE3FF}
    #agtw .btn{display:inline-flex;align-items:center;gap:5px;background:var(--bg2);border:1px solid var(--ln);border-radius:8px;padding:4px 8px;white-space:nowrap}
    #agtw .btn:hover:not(:disabled){border-color:#3A3F48}
    #agtw .btn.on{border-color:var(--acc);color:var(--acc)}
    #agtw .btn.pri{background:var(--acc);border-color:var(--acc);color:#15180F;font-weight:700}
    #agtw .btn.sm{padding:3px 7px;font-size:11px}
    #agtw .btn.pri:disabled{background:#2E3A1A;border-color:#3E4E22;color:#A9B88F;opacity:1}
    #agtw .btn.wide{width:100%;justify-content:center}
    #agtw .btn.bb{border-color:var(--buyB);color:var(--buy);font-weight:700;padding:4px 14px}
    #agtw .ib{display:inline-flex;align-items:center;gap:3px;color:var(--mut);padding:4px;border-radius:7px}
    #agtw .ib:hover:not(:disabled),#agtw .ib.on{color:var(--tx);background:var(--bg2)}
    #agtw .ib.ord.has{background:#2A2412;border:1px solid #5A4A1C;color:#FFE08A;padding:3px 6px}
    #agtw .ps{display:flex;gap:1px}
    #agtw .ps button{padding:2px 5px;color:var(--mut2);font-weight:600}
    #agtw .ps button.on{color:var(--acc);font-weight:700}
    #agtw .bd{padding:0 12px}
    #agtw .tk{display:flex;align-items:center;gap:6px;padding:9px 0 0}
    #agtw .tk b{font-size:13.5px}
    #agtw .cv{width:44px;height:4px;background:var(--ln);border-radius:4px;overflow:hidden}
    #agtw .cv i{display:block;height:4px;background:var(--acc)}
    #agtw .busy{color:var(--warn);font-size:10.5px}
    #agtw .mc{transition:color .4s}
    #agtw .lvd{width:7px;height:7px;border-radius:7px;background:#3DDC97;box-shadow:0 0 0 0 #3DDC9799;animation:agtwPulse 1.6s infinite}
    #agtw .lvt{font-size:9.5px;letter-spacing:.08em;color:inherit;opacity:.9}
    #agtw .syn{font-size:9.5px;letter-spacing:0;opacity:.8}
    @keyframes agtwPulse{0%{box-shadow:0 0 0 0 #3DDC9799}70%{box-shadow:0 0 0 6px #3DDC9700}100%{box-shadow:0 0 0 0 #3DDC9700}}
    #agtw .sec{display:flex;flex-direction:column;gap:8px;padding:10px 0}
    #agtw .sep{height:1px;background:var(--ln2)}
    #agtw .sh{display:flex;align-items:center;gap:8px;min-height:22px}
    #agtw .st{font-size:14px;font-weight:600}
    #agtw .sm2{font-size:12.5px;font-weight:600}
    #agtw .seg{display:flex;background:var(--bg3);border:1px solid var(--ln2);border-radius:8px;padding:2px}
    #agtw .seg button{border-radius:6px;padding:1px 8px;color:var(--mut)}
    #agtw .seg button.on{background:#2A2D34;color:var(--tx);font-weight:600}
    #agtw .sc{background:#221A3A;border:1px solid #5B47A8;border-radius:999px;padding:1px 8px;color:var(--vio);font-size:11px;font-weight:600}
    #agtw .sw{display:inline-flex;align-items:center;gap:3px;color:var(--mut)}
    #agtw .sw:hover{color:var(--tx)}
    #agtw .at{font-size:10.5px;color:var(--acc);border:1px solid #4E6420;border-radius:999px;padding:0 7px;white-space:nowrap}
    #agtw .hv{color:#C9CDD4;white-space:nowrap}
    #agtw .hv i{font-style:normal;color:#3A3F48;margin:0 5px}
    #agtw .g4{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:7px}
    #agtw .t{height:36px;border-radius:9px;font-weight:600;font-size:13px;display:flex;flex-direction:column;align-items:center;justify-content:center;line-height:1.15}
    #agtw .t.two{height:42px}
    #agtw .t small{font-size:10px;font-weight:400;color:var(--mut);margin-top:2px}
    #agtw .t.b{border:1px solid var(--buyB);color:var(--buy)}
    #agtw .t.b:hover:not(:disabled){background:#163126}
    #agtw .t.s{border:1px solid var(--sellB);color:var(--sell)}
    #agtw .t.s:hover:not(:disabled){background:#2E161B}
    #agtw .t.mini{height:28px;padding:0 9px;font-size:12px}
    #agtw .ei{height:36px;text-align:center;font-weight:600;font-size:13px;border-radius:9px;width:100%}
    #agtw .ei.b{background:#12241B;border:1px dashed var(--buyB);color:#DFFBEA}
    #agtw .ei.s{background:#2A1418;border:1px dashed var(--sellB);color:#FFE0E5}
    #agtw .ei:focus{border:2px solid var(--acc)}
    #agtw .tl{display:flex;align-items:center;gap:10px;color:var(--mut);font-size:11px;min-height:18px}
    #agtw .tl>span{display:inline-flex;align-items:center;gap:3px}
    #agtw .tl .vi{color:#B9A6FF}
    #agtw .adv{display:flex;align-items:center;gap:4px;color:#C9CDD4;cursor:pointer}
    #agtw .si{color:var(--warn);font-weight:600}
    #agtw .si.mini{border:1px solid #8A6A1E;border-radius:8px;height:28px;padding:0 9px}
    #agtw .cu{display:flex;gap:6px}
    #agtw .cu input{flex:1}
    #agtw .eg{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:7px}
    #agtw .eg.two{grid-template-columns:1fr 1fr}
    #agtw .eg label{display:flex;flex-direction:column;gap:3px;font-size:10px;color:var(--mut)}
    #agtw .eg label.ck{flex-direction:row;align-items:center;gap:6px;font-size:11px;color:#C9CDD4;margin-top:14px}
    #agtw .ax{background:#1C1F25;border:1px solid var(--ln);border-radius:10px;padding:10px;display:flex;flex-direction:column;gap:8px;margin-bottom:12px}
    #agtw .g3{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px}
    #agtw .ax .g3 button{border:1px solid #5A4A1C;color:#FFE08A;border-radius:8px;padding:6px 0;font-size:11px;font-weight:600}
    #agtw .ax .g3 button:hover:not(:disabled){background:#2A2412}
    #agtw .or{display:flex;flex-direction:column;gap:5px}
    #agtw .orr{display:flex;align-items:center;gap:7px;font-size:11.5px}
    #agtw .dot{display:inline-block;width:7px;height:7px;border-radius:7px;flex:none}
    #agtw .xx{border:1px solid #5C1414;color:#FCA5A5;border-radius:6px;padding:0 6px;line-height:1.3}
    #agtw .pb{height:4px;background:var(--ln);border-radius:4px;overflow:hidden}
    #agtw .pb i{display:block;height:4px;background:var(--warn);border-radius:4px}
    #agtw .pl{display:flex;justify-content:space-between;font-size:10px;color:var(--mut)}
    #agtw .ft{border-top:1px solid var(--ln2);padding:10px 12px 12px;display:flex;flex-direction:column;gap:10px}
    #agtw .g3s{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:6px}
    #agtw .sb{display:flex;flex-direction:column;gap:1px}
    #agtw .lb{font-size:10px;color:var(--mut2);letter-spacing:.06em}
    #agtw .sb .v{font-weight:600;font-size:13px}
    #agtw .sb .u{font-size:10.5px;color:var(--mut);min-height:14px}
    #agtw .sb .u.up{color:var(--buy)}#agtw .sb .u.dn{color:var(--sell)}
    #agtw .pc{display:flex;align-items:center;gap:10px;border-radius:10px;padding:9px 11px;background:var(--bg2);border:1px solid var(--ln);color:var(--tx)}
    #agtw .pc.pos{background:#13261C;border-color:#24563C;color:var(--buy)}
    #agtw .pc.neg{background:#2A1418;border-color:#5C2A33;color:var(--sell)}
    #agtw .pc .lb{color:inherit;opacity:.75}
    #agtw .pv{display:flex;align-items:baseline;gap:8px}
    #agtw .pv .big{font-size:18px;font-weight:600}
    #agtw .pill{border-radius:999px;padding:3px 10px;font-weight:700;font-size:13px;background:#2A2D34}
    #agtw .pc.pos .pill{background:#1E4A33;color:#CFF7E1}
    #agtw .pc.neg .pill{background:#4A1E26;color:#FFD9DF}
    #agtw .dl{display:flex;align-items:center;gap:5px;font-size:10.5px;color:var(--mut2)}
    #agtw .dl .n{color:var(--mut)}
    #agtw .dl i{font-style:normal;color:#3A3F48}
    #agtw .eh{border-top:1px solid var(--ln2);padding:9px 12px}
    #agtw .wp,#agtw .stp,#agtw .olp{border-bottom:1px solid var(--ln2);background:#15171B}
    #agtw .stp,#agtw .olp{padding:10px 12px;display:flex;flex-direction:column;gap:8px}
    #agtw .olp{max-height:280px;overflow:auto}
    #agtw .tip{background:var(--bg2);border-bottom:1px solid var(--ln);padding:7px 12px;text-align:center;color:#C9CDD4;font-size:11px}
    #agtw .wt{display:flex;align-items:center;gap:5px;padding:8px 10px;border-bottom:1px solid var(--ln2)}
    #agtw .tb{border:1px solid var(--ln);background:var(--bg2);padding:5px}
    #agtw .tb.on{border-color:var(--acc);color:var(--acc)}
    #agtw .note{padding:6px 12px;font-size:10.5px;color:var(--mut);border-bottom:1px solid var(--ln2)}
    #agtw .lk{color:var(--acc);text-decoration:underline;text-underline-offset:2px}
    #agtw .wh{display:flex;gap:8px;padding:6px 12px 4px;font-size:10px;color:var(--mut2)}
    #agtw .c1{width:74px;text-align:right}
    #agtw .c2{width:64px;text-align:right}
    #agtw .wl2{max-height:300px;overflow:auto}
    #agtw .wr{display:flex;align-items:center;gap:8px;padding:7px 12px;border-top:1px solid var(--bg2);cursor:pointer}
    #agtw .wr:hover{background:#1A1D22}
    #agtw .wr.off{opacity:.6}
    #agtw .av{width:28px;height:28px;border-radius:28px;background:#24272E;display:flex;align-items:center;justify-content:center;font-size:9.5px;font-weight:700;color:#C9CDD4;flex:none}
    #agtw .wn{display:flex;flex-direction:column;min-width:0}
    #agtw .wn b{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:120px}
    #agtw .gsv{display:flex;flex-wrap:wrap;align-items:center;gap:5px;padding:8px 12px;border-top:1px solid var(--ln2)}
    #agtw .gt{display:inline-flex;align-items:center;gap:4px;background:var(--bg2);border:1px solid var(--ln);border-radius:999px;padding:1px 3px 1px 9px;font-size:11px}
    #agtw .pbx{border-top:1px solid var(--ln);background:#1C1F25;padding:10px 12px;display:flex;flex-direction:column;gap:7px}
    #agtw .ds{padding:2px 6px;max-width:130px}
    #agtw .tr{display:flex;align-items:center;gap:6px;font-size:11.5px}
    #agtw .tr svg{color:var(--mut)}
    #agtw .pbx .g3 .btn{justify-content:center;height:34px}
    #agtw .cb{display:flex;align-items:center;gap:7px;padding:8px 10px;cursor:move}
    #agtw .cn{display:flex;flex-direction:column;margin-right:6px;white-space:nowrap}
    #agtw .btn.ghost{background:none}
    #agtw .btn.ok{border-color:var(--buyB);color:var(--buy);font-weight:700}
    #agtw .btn.danger{background:#B9505F;border-color:#B9505F;color:#FFF0F2;font-weight:700}
    #agtw .pnl{max-height:440px;overflow:auto;scrollbar-width:thin}
    #agtw .pnl>*{flex-shrink:0}
    #agtw .kb{position:absolute;top:3px;left:4px;font:600 8.5px/1 'IBM Plex Mono',monospace;color:var(--mut2);font-style:normal;opacity:.85;pointer-events:none}
    #agtw .t small{white-space:nowrap}
    #agtw .t small .ip{font-weight:600;color:var(--mut)}
    #agtw .t.b.hot small .ip{color:#F59AA6}
    #agtw .t{position:relative}
    #agtw .t.b.hot{border-color:#B9505F;background:#2A1418}
    #agtw .t.b.hot small{color:#F59AA6}
    #agtw .t.s.full{background:#2E161B;color:#FFC2C2}
    #agtw .stb{display:inline-flex;align-items:center;gap:3px;font-size:10.5px;color:#7FE0B0;background:#10261C;border:1px solid #24563C;border-radius:999px;padding:0 7px;white-space:nowrap;max-width:90px;overflow:hidden;text-overflow:ellipsis}
    #agtw .srvb{display:inline-flex;align-items:center;gap:4px;font-size:10px;color:#7FE0B0;background:#10261C;border:1px solid #24563C;border-radius:999px;padding:1px 7px}
    #agtw .tagb{font-size:9.5px;color:#FFE08A;background:#2A2412;border:1px solid #5A4A1C;border-radius:999px;padding:0 6px;margin-left:4px}
    #agtw .ax select{padding:2px 6px;max-width:120px}
    #agtw .lvl{display:flex;flex-wrap:wrap;gap:5px}
    #agtw .lvc{font-size:11px;border-radius:7px;padding:2px 7px;background:#17191E;border:1px solid var(--ln)}
    #agtw .lvc.tp b{color:var(--buy)}#agtw .lvc.sl b{color:var(--sell)}#agtw .lvc.br{color:#FFE08A;border-color:#5A4A1C}
    #agtw .pv2{display:flex;gap:6px;flex-wrap:wrap;font-size:11px;color:var(--mut)}
    #agtw .sel{display:flex;flex-direction:column;gap:6px}
    #agtw .sel .nm{font-weight:600}
    #agtw .lvr{display:flex;align-items:center;gap:6px}
    #agtw .lvr select{width:58px}
    #agtw .lf{display:flex;align-items:center;gap:3px;font-size:11px;color:var(--mut)}
    #agtw .lf input,#agtw .tiny{width:52px;text-align:right;padding:3px 5px}
    #agtw .onag{display:flex;align-items:center;gap:6px;flex-wrap:wrap;background:#17191E;border:1px solid var(--ln);border-radius:8px;padding:6px 8px}
    #agtw .sep2{height:1px;background:var(--ln);margin:2px 0}
    #agtw .ax .yb{border:1px solid #5A4A1C;color:#FFE08A;border-radius:8px;padding:6px 0;font-size:11px;font-weight:600}
    #agtw .ax .yb:hover:not(:disabled){background:#2A2412}
    #agtw .seg.wide{display:grid;grid-template-columns:repeat(4,minmax(0,1fr))}
    #agtw .seg.wide button{padding:4px 0}
    #agtw label.big{display:flex;flex-direction:column;gap:4px;font-size:10.5px;color:var(--mut)}
    #agtw .tin{display:flex;align-items:center;gap:6px;background:var(--bg3);border:1px solid var(--ln);border-radius:9px;padding:6px 10px}
    #agtw .tin.on{border-color:var(--acc)}
    #agtw .tin input{flex:1;background:none;border:0;padding:0;font-size:15px}
    #agtw .qk{justify-content:center}
    #agtw .tbar{position:relative;height:44px;margin:2px 4px}
    #agtw .tbar i{position:absolute;display:block}
    #agtw .tbar .ln{left:0;right:0;top:19px;height:4px;background:var(--ln);border-radius:4px}
    #agtw .tbar .zone{top:19px;height:4px;border-radius:4px;opacity:.5}
    #agtw .tbar .zone.dip{background:var(--sell)}#agtw .tbar .zone.tp{background:var(--buy)}
    #agtw .tbar .mk{top:13px;width:3px;height:16px;margin-left:-1px;border-radius:2px}
    #agtw .tbar .mk.tg{background:var(--acc)}#agtw .tbar .mk.now{background:#3DDC97;width:9px;height:9px;top:16px;margin-left:-4px;border-radius:9px}
    #agtw .tbar .lbl{position:absolute;top:31px;font-size:9.5px;transform:translateX(-50%);white-space:nowrap}
    #agtw .tbar .lbl.tg{color:var(--acc)}#agtw .tbar .lbl.now{color:var(--buy);top:0}#agtw .tbar .lbl.en{color:var(--mut);top:0}
    #agtw .ro{background:var(--bg3);border:1px solid var(--ln);border-radius:7px;padding:5px 7px;color:#C9CDD4}
    #agtw .btn.arm{justify-content:center;height:38px;background:#2FBF85;border-color:#2FBF85;color:#04140D;font-weight:700}
    #agtw .btn.arm.sellc{background:#B9505F;border-color:#B9505F;color:#FFF0F2}
    #agtw .trw{background:#1C1F25;border:1px solid var(--ln);border-radius:9px;padding:7px 9px;display:flex;flex-direction:column;gap:5px}
    #agtw .otag{font-size:9.5px;font-weight:700;letter-spacing:.06em;border-radius:5px;padding:1px 6px;background:#24272E;color:#C9CDD4;flex:none}
    #agtw .otag.dip,#agtw .otag.dca{background:#163126;color:#8FE6B4}#agtw .otag.tpmc,#agtw .otag.protect,#agtw .otag.mig,#agtw .otag.miginit{background:#2A2412;color:#FFE08A}
    #agtw .otag.trail,#agtw .otag.exitx{background:#221A3A;color:#D2C5FF}
    #agtw .lk2{font-weight:700;color:var(--tx);text-align:left}#agtw .lk2:hover{color:var(--acc)}
    #agtw .ol{color:#C9CDD4;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
    #agtw .pb.dip i,#agtw .pb.dca i{background:var(--buy)}#agtw .pb.trail i{background:#B9A6FF}#agtw .pb.bad i{background:var(--sell)}
    #agtw .prw{display:flex;flex-direction:column;gap:6px;padding:8px 0;border-top:1px solid var(--bg2)}
    #agtw .pr{display:flex;flex-direction:column;align-items:flex-end;font-size:11px}
    #agtw .pr b{font-size:12px}
    #agtw .ptag{font-size:10px;border-radius:999px;padding:0 7px;border:1px solid #5A4A1C;background:#2A2412;color:#FFE08A;white-space:nowrap}
    #agtw .ptag.srv{border-color:#24563C;background:#10261C;color:#7FE0B0}#agtw .ptag.none{border-color:var(--ln);background:none;color:var(--mut)}
    #agtw .g3s.three{grid-template-columns:repeat(3,minmax(0,1fr))}
    #agtw .agi{border:1px solid #4E6420;background:#1A2012;border-radius:10px;padding:8px 10px;display:flex;flex-direction:column;gap:6px}
    #agtw .agt{font-size:9.5px;font-weight:700;letter-spacing:.08em;color:#15180F;background:var(--acc);border-radius:5px;padding:1px 6px}
    #agtw .chips{display:flex;flex-wrap:wrap;gap:5px}
    #agtw .chip{font-size:10.5px;border-radius:999px;padding:1px 8px;background:#163126;color:#8FE6B4;border:1px solid #24563C}
    #agtw .tlh,#agtw .tlr{display:grid;grid-template-columns:44px 40px 1fr 62px 56px;gap:4px;font-size:11px;padding:3px 0}
    #agtw .tlh{font-size:9.5px;color:var(--mut2);letter-spacing:.06em}
    #agtw .tlr{border-top:1px solid var(--bg2)}
    #agtw .tlh .r,#agtw .tlr .r{text-align:right}
    #agtw .tlr .w{font-family:'IBM Plex Sans',Inter,system-ui,sans-serif;color:#C9CDD4;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    #agtw .conn{background:var(--bg3);border:1px solid var(--ln2);border-radius:9px;padding:7px 9px;display:flex;flex-direction:column;gap:4px}
    #agtw .cr{display:flex;align-items:center;gap:7px;font-size:11px}
    #agtw .dot.ok{background:#3DDC97}#agtw .dot.warn{background:var(--warn)}#agtw .dot.bad{background:#F05252}
    #agtw .keys{display:flex;flex-wrap:wrap;gap:4px 10px}
    #agtw kbd{font:600 10px 'IBM Plex Mono',monospace;background:#24272E;border:1px solid #3A3F48;border-bottom-width:2px;border-radius:5px;padding:1px 5px;color:#E6E8EC}
    #agtw .als{display:flex;flex-direction:column;gap:6px;padding:8px 12px 0}
    #agtw .al{border-radius:10px;padding:8px 10px;display:flex;flex-direction:column;gap:6px;background:#1C1F25;border:1px solid #5A4A1C}
    #agtw .al.dev{background:#2A1418;border-color:#B9505F}
    #agtw .al .g3 .btn{justify-content:center}
    #agtw .atag{font-size:9.5px;font-weight:700;letter-spacing:.08em;border-radius:5px;padding:1px 6px;background:#2A2412;color:#FFE08A;flex:none}
    #agtw .al.dev .atag{background:#B9505F;color:#FFF0F2}
    #agtw .ab{display:flex;align-items:center;gap:6px}
    #agtw .alb{background:#B9505F;color:#fff;border-radius:999px;min-width:18px;height:18px;font-size:10px;font-weight:700;padding:0 5px}
    #agtw .shimg{width:100%;max-height:250px;object-fit:contain;background:#0B0D10;border-radius:10px;border:1px solid var(--ln)}
    #agtw .shb{padding:3px}
    #agtw .mdl{position:absolute;inset:0;z-index:20;background:#0009;border-radius:inherit;display:flex;align-items:flex-start;justify-content:center;padding:60px 12px 12px}
    #agtw .mbox{width:100%;background:#1C1F25;border:1px solid var(--ln);border-radius:14px;padding:14px;display:flex;flex-direction:column;gap:10px;box-shadow:0 18px 50px #000c;user-select:text}
    #agtw .mbox.warn{border-color:#5C2A33}#agtw .mbox.live{border-color:#7A3434}
    #agtw .mh{display:flex;align-items:center;gap:9px}
    #agtw .mic{width:28px;height:28px;border-radius:8px;background:#3A1A10;color:var(--warn);display:flex;align-items:center;justify-content:center;flex:none}
    #agtw .mbox.live .mic{background:#3A1717;color:#FFC2C2}
    #agtw .mt{display:flex;flex-direction:column;min-width:0}
    #agtw .mt b{font-size:13px}
    #agtw .ms{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px}
    #agtw .ms>div{background:#17191E;border-radius:8px;padding:6px 8px;display:flex;flex-direction:column;gap:1px;font-size:10px;color:var(--mut)}
    #agtw .ms>div b{font-size:12.5px;color:var(--tx)}
    #agtw .ms>div.bad{background:#3A1717;color:var(--sell)}#agtw .ms>div.bad b{color:#FFC2C2}
    #agtw .ml{background:#17191E;border-radius:8px;padding:6px 8px;font-size:11px;display:flex;flex-direction:column;gap:2px;max-height:120px;overflow:auto}
    #agtw .mw{font-size:11px;color:var(--warn)}
    #agtw .ma{display:flex;gap:6px}
    #agtw .ma .btn{flex:1;justify-content:center;height:36px}
    #agtw .mk{font-size:9.5px;text-align:center}
    .agtw-toast{position:fixed;z-index:100002;left:50%;bottom:24px;transform:translateX(-50%);max-width:520px;padding:8px 14px;border-radius:8px;
      font:600 12.5px system-ui,sans-serif;box-shadow:0 6px 24px #0008;background:#14532d;color:#dcfce7;border:1px solid #22c55e}
    .agtw-toast.err{background:#7f1d1d;color:#fee2e2;border-color:#ef4444}`;

    function orderStatus(o) {
      const ss = Object.values(o.state || {});
      const armed = ss.filter((s) => s.armed).length, sold = ss.filter((s) => s.sold && s.sold !== 'skip').length;
      const peak = ss.map((s) => s.peak).filter((v) => v != null);
      if (o.status !== 'active') return { txt: o.status + (sold ? ` · sold ${sold}` : ''), cls: o.status === 'done' ? 'up' : 'mut', dot: o.status === 'done' ? 'var(--buy)' : 'var(--mut2)' };
      if (o.type === 'protect') return { txt: (armed ? 'armed' : 'waiting') + (peak.length ? ` · pk ${Math.max(...peak) >= 0 ? '+' : ''}${Math.max(...peak).toFixed(0)}%` : ''), cls: armed ? 'y' : 'mut', dot: armed ? 'var(--warn)' : 'var(--mut2)' };
      if (o.type === 'exitx') { const be = Object.values(o.state || {}).some((x) => x.be); return { txt: be ? 'SL at break-even' : 'watching', cls: be ? 'up' : 'mut', dot: be ? 'var(--buy)' : 'var(--mut2)' }; }
      if (o.type === 'dca') return { txt: `${o.done || 0}/${o.slices} bought`, cls: 'mut', dot: 'var(--buy)' };
      if (o.type === 'dip' || o.type === 'tpmc' || o.type === 'trail') return { txt: o.hitAt ? 'triggered · selling' : 'armed', cls: o.hitAt ? 'y' : 'mut', dot: o.hitAt ? 'var(--warn)' : 'var(--acc)' };
      if (o.migSeen) return { txt: 'migrated · selling', cls: 'y', dot: 'var(--warn)' };
      const c = curvePct(o.mint);
      return { txt: c != null ? `waiting · curve ${c.toFixed(0)}%` : 'waiting for migration', cls: 'mut', dot: 'var(--mut2)' };
    }
    function oRow(o, showSym) {
      const s = orderStatus(o);
      let bar = '';
      if (o.type === 'protect' && o.status === 'active' && pos && o.mint === getMint()) {
        const v = Object.entries(pos).filter(([w]) => !o.wallets || o.wallets.includes(w)).map(([, h]) => num(h.pnlPct)).filter((x) => x != null);
        if (v.length && o.arm > o.floor) {
          const now = v.reduce((a, b) => a + b, 0) / v.length;
          const f = Math.max(0, Math.min(100, ((now - o.floor) / (o.arm - o.floor)) * 100));
          bar = `<div class="pb"><i style="width:${f.toFixed(0)}%"></i></div><div class="pl n"><span>+${o.floor} sell</span><span>now ${now >= 0 ? '+' : ''}${now.toFixed(0)}</span><span>+${o.arm} arm</span></div>`;
        }
      }
      return `<div class="or" title="${escH((o.log || []).join('\n'))}"><div class="orr"><i class="dot" style="background:${s.dot}"></i>
        <span>${showSym ? `<b>${escH(o.sym)}</b> ` : ''}${escH(orderLabel(o))}${o.wallets ? ` <span class="mut">· ${o.wallets.length}w</span>` : ''}${o.mode === 'paper' ? ' <span class="mut">· paper</span>' : ''}</span>
        <span class="sp"></span><span class="n ${s.cls}">${escH(s.txt)}</span>${o.status === 'active' ? `<button class="xx" data-oc="${o.id}" aria-label="Cancel order">×</button>` : ''}</div>${bar}</div>`;
    }
    function ordersPanel(all) {
      const l = (all || loadOrders()).filter((o) => o.status === 'active');
      return `<div class="olp"><div class="sh"><b>Active auto orders</b><span class="sp"></span><span class="mut sm">all tokens · hover a row for its log</span></div>${l.map((o) => oRow(o, true)).join('') || '<div class="mut">None.</div>'}</div>`;
    }

    // ---------------------------------------------------------- GMGN card overlay
    // On every GMGN token card / table row: your position (all wallets in the current mode) with PnL,
    // plus a ⚡ quick-buy button (amount in ⚙, uses the current mode, buy mode and your default wallet selection).
    let held = {};
    const CARD_MINT = /\/sol\/token\/(?:[A-Za-z0-9]+_)?([1-9A-HJ-NP-Za-km-z]{32,44})/;
    let heldBusy = null;
    function loadHeld() { return heldBusy || (heldBusy = loadHeld0().finally(() => { heldBusy = null; })); }
    async function loadHeld0() {
      const [r] = await call([{ method: 'GET', path: `/api/performance/holdings?source=${st.mode}` }]);
      if (!r || !r.ok || !r.j.byWallet) return;
      const m = {};
      for (const [w, x] of Object.entries(r.j.byWallet)) for (const h of x.holdings || []) {
        const worth = num(h.worthSol);
        if (!h.tokenAddress || worth == null || worth < 0.0005) continue; // dust = closed
        if (num(h.worthUsd) > 0 && worth > 0) usdRate = num(h.worthUsd) / worth;
        const a = m[h.tokenAddress] || (m[h.tokenAddress] = { worth: 0, pnl: 0, n: 0, sym: '', wallets: {}, eW: 0, eS: 0 });
        a.worth += worth; a.pnl += num(h.pnlSol) || 0; a.n++; a.wallets[w] = h; a.sym = a.sym || String(h.symbol || '').replace(/^\$+/, '');
        const c = bagCost(h), em = num(h.avgEntryMcap);
        if (c > 0 && em > 0) { a.eW += em * c; a.eS += c; }
      }
      for (const a of Object.values(m)) a.entry = a.eS ? a.eW / a.eS : null;
      heldAll = m; held = m; heldAt = Date.now();
      if (env !== 'ag' && st.cards) scanCards();
      if (ui.panel === 'pos') render();
    }
    const positioned = new WeakSet();
    function scanCards() {
      if (env === 'ag' || document.hidden) return;
      if (!st.cards) { document.querySelectorAll('.agtw-c').forEach((e) => e.remove()); document.querySelectorAll('.agtw-held').forEach((e) => e.classList.remove('agtw-held')); return; }
      const seen = new Set();
      for (const el of document.querySelectorAll('div[href*="/sol/token/"], tr a[href*="/sol/token/"]')) {
        if (el.closest('#agtw')) continue;
        const row = el.tagName === 'A' ? el.closest('tr') : el;
        const hostEl = row && (row.tagName === 'TR' ? row.cells[0] : row);
        if (!hostEl || seen.has(hostEl)) continue;
        seen.add(hostEl);
        const mint = ((el.getAttribute('href') || '').match(CARD_MINT) || [])[1];
        if (!mint) continue;
        const h = held[mint];
        const key = `${mint}|${h ? h.worth.toFixed(4) + ':' + h.pnl.toFixed(4) : '-'}|${st.qb}|${st.mode}|${st.buyMode}|${usdRate ? 1 : 0}`;
        let c = hostEl.querySelector(':scope > .agtw-c');
        if (hostEl.classList.contains('agtw-held') !== !!h) hostEl.classList.toggle('agtw-held', !!h);
        if (c && c.dataset.k === key) continue;
        if (!c) {
          c = document.createElement('div'); c.className = 'agtw-c';
          if (!positioned.has(hostEl)) { positioned.add(hostEl); if (getComputedStyle(hostEl).position === 'static') hostEl.style.position = 'relative'; }
          hostEl.appendChild(c);
        }
        c.dataset.k = key;
        const cost = h ? h.worth - h.pnl : 0, pct = h && cost > 0 ? (h.pnl / cost) * 100 : null;
        const nW = (st.wallets.live || []).length;
        c.innerHTML = (h ? `<span class="hp ${pct == null ? '' : pct >= 0 ? 'up' : 'dn'}" title="You hold this in ${h.n} ${st.mode} wallet${h.n > 1 ? 's' : ''}">◎ ${sol(h.worth)}${usd(h.worth) ? ' · ' + usd(h.worth) : ''}${pct == null ? '' : ` · ${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`}</span>` : '') +
          (st.qb > 0 ? `<button class="qb ${st.mode === 'live' ? 'live' : ''}" data-qb="${mint}" title="Quick buy ${st.qb} SOL ${st.mode === 'live' && nW > 1 ? (st.buyMode === 'split' ? 'split across ' : '× ') + nW + ' wallets ' : ''}(${st.mode.toUpperCase()})">⚡ ${st.qb}${st.mode === 'live' && nW > 1 ? (st.buyMode === 'split' ? ' ÷' : ' ×') + nW : ''}</button>` : '');
      }
    }
    function startCards() {
      const css = document.createElement('style');
      css.textContent = `
        .agtw-c{position:absolute;right:6px;bottom:6px;z-index:6;display:flex;gap:4px;align-items:center;font:600 10.5px/1.5 Inter,system-ui,sans-serif}
        .agtw-c .hp{background:#0d1117eb;border:1px solid #2b3240;border-radius:5px;padding:0 5px;color:#e5e7eb;white-space:nowrap}
        .agtw-c .hp.up{color:#86efac;border-color:#22c55e88}.agtw-c .hp.dn{color:#fca5a5;border-color:#ef444488}
        .agtw-c .qb{background:#14532d;border:1px solid #22c55e;color:#dcfce7;border-radius:5px;padding:0 6px;cursor:pointer;font:inherit}
        .agtw-c .qb:hover{background:#166534}
        .agtw-c .qb.live{background:#7f1d1d;border-color:#ef4444;color:#fee2e2}
        .agtw-held{box-shadow:inset 3px 0 0 #a3e635}`;
      document.head.appendChild(css);
      // capture phase on window: runs before GMGN's own card click (which would open the token)
      const stop = (e) => { if (e.target.closest && e.target.closest('.agtw-c')) { e.preventDefault(); e.stopImmediatePropagation(); return true; } return false; };
      window.addEventListener('click', (e) => {
        if (!stop(e)) return;
        const b = e.target.closest('.qb');
        if (!b) return;
        const card = b.closest('div[href*="/sol/token/"], tr');
        const symG = card ? (card.innerText || '').trim().split(/\s+/)[0].slice(0, 15) : '';
        buy(st.qb, b.dataset.qb, symG);
      }, true);
      ['mousedown', 'mouseup', 'pointerdown', 'pointerup'].forEach((t) => window.addEventListener(t, stop, true));
      let tm = null;
      const mine = (n) => n.nodeType === 1 && !!(n.matches('.agtw-c,.agtw-toast,#agtw') || n.closest('.agtw-c,#agtw'));
      new MutationObserver((muts) => {
        if (tm || document.hidden) return;
        // ignore mutations we caused ourselves (badge updates), otherwise every scan re-triggers a scan
        if (muts.every((m) => { const ns = [...m.addedNodes, ...m.removedNodes]; return mine(m.target) || (ns.length && ns.every(mine)); })) return;
        tm = setTimeout(() => { tm = null; scanCards(); }, 400);
      }).observe(document.body, { childList: true, subtree: true });
      document.addEventListener('visibilitychange', () => { if (!document.hidden) { scanCards(); loadHeld(); } });
      loadHeld();
    }

    let el;
    function toast(msg, err) {
      const t = document.createElement('div');
      t.className = 'agtw-toast' + (err ? ' err' : ''); t.textContent = msg;
      document.body.appendChild(t); setTimeout(() => t.remove(), 5000);
    }

    // ---------------------------------------------------------- unit-aware orders
    function buyUnitAmt(v) {
      v = Number(v);
      if (!(v > 0)) return;
      if (st.buyUnit === 'pct') return buyPct(v);
      if (st.buyUnit === 'usd') {
        if (!(usdRate > 0)) return toast('No SOL price yet – open the wallet list once', true);
        const multi = st.mode === 'live' && buySel().length > 1;
        return buy(+(v / usdRate).toFixed(4), null, null, `$${v}${multi ? (st.buyMode === 'split' ? ' total' : ' per wallet') : ''} @ SOL $${usdRate.toFixed(2)}`);
      }
      return buy(v);
    }
    // sell a SOL value: the same % in every selected wallet holding the token
    async function sellSol(x) {
      x = Number(x);
      if (!getMint() || !(x > 0) || ui.busy) return;
      await loadPos();
      const w = heldBy().reduce((a, [, h]) => a + (num(h.worthSol) || 0), 0);
      if (!(w > 0)) return toast('No position in the selected wallet(s)', true);
      const pct = Math.min(100, Math.ceil((x / w) * 1000) / 10);
      if (pct >= 100 && st.mode === 'live' && !confirm(`${x} SOL is the whole bag (${sol(w)} SOL). Sell 100%?`)) return;
      return sell(pct);
    }

    // ---------------------------------------------------------- edit in place (✎ → Save)
    const draftKey = (e) => (/^b\d$/.test(e) ? st.buyUnit + ':' + e : /^s\d$/.test(e) ? st.sellUnit + ':' + e : e);
    const dv = (k, def) => { const v = ui.draft && ui.draft[k]; return v != null ? v : def; };
    function startEdit() { ui.edit = true; ui.draft = {}; ui.panel = null; ui.collapsed = false; render(); }
    function captureDraft() { if (el) el.querySelectorAll('[data-e]').forEach((i) => { ui.draft[draftKey(i.dataset.e)] = i.value; }); }
    function saveEdit() {
      captureDraft();
      const p = P(), D = ui.draft || {};
      const bKey = { sol: 'buy', usd: 'usd', pct: 'sup' }, sKey = { pct: 'sell', sol: 'sellSol' };
      const n = (v) => Number(String(v).replace(/[$%◎,\s]/g, '').replace(/k$/i, '000'));
      for (const [k, v] of Object.entries(D)) {
        const m = k.match(/^(sol|usd|pct):([bs])(\d)$/);
        if (m) { const arr = m[2] === 'b' ? p[bKey[m[1]]] : p[sKey[m[1]]]; if (arr) { const x = n(v); arr[+m[3]] = isFinite(x) && x > 0 ? x : 0; } continue; }
        const x = n(v);
        if (k === 'mev') p.mev = v;
        else if (!isFinite(x)) continue;
        else if (k === 'slippage') p.slippage = Math.min(100, Math.max(0, x));
        else if (k === 'fee') p.fee = Math.max(0, x);
        else if (k === 'jitter') st.jitter = Math.min(50, Math.max(0, x));
        else if (k === 'migPct') st.migPct = Math.min(100, Math.max(1, x || 100));
        else if (k === 'protPct') st.protect.pct = Math.min(100, Math.max(1, x || 100));
        else if (k === 'protArm') st.protect.arm = x;
        else if (k === 'protFloor') st.protect.floor = x;
      }
      p.sell = p.sell.map((x) => Math.min(100, x));
      p.sup = p.sup.map((x) => Math.min(20, x));
      ui.edit = false; ui.draft = {}; save();
      if (document.activeElement && el && el.contains(document.activeElement)) document.activeElement.blur(); // render() skips while an input has focus
      render();
      toast(`P${st.preset + 1} saved`);
    }

    // ---------------------------------------------------------- size: every px in the CSS is k × px, so the whole widget
    // (fonts, buttons, spacing, icons in em) scales together. k = your size (corner grip), auto-reduced to fit the screen.
    let curK = 1;
    const scalePx = (css) => css.replace(/(-?\d*\.?\d+)px/g, (_m, n) => `calc(${n} * var(--k))`);
    function setK(k) { curK = k; if (el) el.style.setProperty('--k', k.toFixed(4) + 'px'); }
    function fit() {
      if (!el) return;
      const user = Math.min(1.8, Math.max(0.7, Number(st.scale) || 1));
      let k = user;
      const inn = el.querySelector('.in');
      if (st.autoFit && inn && !ui.collapsed) {
        const nat = inn.scrollHeight / curK; // height at k = 1
        if (nat > 0) k = Math.min(user, Math.max(0.7, (window.innerHeight - 16) / nat));
      }
      if (Math.abs(k - curK) > 0.005) setK(k);
      const r = el.getBoundingClientRect(); // keep it on screen
      if (r.bottom > window.innerHeight && r.top > 8) el.style.top = Math.max(8, window.innerHeight - r.height - 8) + 'px';
      if (r.right > window.innerWidth && r.left > 0) el.style.left = Math.max(0, window.innerWidth - r.width - 4) + 'px';
    }

    // ---------------------------------------------------------- render
    let rq = 0;
    // coalesce bursts of render() calls (data + clicks + timers) into one per animation frame
    function render() { if (!rq) rq = requestAnimationFrame(() => { rq = 0; render0(); }); if (document.hidden) { cancelAnimationFrame(rq); rq = 0; render0(); } }
    // In-place DOM patch: update only what changed, keep the existing nodes. Streaming re-renders several times a
    // second, and replacing innerHTML used to reset scroll positions (wallet list), hover states, a click in progress
    // and whatever you were typing. Nodes are matched by position + tag, which is stable for this layout.
    const tpl = document.createElement('template');
    function patch(root, html) { tpl.innerHTML = html; morphKids(root, tpl.content); }
    function morphKids(from, to) {
      const fc = [...from.childNodes], tc = [...to.childNodes];
      for (let i = 0; i < tc.length; i++) {
        const f = fc[i], t = tc[i];
        if (!f) from.appendChild(t.cloneNode(true));
        else if (f.nodeType !== t.nodeType || f.nodeName !== t.nodeName) from.replaceChild(t.cloneNode(true), f);
        else if (f.nodeType !== 1) { if (f.nodeValue !== t.nodeValue) f.nodeValue = t.nodeValue; }
        else morphEl(f, t);
      }
      for (let i = fc.length - 1; i >= tc.length; i--) from.removeChild(fc[i]);
    }
    function morphEl(f, t) {
      for (const a of [...f.attributes]) if (!t.hasAttribute(a.name)) f.removeAttribute(a.name);
      for (const a of [...t.attributes]) if (f.getAttribute(a.name) !== a.value) f.setAttribute(a.name, a.value);
      if (f.tagName === 'INPUT') {
        if (f.type === 'checkbox') f.checked = t.hasAttribute('checked');
        else if (f !== document.activeElement) { const v = t.getAttribute('value') || ''; if (f.value !== v) f.value = v; } // never touch what you're typing
      }
      morphKids(f, t);
      if (f.tagName === 'SELECT') { const o = t.querySelector('option[selected]'); if (o) f.value = o.value || o.textContent; }
    }

    function render0() {
      if (!el) return;
      const ae0 = document.activeElement, typing = ae0 && el.contains(ae0) && ae0.tagName === 'SELECT'; // an open <select> would close
      if (typing) return;
      const html = ui.collapsed ? collapsedHtml() : fullHtml();
      const full = `<div class="in">${html}</div>${modalHtml()}<div class="rz" title="Drag to resize · double-click to reset"></div>`;
      if (full !== el.__html) { el.__html = full; patch(el, full); el.classList.toggle('col', ui.collapsed); fit(); }
      el.classList.toggle('col', ui.collapsed);
    }

    function collapsedHtml() {
      const mint = getMint(), sm = summary(), live = st.mode === 'live', p = P(), unit = st.buyUnit;
      const vals = (unit === 'pct' ? p.sup : unit === 'usd' ? p.usd : p.buy).filter((a) => a > 0).slice(0, 2);
      const dis = !mint || ui.busy ? 'disabled' : '';
      const pn = sm && sm.pnl != null ? sm.pnl : null;
      const al = loadAlerts().filter((a) => !ui.alertsGone[a.id]).length;
      return `<div class="cb h"><i class="dot" style="background:${live ? '#F05252' : 'var(--paper)'}" title="${live ? 'LIVE' : 'PAPER'}"></i>
        <span class="cn"><b>${escH(mint ? sym || tail(mint) : 'AG ⚡')}</b><span class="n sm ${pn == null ? 'mut' : pn >= 0 ? 'up' : 'dn'}">${sm && sm.bal ? '◎ ' + sol(sm.bal) : '—'}${pn != null ? ' · ' + (pn >= 0 ? '+' : '') + pn.toFixed(1) + '%' : ''}</span></span>
        ${al ? `<button class="alb" data-a="col" title="${al} alert${al > 1 ? 's' : ''}">${al}</button>` : ''}
        <span class="sp"></span>${vals.map((a) => `<button class="t b mini n" data-bu="${a}" ${dis}>${unitLab(a, unit)}</button>`).join('')}
        <button class="t s mini n" data-su2="50" ${dis}>50%</button><button class="si mini" data-a="sinit" ${dis}>Init</button>
        <button class="ib" data-a="col" title="Expand">${ICON.max}</button></div>`;
    }

    // exit strategy: preview of what 1 ◎ becomes if every TP fills (amounts are % of the original bag)
    function stratPreview(s) {
      const lv = (s.levels || []).filter((l) => Number(l.p) > 0 && Number(l.a) > 0);
      const tps = lv.filter((l) => l.t !== 'SL'), sl = lv.find((l) => l.t === 'SL');
      const tpSum = tps.reduce((a, l) => a + Number(l.a), 0);
      if (!tps.length && !sl) return '';
      const out = tps.reduce((a, l) => a + (Number(l.a) / 100) * (1 + Number(l.p) / 100), 0) + Math.max(0, 1 - tpSum / 100) * (1 + (tps.length ? Number(tps[tps.length - 1].p) : 0) / 100);
      return `<div class="pv2 n"><span>1 ◎ in →</span>${tps.length ? `<b class="up">+${sol(out - 1)} ◎ if every TP fills</b>` : ''}${sl ? `<b class="dn">${tps.length ? '· ' : ''}worst −${sol(Number(sl.p) / 100)} ◎</b>` : ''}</div>${tpSum > 100 ? '<div class="dn sm">TP sell amounts add up to more than 100% of the bag.</div>' : ''}`;
    }
    function advHtml(mint, orders) {
      const strats = st.strats, s = strats.find((x) => x.id === st.stratId), ed = ui.stratEdit;
      const relayOff = env !== 'ag' && Date.now() - (GM_getValue('agRelayAt', 0) || 0) > 30000;
      let body;
      if (ed) {
        body = `<div class="sel"><input class="n nm" data-se="name" value="${escH(ed.name)}" aria-label="Strategy name" placeholder="Name">
          ${ed.levels.map((l, i) => `<div class="lvr"><select data-se="t:${i}" aria-label="Level type"><option ${l.t === 'TP' ? 'selected' : ''}>TP</option><option ${l.t === 'SL' ? 'selected' : ''}>SL</option></select>
            <label class="lf ${l.t === 'SL' ? 'dn' : 'up'}">${l.t === 'SL' ? '−' : '+'}<input class="n" data-se="p:${i}" value="${escH(l.p)}" aria-label="Trigger %">%</label>
            <label class="lf">sell<input class="n" data-se="a:${i}" value="${escH(l.a)}" aria-label="Sell % of the bag">%</label>
            <button class="xx" data-a="lvdel" data-i="${i}" aria-label="Remove level">×</button></div>`).join('')}
          <div class="sh"><button class="btn sm" data-a="lvadd" data-t="TP">+ TP</button><button class="btn sm" data-a="lvadd" data-t="SL">+ SL</button><span class="sp"></span></div>
          <label class="adv"><input type="checkbox" data-se="be" ${ed.be ? 'checked' : ''}>Stop-loss → break-even after TP1 <span class="tagb">browser</span></label>
          <label class="adv">Trailing stop <input class="n tiny" data-se="trail" value="${escH(ed.trail || 0)}" aria-label="Trailing %">% from peak (0 = off) <span class="tagb">browser</span></label>
          ${stratPreview(ed)}
          <div class="sh"><button class="btn sm ghost" data-a="sdel">Delete</button><span class="sp"></span><button class="btn sm" data-a="scancel">Cancel</button><button class="btn sm pri" data-a="ssave">Save</button></div></div>`;
      } else if (s) {
        body = `<div class="lvl">${(s.levels || []).map((l) => `<span class="lvc ${l.t === 'SL' ? 'sl' : 'tp'}"><b>${l.t}</b> <span class="n">${l.t === 'SL' ? '−' : '+'}${l.p}%</span> <span class="mut">sell ${l.a}%</span></span>`).join('')}
          ${s.be ? '<span class="lvc br">SL→BE after TP1</span>' : ''}${Number(s.trail) ? `<span class="lvc br">trail −${s.trail}%</span>` : ''}</div>${stratPreview(s)}
          <div class="mut sm">Attached to every buy (and to dip / DCA triggers). AG runs the TP / SL, so they keep working with Chrome closed.</div>`;
      } else body = '<div class="mut sm">No strategy: buys go in without TP / SL. Pick one to attach it to every buy.</div>';
      const sv = srv.mint === mint && srv.list;
      const onAg = !mint ? '' : sv == null ? '<span class="mut sm">checking AG…</span>'
        : !sv.length ? '<span class="mut sm">No open position on AG for this coin.</span>'
        : (() => { const p0 = sv[0], lv = openLevels(p0); return `<span class="sm">${sv.length} position${sv.length > 1 ? 's' : ''} · ${lv.length ? lv.map((x) => `${x.type === 'STOP_LOSS' ? 'SL −' : 'TP +'}${x.percentage}% <span class="mut">(${x.amountPct}%)</span>`).join(' · ') : '<span class="mut">no TP / SL</span>'}</span>`; })();
      const tokO = mint ? orders.filter((o) => o.mint === mint && ['mig', 'miginit', 'protect', 'exitx'].includes(o.type) && (o.status === 'active' || Date.now() - (o.doneAt || 0) < 600e3)) : [];
      return `<div class="ax"><div class="sh"><span class="sm2">Exit strategy</span>
          <select data-s="stratId" aria-label="Exit strategy"><option value="">None</option>${strats.map((x) => `<option value="${x.id}" ${x.id === st.stratId ? 'selected' : ''}>${escH(x.name)}</option>`).join('')}</select>
          ${ed ? '' : `<button class="ib" data-a="sedit" title="${s ? 'Edit this strategy' : 'New strategy'}">${s ? ICON.edit : ICON.plus}</button>`}<span class="sp"></span><span class="srvb" title="TP / SL levels are stored on AG's server">${ICON.server}AG server</span></div>
        ${body}
        ${mint && !ed ? `<div class="onag"><span class="lb">ON AG NOW</span>${onAg}<span class="sp"></span>${s && sv && sv.length ? `<button class="btn sm" data-a="sapply" title="Replace the TP / SL of your open position(s) with “${escH(s.name)}”">Apply to position</button>` : ''}</div>` : ''}
        <div class="sep2"></div>
        <div class="sh"><span class="sm2">Browser exits</span><span class="sp"></span>${relayOff ? '<span class="dn sm">open the backtester tab to run them</span>' : '<span class="mut sm">run in the backtester tab</span>'}</div>
        <div class="g3"><button class="yb" data-a="omig" ${mint ? '' : 'disabled'} title="Sell ${st.migPct}% when the coin migrates">${st.migPct}% @ Mig</button>
        <button class="yb" data-a="oinit" ${mint ? '' : 'disabled'} title="Sell initials when the coin migrates">Init @ Mig</button>
        <button class="yb" data-a="oprot" ${mint ? '' : 'disabled'} title="After +${st.protect.arm}%, sell ${st.protect.pct}% if it falls back to +${st.protect.floor}%">Protect ${st.protect.arm}→${st.protect.floor}</button></div>
        ${tokO.map((o) => oRow(o, false)).join('')}</div>`;
    }

    function fullHtml() {
      const mint = getMint(), p = P(), live = st.mode === 'live', sm = summary(), orders = loadOrders(), bsel = buySel();
      const selN = live ? bsel.length : bsel.length || 'all', nW = live ? bsel.length : 1;
      const dis = !mint || ui.busy ? 'disabled' : '';
      const unit = st.buyUnit, split = st.buyMode === 'split', ed = ui.edit, act = orders.filter((o) => o.status === 'active').length;
      const kb = st.hotkeys !== 'off' && st.kbHints;
      const S = SF();

      // groups row: All / Main / your groups / +   (= the wallets you BUY with)
      const allA = wallets.map((w) => w.address).filter(Boolean), mainA = (wallets.find((w) => w.isMain) || {}).address;
      const chip = (gid, name, n, on, title) => `<button class="gc ${on ? 'on' : ''}" data-g="${gid}" title="${escH(title || '')}">${escH(name)}${n ? ` <span class="n">· ${n}</span>` : ''}</button>`;
      const groupsRow = `<div class="gr">${allA.length ? chip('__all', 'All', allA.length, sameSet(bsel, allA), 'Every wallet') : ''}${mainA ? chip('__main', 'Main', 0, sameSet(bsel, [mainA]), labelOf(mainA)) : ''}${groupsHere().map((g) => chip(g.id, g.name, g.wallets.length, sameSet(bsel, g.wallets), g.wallets.map(labelOf).join(', '))).join('')}<button class="gc add" data-w="gsave" title="Save the current selection as a group">+</button></div>`;

      const nPos = Object.keys(heldAll).length;
      const head = ed
        ? `<div class="hd h edit"><b class="acc">Editing P${st.preset + 1}</b><span class="mut sm">click a value to change it</span><span class="sp"></span><button class="btn" data-a="ecancel">Cancel</button><button class="btn pri" data-a="esave">${ICON.check}Save</button></div>`
        : `<div class="hd h"><button class="md ${live ? 'live' : 'paper'}" data-a="mode" title="Switch paper / LIVE${kb ? ' (L)' : ''}">● ${live ? 'LIVE' : 'PAPER'}</button>
          <button class="btn ${ui.panel === 'wal' ? 'on' : ''}" data-a="p:wal" title="Wallets you buy with">${ICON.wallet}<span class="n">${selN}</span>${ICON.down}</button>
          <span class="ps">${[0, 1, 2].map((i) => `<button class="${st.preset === i ? 'on' : ''}" data-p="${i}" title="Preset P${i + 1}${kb ? ' (Alt+' + (i + 1) + ')' : ''}">P${i + 1}</button>`).join('')}</span>
          <span class="sp"></span>
          <button class="ib" data-a="edit" title="Edit preset values in place">${ICON.edit}</button>
          <button class="ib ord ${act ? 'has' : ''} ${ui.panel === 'trig' ? 'on' : ''}" data-a="p:trig" title="Triggers & auto orders">${ICON.bolt}${act ? `<span class="n">${act}</span>` : ''}</button>
          <button class="ib ${ui.panel === 'pos' ? 'on' : ''}" data-a="p:pos" title="Positions (all coins)">${ICON.list}${nPos ? `<span class="n">${nPos}</span>` : ''}</button>
          <button class="ib ${ui.panel === 'set' ? 'on' : ''}" data-a="p:set" title="Settings">${ICON.gear}</button>
          <button class="ib" data-a="col" title="Collapse${kb ? ' (C)' : ''}">${ICON.min}</button></div>`;

      const mu = mint ? mcapNow(mint) : null, cp = mint ? curvePct(mint) : null, tk = mint && ticks[mint], lv = isLive(mint);
      const tokLine = mint
        ? `<div class="tk"><b>${escH(sym || 'Token')}</b><span class="mut n sm">${tail(mint)}</span><button class="ib" data-cpm="${mint}" title="Copy mint">${ICON.copy}</button><button class="ib ${ui.panel === 'info' ? 'on' : ''}" data-a="p:info" title="Coin info: AG profile, your trades, connection">${ICON.info}</button><span class="sp"></span>
          ${ui.busy ? `<span class="busy">${escH(ui.busy)}…</span>` : ''}${lv ? `<span class="lvd" title="Live price · ${tk.src === 'gmgn' ? 'GMGN stream' : 'AG stream'}"></span>` : ''}${mu ? `<span class="n mc ${lv && tk.dir > 0 ? 'up' : lv && tk.dir < 0 ? 'dn' : ''}" title="Market cap">$${kfmt(mu)}</span>` : ''}${cp != null ? `<span class="cv" title="Bonding curve (estimated)"><i style="width:${cp.toFixed(0)}%"></i></span><span class="mut n sm">${cp >= 100 ? 'migr.' : cp.toFixed(0) + '%'}</span>` : ''}</div>`
        : '<div class="tk mut">Open a token to trade</div>';

      // ---- buy
      const vals = unit === 'pct' ? p.sup : unit === 'usd' ? p.usd : p.buy;
      const each = live && nW > 1 && !split;
      const tileSol = (a) => (unit === 'pct' ? (mint && pctToSol(a, mint) || {}).sol : unit === 'usd' ? (usdRate ? (a / usdRate) * (each ? nW : 1) : null) : a * (each ? nW : 1));
      const capRoom = live && S.maxPerCoin > 0 && mint ? S.maxPerCoin - coinCost(mint) : null;
      const tile = (a, i) => {
        const tot = tileSol(a), imp = live && mint && tot ? buyImpact(tot, mint) : null;
        const hot = (imp && imp.impact >= S.impactWarn) || (capRoom != null && tot > capRoom + 1e-9);
        let s = unit === 'sol' && !each ? '' : tot ? `${each ? 'Σ' : ''}${sol(tot)}◎` : '—';
        if (imp && imp.impact >= 1) s = (s ? s + ' ' : '') + `<b class="ip">+${imp.impact.toFixed(imp.impact >= 10 ? 0 : 1)}%</b>`;
        const title = [imp ? `price impact +${imp.impact.toFixed(1)}%` : '', capRoom != null && tot > capRoom ? 'over your per-coin cap' : '', kb ? `hotkey ${i + 1}` : ''].filter(Boolean).join(' · ');
        return `<button class="t b ${s ? 'two' : ''} ${hot ? 'hot' : ''}" data-bu="${a}" ${dis} title="${escH(title)}">${kb ? `<i class="kb">${i + 1}</i>` : ''}<span class="n">${unitLab(a, unit)}</span>${s ? `<small class="n">${s}</small>` : ''}</button>`;
      };
      const seg = `<span class="seg">${[['sol', '◎', 'Buy in SOL'], ['usd', '$', 'Buy in USD (converted at AG’s SOL price)'], ['pct', '%', 'Buy a % of the token supply']]
        .map(([k, l, t]) => `<button class="${unit === k ? 'on' : ''}" data-bunit="${k}" title="${t}${kb ? ' (U cycles)' : ''}">${l}</button>`).join('')}</span>`;
      const splitChip = live && nW > 1 ? `<button class="sc" data-a="bmode" title="${split ? 'The amount is the TOTAL, divided across the wallets. Click for per wallet.' : 'Every wallet buys the amount. Click to split the total instead.'}${kb ? ' (S)' : ''}">${split ? '÷ split' : '× each'} <span class="n">${nW}</span></button>` : '';
      const balSel = live ? bsel.reduce((a, w) => a + (balOf(w) || 0), 0) : null;
      const strat = buyStrat();
      const buyHead = `<div class="sh"><span class="st">Buy</span>${seg}${splitChip}${strat ? `<span class="stb" title="Exit strategy attached to buys">${ICON.server}${escH(strat.name)}</span>` : ''}<span class="sp"></span>${live ? `<span class="n hv" title="SOL in the wallets you buy with">◎ ${sol(balSel)}</span>` : '<span class="mut sm">→ main paper wallet</span>'}</div>`;
      const buyTiles = ed
        ? vals.slice(0, 8).map((a, i) => `<input class="n ei b" data-e="b${i}" value="${escH(dv(unit + ':b' + i, a || ''))}" aria-label="Buy preset ${i + 1}">`).join('')
        : vals.slice(0, 8).filter((a) => a > 0).map(tile).join('');

      // ---- sell (auto: the wallets holding this coin)
      const held = heldBy(), heldW = held.reduce((a, [, h]) => a + (num(h.worthSol) || 0), 0);
      const plans = held.map(([, h]) => initPlan(h)).filter((x) => !x.skip);
      const initP = plans.length ? +(plans.reduce((a, x) => a + x.pct, 0) / plans.length).toFixed(1) : null;
      const sUnit = st.sellUnit, svals = sUnit === 'sol' ? p.sellSol : p.sell;
      const te = heldW > 0 ? tokEst(heldW) : null;
      const sellHead = `<div class="sh"><span class="st">Sell</span><button class="sw" data-a="sunit" title="${sUnit === 'sol' ? 'Selling SOL amounts. Click for %' : 'Selling % of the bag. Click for SOL amounts'}">${sUnit === 'sol' ? '◎' : '%'}${ICON.swap}</button>
        ${ui.autoSel ? `<button class="at" data-w="noauto" title="Sells use the ${ui.autoSel.length} wallet(s) holding this coin. Click to sell from your own selection instead.">auto · ${ui.autoSel.length} holder${ui.autoSel.length > 1 ? 's' : ''}</button>` : ''}<span class="sp"></span>
        ${heldW > 0 ? `<span class="hv n">${te != null ? kfmt(te) + '<i>|</i>' : ''}${usdS(heldW) ? usdS(heldW) + '<i>|</i>' : ''}◎ ${sol(heldW)}</span>` : '<span class="mut sm">no position</span>'}</div>`;
      const sellTiles = ed
        ? svals.slice(0, 8).map((a, i) => `<input class="n ei s" data-e="s${i}" value="${escH(dv(sUnit + ':s' + i, a || ''))}" aria-label="Sell preset ${i + 1}">`).join('')
        : svals.slice(0, 8).filter((a) => a > 0).map((a, i) => `<button class="t s" data-su="${a}" ${dis || (heldW > 0 ? '' : 'disabled')} ${kb ? `title="hotkey Shift+${i + 1}"` : ''}>${kb ? `<i class="kb">⇧${i + 1}</i>` : ''}<span class="n">${sUnit === 'sol' ? a + ' ◎' : a + '%'}</span></button>`).join('');

      const mev = p.mev === 'DISABLED' ? 'Off' : p.mev.charAt(0) + p.mev.slice(1).toLowerCase();
      const txLine = (side) => `<div class="tl"><span title="Slippage">${ICON.slip}<span class="n">${p.slippage}%</span></span><span title="Priority fee (SOL)">${ICON.gas}<span class="n">${p.fee}</span></span><span title="MEV protection">${ICON.shield}${mev}</span>
        ${side === 'buy' && live && nW > 1 && (Number(st.jitter) || Number(st.stagger)) ? `<span class="vi" title="Jitter / stagger between wallets">${ICON.wave}<span class="n">${Number(st.jitter) ? '±' + st.jitter + '%' : ''}${Number(st.jitter) && Number(st.stagger) ? ' · ' : ''}${Number(st.stagger) ? st.stagger + 'ms' : ''}</span></span>` : ''}
        <span class="sp"></span>${side === 'buy'
          ? `<label class="adv" title="Exit strategy (TP / SL on AG) and browser exits"><input type="checkbox" data-s="adv" ${st.adv ? 'checked' : ''}>Adv.</label>`
          : `<button class="si" data-a="sinit" ${dis || (heldW > 0 ? '' : 'disabled')} title="Sell just enough to take out what you put in, per wallet${kb ? ' (X)' : ''}">Sell Init.${initP != null ? ` <span class="n">${initP}%</span>` : ''}</button>`}</div>`;
      const inp = (k, label, val) => `<label>${label}<input class="n" data-e="${k}" value="${escH(dv(k, val))}"></label>`;
      const edBuy = `<div class="eg">${inp('slippage', 'Slippage %', p.slippage)}${inp('fee', 'Priority ◎', p.fee)}<label>MEV<select data-e="mev">${['JITO', 'HELIUS', 'DISABLED'].map((m) => `<option ${dv('mev', p.mev) === m ? 'selected' : ''}>${m}</option>`).join('')}</select></label>${inp('jitter', 'Jitter ±%', st.jitter)}</div>`;
      const edSell = `<div class="eg">${inp('migPct', 'Sell @ mig %', st.migPct)}${inp('protArm', 'Protect arm +%', st.protect.arm)}${inp('protFloor', 'Sell back ≤ +%', st.protect.floor)}${inp('protPct', 'Protect sell %', st.protect.pct)}</div>`;
      const cu = ed ? '' : `<div class="cu"><input class="n" type="number" step="any" min="0" data-a="camt" placeholder="Custom ${unit === 'pct' ? '% of supply' : unit === 'usd' ? 'USD' : 'SOL'}${live && nW > 1 ? (split ? ' · total' : ' · each') : ''}${kb ? '  (/)' : ''}"><button class="btn bb" data-a="cbuy" ${dis}>Buy</button></div>`;

      // ---- footer: holding / bought / sold / avg entry (SOL + USD) and the PnL card
      const pnlS = sm ? sm.pnlSol : null;
      const stat = (k, v, cls) => `<div class="sb"><span class="lb">${k}</span><span class="n v ${v ? cls || '' : ''}">${v == null ? '--' : '◎ ' + sol(v)}</span><span class="n u">${v == null ? '' : usdS(v)}</span></div>`;
      const unreal = pos ? Object.values(livePos()).reduce((a, h) => a + (num(h.pnlSol) || 0), 0) : null;
      const realized = trades && pnlS != null && unreal != null ? pnlS - unreal : null;
      let eW = 0, eS = 0;
      for (const [, h] of held) { const m = num(h.avgEntryMcap), c = costOf(h) || num(h.worthSol) || 0; if (m > 0 && c > 0) { eW += m * c; eS += c; } }
      const entry = eS ? eW / eS : null;
      const sgn = (v) => (v >= 0 ? '+' : '');
      const foot = `<div class="ft"><div class="g3s">${stat('HOLDING', sm ? sm.bal : null)}${stat('BOUGHT', sm ? sm.bought : null, 'up')}${stat('SOLD', sm ? sm.sold : null, 'dn')}<div class="sb" title="Average entry market cap of the open positions (cost-weighted, from AG)"><span class="lb">AVG ENTRY</span><span class="n v">${entry ? '$' + kfmt(entry) : '--'}</span><span class="n u ${entry && mu ? (mu >= entry ? 'up' : 'dn') : ''}">${entry && mu ? (mu / entry).toFixed(2) + '× now' : ''}</span></div></div>
        <div class="pc ${pnlS == null ? '' : pnlS >= 0 ? 'pos' : 'neg'}"><div><span class="lb">PNL${pnlS != null ? (lv ? ' <span class="lvt">● LIVE</span>' : posRef ? ` <span class="syn">· synced ${Math.max(0, Math.round((Date.now() - posRef.at) / 1000))}s ago</span>` : '') : ''}</span><div class="pv">
          <span class="n big">${pnlS == null ? '--' : usdRate ? sgn(pnlS) + usdV(pnlS * usdRate) : sgn(pnlS) + sol(pnlS) + ' ◎'}</span>
          ${pnlS != null && usdRate ? `<span class="n">${pnlS >= 0 ? '+' : '−'}◎ ${sol(Math.abs(pnlS))}</span>` : ''}</div></div><span class="sp"></span>
          ${sm && sm.pnl != null ? `<span class="pill n">${sgn(sm.pnl)}${sm.pnl.toFixed(1)}%</span><button class="ib shb" data-a="p:share" title="Share this PnL as an image">${ICON.share}</button>` : ''}</div>
        <div class="dl">${realized != null && Math.abs(realized) > 1e-6 ? `<span>Realized</span><span class="n">${usdRate ? sgn(realized) + usdV(realized * usdRate) : sol(realized) + ' ◎'}</span><i>·</i>` : ''}${live && S.dailyLoss > 0 && daily && daily.sum != null ? `<span title="Positions closed today vs your daily loss limit">Today</span><span class="n ${daily.sum < 0 ? 'dn' : 'up'}">${sgn(daily.sum)}${sol(daily.sum)} / −${S.dailyLoss} ◎</span>` : ''}<span class="sp"></span>${usdRate ? `<span>SOL</span><span class="n">$${usdRate.toFixed(1)}</span>` : ''}</div></div>`;

      const panel = ed ? '' : ui.panel === 'wal' ? pickerHtml() : ui.panel === 'set' ? settingsHtml() : ui.panel === 'trig' ? trigHtml(orders) : ui.panel === 'pos' ? posHtml(orders) : ui.panel === 'info' ? infoHtml() : ui.panel === 'share' ? shareHtml() : '';
      return `${groupsRow}${head}${panel}${ed ? '' : alertsHtml()}
        <div class="bd">${tokLine}
          <div class="sec">${buyHead}<div class="g4">${buyTiles}</div>${ed ? edBuy : txLine('buy')}${cu}</div>
          ${!ed && st.adv ? advHtml(mint, orders) : ''}
          <div class="sep"></div>
          <div class="sec">${sellHead}<div class="g4">${sellTiles}</div>${ed ? edSell : txLine('sell')}</div></div>
        ${ed ? '<div class="eh mut sm">Tab → next value · Enter saves · Esc cancels · empty a slot to hide it. ◎ / $ / % each keep their own 8 values.</div>' : foot}`;
    }

    function pickerHtml() {
      const live = st.mode === 'live', mint = getMint(), sel = buySel(), symN = sym || 'token';
      let list = wallets.slice();
      if (ui.filt.sol) list = list.filter((w) => (num(w.balanceSol) || 0) > (Number(st.reserve) || 0));
      if (ui.filt.tok) list = list.filter((w) => pos && pos[w.address]);
      const allOn = wallets.length && wallets.every((w) => !w.address || sel.includes(w.address));
      const tipTxt = ui.plan ? PLAN_INFO[ui.plan.kind](symN) : live ? 'Ticked = wallets you buy with · sells auto-use the holders of the coin' : 'Paper: the selection applies to sells & auto orders (none = all)';
      const tool = (k, icon, needTok) => `<button class="ib tb ${ui.plan && ui.plan.kind === k ? 'on' : ''}" data-plan="${k}" title="${escH(PLAN_INFO[k](symN))}" ${!live || (needTok && !mint) ? 'disabled' : ''}>${icon}</button>`;
      const rows = list.map((w) => {
        const a = w.address || '', h = pos && pos[a], on = sel.includes(a), b = num(w.balanceSol);
        return `<label class="wr ${on ? '' : 'off'}"><span class="av">${escH(ini(a))}</span><span class="wn"><b>${escH(w.label || 'Wallet')}${w.isMain ? ' <span class="acc sm">★</span>' : ''}</b><span class="n mut sm">${tail(a)}</span></span><span class="sp"></span>
          <span class="n c1">${b != null ? sol(b) + ' ◎' : '--'}</span><span class="n c2 ${h ? ((num(h.pnlPct) || 0) >= 0 ? 'up' : 'dn') : 'mut'}" title="${h ? escH(`${sol(num(h.worthSol))} SOL · ${(num(h.pnlPct) || 0).toFixed(1)}%`) : ''}">${h ? tokFmt(num(h.worthSol)) : '0'}</span>
          <input type="checkbox" data-wa="${escH(a)}" ${on ? 'checked' : ''} ${a ? '' : 'disabled'} aria-label="Buy with ${escH(w.label || 'wallet')}"></label>`;
      }).join('');
      let planHtml = '';
      if (ui.plan) {
        const pl = buildPlan(), k = ui.plan.kind, psel = k.startsWith('tok') ? selected() : sel;
        if (pl.err) planHtml = `<div class="pbx"><div class="sh"><span class="mut">${escH(pl.err)}</span><span class="sp"></span><button class="btn sm" data-a="planx">Close</button></div></div>`;
        else {
          const dsel = k === 'tokCons' || k === 'solCons' ? `<select data-f="dest" class="ds">${psel.map((w) => `<option value="${escH(w)}" ${pl.dest === w ? 'selected' : ''}>${escH(labelOf(w))}</option>`).join('')}</select>` : '';
          const title = k === 'tokSplit' ? `Split ${escH(symN)} · ${tokFmt(pl.total)}` : k === 'tokCons' ? `Move ${escH(symN)} →` : k === 'solEven' ? `Even out · ≈${sol(pl.target)} ◎ each` : 'Sweep SOL →';
          planHtml = `<div class="pbx"><div class="sh"><b>${title}</b>${dsel}<span class="sp"></span><span class="mut sm n">${pl.tx.length} transfer${pl.tx.length === 1 ? '' : 's'}</span></div>
            ${pl.tx.slice(0, 6).map((t) => `<div class="tr"><button class="lk" data-cp="${escH(t.from)}" title="Copy ${escH(t.from)}">${escH(labelOf(t.from))}</button>${ICON.arrow}<button class="lk" data-cp="${escH(t.to)}" title="Copy ${escH(t.to)}">${escH(labelOf(t.to))}</button><span class="sp"></span><span class="n">${pl.unit === 'tok' ? `${tokFmt(t.amt)} <span class="mut">· ${sol(t.amt)} ◎</span>` : t.amt + ' ◎'}</span></div>`).join('') || '<div class="up sm">Already balanced – nothing to move.</div>'}
            ${pl.tx.length > 6 ? `<div class="mut sm">+${pl.tx.length - 6} more in the copied plan</div>` : ''}
            <div class="g3"><button class="btn" data-a="plancp" ${pl.tx.length ? '' : 'disabled'}>Copy plan</button>${k === 'tokSplit' ? '<button class="btn" data-a="reroll">Reroll</button>' : '<button class="btn" data-a="planx">Close</button>'}<button class="btn pri" disabled title="AG exposes no wallet-to-wallet transfer endpoint yet. Share AG’s withdraw request and this gets wired up.">Run ${pl.tx.length}</button></div>
            <div class="mut sm">Click a wallet name to copy its address.</div></div>`;
        }
      }
      return `<div class="wp pnl"><div class="tip">${escH(tipTxt)}</div>
        <div class="wt">${tool('tokCons', ICON.cons, true)}${tool('tokSplit', ICON.split, true)}${tool('solEven', ICON.even)}${tool('solCons', ICON.sweep)}<span class="sp"></span>
          <button class="btn sm" data-w="${allOn ? 'none' : 'all'}">${allOn ? 'Unselect all' : 'Select all'}</button>
          <button class="btn sm ${ui.filt.sol ? 'on' : ''}" data-w="fsol" title="Only wallets with SOL above the reserve">w/SOL</button>
          ${mint ? `<button class="btn sm ${ui.filt.tok ? 'on' : ''}" data-w="ftok" title="Only wallets holding this token">w/${escH(symN.slice(0, 9))}</button>` : ''}
          <button class="ib" data-w="reload" title="Refresh balances">${ICON.refresh}</button></div>
        ${ui.autoSel ? `<div class="note">Sells use the ${ui.autoSel.length} wallet(s) holding ${escH(symN)}. <button class="lk" data-w="noauto">Sell from my selection instead</button></div>` : ''}
        ${walletErr ? `<div class="note dn">${escH(walletErr)}</div>` : ''}
        <div class="wh"><span>Wallet</span><span class="sp"></span><span class="c1">SOL</span><span class="c2">${escH(symN.slice(0, 9))}</span><span style="width:15px"></span></div>
        <div class="wl2">${rows || `<div class="mut sm" style="padding:10px 12px">${wallets.length ? 'No wallet matches the filter.' : 'Loading wallets…'}</div>`}</div>
        <div class="gsv"><button class="btn sm" data-w="gsave">＋ Save selection as group</button>${groupsHere().map((g) => `<span class="gt">${escH(g.name)}<button class="xx" data-gd="${g.id}" aria-label="Delete group ${escH(g.name)}">×</button></span>`).join('')}</div>
        ${planHtml}</div>`;
    }

    function trigHtml(orders) {
      const mint = getMint(), f = ui.tf, mc = mint ? mcapNow(mint) : null, lv = isLive(mint);
      const entry = (() => { let eW = 0, eS = 0; for (const [, h] of heldBy()) { const m = num(h.avgEntryMcap), c = costOf(h) || 0; if (m > 0 && c > 0) { eW += m * c; eS += c; } } return eS ? eW / eS : null; })();
      const tgt = parseMc(f.target);
      const tabs = [['dip', 'Dip buy'], ['tp', 'Take profit'], ['trail', 'Trailing'], ['dca', 'DCA']];
      const quick = f.tab === 'dip' ? [[-10, '−10%'], [-20, '−20%'], [-30, '−30%'], ['e', 'entry']] : [[50, '+50%'], [100, '+100%'], [200, '+200%'], ['e2', '2× entry']];
      const qv = (q) => (q === 'e' ? entry : q === 'e2' ? (entry ? entry * 2 : null) : mc ? mc * (1 + q / 100) : null);
      const dist = mc && tgt > 0 ? ((tgt / mc - 1) * 100) : null;
      const f$ = (k, label, val, ph) => `<label>${label}<input class="n" data-tf="${k}" value="${escH(val)}" placeholder="${ph || ''}"></label>`;
      let form;
      if (f.tab === 'dip' || f.tab === 'tp') {
        const lo = Math.min(...[mc, tgt, entry].filter((x) => x > 0)), hi = Math.max(...[mc, tgt, entry].filter((x) => x > 0));
        const pos = (v) => (hi > lo ? 6 + ((v - lo) / (hi - lo)) * 88 : 50);
        form = `<label class="big">${f.tab === 'dip' ? 'Buy when the market cap drops to' : 'Sell when the market cap reaches'}
            <span class="tin ${tgt > 0 ? 'on' : ''}"><span class="n mut">${f.tab === 'dip' ? '≤' : '≥'} $</span><input class="n" data-tf="target" value="${escH(f.target)}" placeholder="${mc ? kfmt(mc * (f.tab === 'dip' ? 0.7 : 2)) : '14K'}" aria-label="Target market cap">${dist != null ? `<span class="n ${dist < 0 ? 'dn' : 'up'}">${dist > 0 ? '+' : ''}${dist.toFixed(1)}%</span>` : ''}</span></label>
          <div class="g4">${quick.map(([q, l]) => `<button class="btn sm qk" data-tq="${q}" ${qv(q) ? '' : 'disabled'}>${l}</button>`).join('')}</div>
          ${mc && tgt > 0 ? `<div class="tbar"><i class="ln"></i><i class="zone ${f.tab}" style="left:${Math.min(pos(mc), pos(tgt))}%;width:${Math.abs(pos(mc) - pos(tgt))}%"></i>
            <i class="mk tg" style="left:${pos(tgt)}%"></i><span class="n lbl tg" style="left:${pos(tgt)}%">${mc$(tgt)}</span>
            <i class="mk now" style="left:${pos(mc)}%"></i><span class="n lbl now" style="left:${pos(mc)}%">now ${mc$(mc)}</span>
            ${entry ? `<span class="n lbl en" style="left:${pos(entry)}%">entry ${mc$(entry)}</span>` : ''}</div>` : ''}
          <div class="eg ${f.tab === 'dip' ? '' : 'two'}">${f.tab === 'dip' ? f$('amount', `Amount (◎${st.buyMode === 'split' ? ' total' : ' each'})`, f.amount) + `<label>Wallets<span class="ro">${st.mode === 'live' ? buySel().length + ' · buy group' : 'paper'}</span></label>` + f$('expiry', 'Expires (min)', f.expiry, '0 = never')
            : f$('pct', 'Sell % of the bag', f.pct) + `<label>Wallets<span class="ro">${selected().length || 'all'} holder(s)</span></label>`}</div>
          ${f.tab === 'dip' ? `<label class="adv"><input type="checkbox" data-tf="attach" ${f.attach ? 'checked' : ''}>Attach exit strategy ${st.stratId ? `<b class="up">${escH((st.strats.find((s) => s.id === st.stratId) || {}).name || '')}</b>` : '<span class="mut">(none picked under Adv.)</span>'} when it fills</label>` : ''}`;
      } else if (f.tab === 'trail') {
        const tp = Number(f.trail) || 0;
        form = `<div class="eg two">${f$('trail', 'Sell 100% if the mcap drops this % from its peak', f.trail)}<label>Stop now<span class="ro n">${mc && tp ? mc$(mc * (1 - tp / 100)) : '--'}</span></label></div>
          <div class="mut sm">The peak starts at the current mcap (${mc ? mc$(mc) : 'no live price yet'}) and follows it up. For a per-position trailing stop that starts at your entry, use the exit strategy under Adv.</div>`;
      } else {
        form = `<div class="eg">${f$('total', 'Total ◎', f.total)}${f$('slices', 'Slices', f.slices)}${f$('every', 'Every (s)', f.every)}<label>Per slice<span class="ro n">${Number(f.total) > 0 && Number(f.slices) > 0 ? sol(Number(f.total) / Number(f.slices)) + ' ◎' : '--'}</span></label></div>
          <label class="adv"><input type="checkbox" data-tf="attach" ${f.attach ? 'checked' : ''}>Attach the exit strategy to each slice</label>`;
      }
      const armLbl = f.tab === 'dip' ? `Arm dip buy${tgt > 0 && Number(f.amount) > 0 ? ` · ${sol(Number(f.amount))} ◎ at ≤ ${mc$(tgt)}` : ''}` : f.tab === 'tp' ? `Arm take profit${tgt > 0 ? ` · ${f.pct}% at ≥ ${mc$(tgt)}` : ''}` : f.tab === 'trail' ? `Arm trailing stop −${f.trail || 0}%` : `Start DCA · ${f.total || 0} ◎ in ${f.slices || 0}`;
      const list = orders.filter((o) => o.status === 'active' || Date.now() - (o.doneAt || 0) < 600e3).sort((a, b) => (a.status === 'active' ? 0 : 1) - (b.status === 'active' ? 0 : 1) || b.created - a.created);
      return `<div class="olp pnl"><div class="sh"><b>Triggers</b><span class="mut sm">on the live market cap</span><span class="sp"></span>${lv ? '<span class="lvd"></span>' : ''}${mc ? `<span class="n">${mc$(mc)}</span>` : ''}<button class="ib" data-a="panelx" aria-label="Close">${ICON.x}</button></div>
        ${mint ? `<div class="seg wide">${tabs.map(([k, l]) => `<button class="${f.tab === k ? 'on' : ''}" data-tt="${k}">${l}</button>`).join('')}</div>${form}
        <button class="btn arm ${f.tab === 'tp' || f.tab === 'trail' ? 'sellc' : ''}" data-a="arm">${escH(armLbl)}</button>` : '<div class="mut">Open a coin to arm a trigger.</div>'}
        <div class="sep2"></div><div class="sh"><b class="sm2">Armed</b><span class="sp"></span><span class="mut sm">all coins · ${list.filter((o) => o.status === 'active').length}</span></div>
        ${list.map((o) => trigRow(o)).join('') || '<div class="mut sm">Nothing armed.</div>'}</div>`;
    }
    function trigRow(o) {
      const s = orderStatus(o), cur = o.mint === getMint() ? mcapNow(o.mint) : o.lastMc;
      let bar = '', left = '', right = '', pct = null;
      if (o.type === 'dip' && o.refMcap && cur) { pct = (o.refMcap - cur) / (o.refMcap - o.target); left = `now ${mc$(cur)} → ${mc$(o.target)} · ${Math.max(0, (1 - o.target / cur) * 100).toFixed(0)}% away`; right = o.expires ? `${Math.max(0, Math.round((o.expires - Date.now()) / 60000))}m left` : ''; }
      else if (o.type === 'tpmc' && o.refMcap && cur) { pct = (cur - o.refMcap) / (o.target - o.refMcap); left = `now ${mc$(cur)} → ${mc$(o.target)} · ${Math.max(0, (o.target / cur - 1) * 100).toFixed(0)}% away`; }
      else if (o.type === 'trail' && o.peak) { const stop = o.peak * (1 - o.pct / 100); pct = cur ? (o.peak - cur) / (o.peak - stop) : 0; left = `peak ${mc$(o.peak)} · stop ${mc$(stop)}${cur ? ' · now ' + mc$(cur) : ''}`; }
      else if (o.type === 'dca') { pct = (o.done || 0) / o.slices; left = `${o.done || 0} / ${o.slices} slices`; right = o.status === 'active' ? `next in ${Math.max(0, Math.round(((o.nextAt || 0) - Date.now()) / 1000))}s` : ''; }
      if (pct != null) bar = `<div class="pb ${o.type}"><i style="width:${Math.max(0, Math.min(100, pct * 100)).toFixed(0)}%"></i></div>`;
      return `<div class="trw" title="${escH((o.log || []).join('\n'))}"><div class="orr"><span class="otag ${o.type}">${orderTag(o)}</span><button class="lk2" data-open="${o.mint}">${escH(o.sym)}</button><span class="ol">${escH(orderLabel(o))}</span><span class="sp"></span>
        <span class="n sm ${s.cls}">${escH(o.wait || s.txt)}</span>${o.status === 'active' ? `<button class="xx" data-oc="${o.id}" aria-label="Cancel">×</button>` : ''}</div>${bar}${left || right ? `<div class="pl n"><span>${escH(left)}</span><span>${escH(right)}</span></div>` : ''}</div>`;
    }

    function posHtml(orders) {
      const ex = GM_getValue('twExits', {}) || {};
      const rows = Object.entries(heldAll).map(([mint, h]) => {
        const live = mint === getMint() && pos, lp = live ? livePos() : null;
        const worth = live ? Object.values(lp).reduce((a, x) => a + (num(x.worthSol) || 0), 0) : h.worth;
        const pnl = live ? Object.values(lp).reduce((a, x) => a + (num(x.pnlSol) || 0), 0) : h.pnl;
        const cost = worth - pnl;
        return { mint, h, worth, pnl, pct: cost > 0 ? (pnl / cost) * 100 : 0, mc: mint === getMint() ? mcapNow(mint) : (ticks[mint] && ticks[mint].mcap) || null };
      }).sort((a, b) => (ui.posSort === 'value' ? b.worth - a.worth : b.pnl - a.pnl));
      const tv = rows.reduce((a, r) => a + r.worth, 0), tp = rows.reduce((a, r) => a + r.pnl, 0), tc = tv - tp;
      const S = SF();
      const tags = (mint) => {
        const os = orders.filter((o) => o.mint === mint && o.status === 'active');
        const e = ex[st.mode + ':' + mint];
        return (e ? `<span class="ptag srv">TP/SL · ${escH(e.name)}</span>` : '') + os.slice(0, 2).map((o) => `<span class="ptag">${orderTag(o)}${o.type === 'dip' || o.type === 'tpmc' ? ' ' + mc$(o.target) : ''}</span>`).join('') || '<span class="ptag none">no exit set</span>';
      };
      return `<div class="olp pnl"><div class="sh"><b>Positions</b><span class="n mut">${rows.length} open · ${st.mode}</span><span class="sp"></span>
          <span class="seg">${[['pnl', 'PnL'], ['value', 'Value']].map(([k, l]) => `<button class="${ui.posSort === k ? 'on' : ''}" data-ps="${k}">${l}</button>`).join('')}</span><button class="ib" data-a="panelx" aria-label="Close">${ICON.x}</button></div>
        <div class="g3s three"><div class="sb"><span class="lb">OPEN VALUE</span><span class="n v">◎ ${sol(tv)}</span><span class="n u">${usdS(tv)}</span></div>
          <div class="sb"><span class="lb">UNREALIZED</span><span class="n v ${tp >= 0 ? 'up' : 'dn'}">${tp >= 0 ? '+' : '−'}◎ ${sol(Math.abs(tp))}</span><span class="n u ${tp >= 0 ? 'up' : 'dn'}">${usdS(tp)}${tc > 0 ? ' · ' + (tp >= 0 ? '+' : '') + ((tp / tc) * 100).toFixed(1) + '%' : ''}</span></div>
          <div class="sb"><span class="lb">CLOSED TODAY</span><span class="n v ${daily && daily.sum < 0 ? 'dn' : 'up'}">${daily && daily.sum != null ? (daily.sum >= 0 ? '+' : '−') + '◎ ' + sol(Math.abs(daily.sum)) : '--'}</span><span class="n u">${daily && daily.sum != null ? usdS(daily.sum) + (S.dailyLoss > 0 ? ` · limit −${S.dailyLoss}` : '') : ''}</span></div></div>
        ${rows.map((r) => `<div class="prw"><div class="orr"><span class="av">${escH((r.h.sym || '?').replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase())}</span>
            <span class="wn"><button class="lk2" data-open="${r.mint}"><b>${escH(r.h.sym || tail(r.mint))}</b></button><span class="n mut sm">${r.h.n} wallet${r.h.n > 1 ? 's' : ''} · ◎ ${sol(r.worth)}${r.h.entry ? ' · entry ' + mc$(r.h.entry) : ''}</span></span><span class="sp"></span>
            <span class="pr n ${r.pnl >= 0 ? 'up' : 'dn'}"><b>${r.pnl >= 0 ? '+' : '−'}◎ ${sol(Math.abs(r.pnl))}</b><span>${r.pct >= 0 ? '+' : ''}${r.pct.toFixed(1)}%</span></span></div>
          <div class="orr">${tags(r.mint)}<span class="sp"></span>${[25, 50, 100].map((x) => `<button class="t s mini n ${x === 100 ? 'full' : ''}" data-psell="${r.mint}" data-x="${x}">${x}%</button>`).join('')}<button class="si mini" data-pinit="${r.mint}">Init</button></div></div>`).join('') || '<div class="mut">No open positions.</div>'}
        ${rows.some((r) => r.pnl < 0) ? '<div class="sh"><span class="mut sm">Click a coin to open it</span><span class="sp"></span><button class="btn sm danger" data-a="selllosers">Sell all losers</button></div>' : ''}</div>`;
    }

    function infoHtml() {
      const mint = getMint();
      if (info.mint !== mint) loadInfo();
      const tk = mint && ticks[mint], relayAge = (Date.now() - (GM_getValue('agRelayAt', 0) || 0)) / 1000;
      const ago = (t) => (t ? Math.max(0, Math.round((Date.now() - t) / 1000)) + 's ago' : 'never');
      const conn = [
        ['Price stream', tk && Date.now() - tk.at < 10000 ? `${tk.src === 'gmgn' ? 'GMGN' : 'AG'} · live` : tk ? 'stale · ' + ago(tk.at) : 'no ticks', tk && Date.now() - tk.at < 10000 ? 'ok' : tk ? 'warn' : 'bad'],
        ['AG feed', env === 'ag' ? (stream.ok ? 'connected' : 'not connected') : stream.at ? 'via backtester · ' + ago(stream.at) : 'no ticks from the backtester yet', env === 'ag' ? (stream.ok ? 'ok' : 'bad') : stream.at && Date.now() - stream.at < 20000 ? 'ok' : 'warn'],
        ['Backtester relay', env === 'ag' ? 'this tab' : relayAge < 30 ? 'heartbeat ' + Math.round(relayAge) + 's ago' : 'backtester tab not open', env === 'ag' || relayAge < 30 ? 'ok' : 'bad'],
        ['AG positions', posRef ? 'synced ' + ago(posRef.at) : 'not loaded', posRef && Date.now() - posRef.at < 12000 ? 'ok' : 'warn'],
      ];
      const tr = info.mint === mint ? info.trades : null;
      return `<div class="olp pnl"><div class="sh"><b>${escH(sym || 'Coin')}</b><span class="mut n sm">${tail(mint)}</span><span class="sp"></span><button class="btn sm" data-a="p:share">${ICON.share}Share PnL</button><button class="ib" data-a="panelx" aria-label="Close">${ICON.x}</button></div>
        ${info.chips && info.chips.length ? `<div class="agi"><div class="sh"><span class="agt">AG PROFILE</span><span class="sp"></span></div><div class="chips">${info.chips.map((c) => `<span class="chip">${escH(c.k)} <b class="n">${escH(c.v)}</b></span>`).join('')}</div></div>` : ''}
        <div class="sh"><b class="sm2">Your trades</b><span class="sp"></span><span class="mut sm">${st.mode}</span></div>
        ${tr == null ? `<div class="mut sm">${info.mint === mint ? 'AG did not return trade rows for this coin.' : 'Loading…'}</div>`
          : !tr.length ? '<div class="mut sm">No trades on this coin yet.</div>'
          : `<div class="tlh"><span>TIME</span><span>SIDE</span><span class="w">WALLET</span><span class="r">MCAP</span><span class="r">◎</span></div>${tr.slice(-12).map((t) => `<div class="tlr n"><span class="mut">${t.t ? new Date(t.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }) : '--'}</span><span class="${t.side === 'BUY' ? 'up' : 'dn'}">${t.side}</span><span class="w">${escH(t.w ? labelOf(t.w) : '—')}</span><span class="r">${t.mc ? mc$(t.mc) : '--'}</span><span class="r ${t.side === 'BUY' ? 'up' : 'dn'}">${t.sol != null ? sol(t.sol) : '--'}</span></div>`).join('')}`}
        <div class="conn"><span class="lb">CONNECTION</span>${conn.map(([k, v, c]) => `<div class="cr"><i class="dot ${c}"></i><span>${k}</span><span class="sp"></span><span class="n mut">${escH(v)}</span></div>`).join('')}</div></div>`;
    }

    function settingsHtml() {
      const f = (k, label, v, step) => `<label>${label}<input class="n" type="number" step="${step || 'any'}" data-s="${k}" value="${v}"></label>`;
      const ck = (k, label, on) => `<label class="ck"><input type="checkbox" data-s="${k}" ${on ? 'checked' : ''}>${label}</label>`;
      const S = SF(), A = st.alerts;
      const dl = daily && daily.sum != null && S.dailyLoss > 0 ? Math.min(100, Math.max(0, (-daily.sum / S.dailyLoss) * 100)) : null;
      return `<div class="stp pnl"><div class="sh"><b>Settings</b><span class="sp"></span><span class="mut sm">button values: ✎ in the header</span><button class="ib" data-a="panelx" aria-label="Close">${ICON.x}</button></div>
        <span class="sm2">Safety rails <span class="mut sm">(LIVE)</span></span>
        <div class="eg two">${f('maxPerCoin', 'Max per coin (◎, 0 = off)', S.maxPerCoin, 0.1)}${f('dailyLoss', 'Daily loss limit (◎, 0 = off)', S.dailyLoss, 0.1)}
          ${f('impactWarn', 'Warn above price impact (%)', S.impactWarn, 1)}${f('dupSec', 'Block a 2nd buy within (s)', S.dupSec, 1)}</div>
        ${dl != null ? `<div class="pb ${dl >= 100 ? 'bad' : ''}"><i style="width:${dl.toFixed(0)}%"></i></div><div class="pl n"><span>today ${sol(daily.sum)} ◎ closed</span><span>${dl >= 100 ? 'buys locked' : sol(S.dailyLoss + daily.sum) + ' ◎ before buys lock'}</span></div>` : ''}
        <span class="sm2">Buying</span>
        <div class="eg two">${f('confirmAbove', 'Confirm LIVE buys above (◎ total)', st.confirmAbove, 0.1)}${f('reserve', 'Keep in each wallet (◎)', st.reserve, 0.005)}
          ${f('stagger', 'Stagger between wallets (ms)', st.stagger, 50)}${f('variance', 'Token split variance (%)', st.variance, 1)}</div>
        <span class="sm2">Hotkeys</span>
        <div class="sh"><span class="seg">${[['on', 'On'], ['hover', 'Hover only'], ['off', 'Off']].map(([k, l]) => `<button class="${st.hotkeys === k ? 'on' : ''}" data-hk="${k}">${l}</button>`).join('')}</span>${ck('kbHints', 'Key hints on buttons', st.kbHints)}</div>
        <div class="keys mut sm"><span><kbd>1–8</kbd> buy</span><span><kbd>⇧1–8</kbd> sell</span><span><kbd>X</kbd> initials</span><span><kbd>U</kbd> unit</span><span><kbd>S</kbd> split</span><span><kbd>G</kbd> group</span><span><kbd>Alt+1–3</kbd> preset</span><span><kbd>D</kbd> dip</span><span><kbd>L</kbd> live</span><span><kbd>C</kbd> collapse</span><span><kbd>/</kbd> custom</span><span><kbd>Esc</kbd> close</span></div>
        <span class="sm2">Alerts <span class="mut sm">(coins you hold · run by the backtester tab)</span></span>
        <div class="eg two">${ck('al.dev.on', 'Dev sells', A.dev.on)}${f('al.dev.pct', 'when ≥ % of supply', A.dev.pct, 0.5)}
          ${ck('al.dev.auto', 'Auto-sell 100% on a dev sell', A.dev.auto)}<span></span>
          ${ck('al.whale.on', 'Whale sells', A.whale.on)}${f('al.whale.sol', 'when ≥ ◎', A.whale.sol, 1)}
          ${ck('al.move.on', 'Fast mcap moves', A.move.on)}${f('al.move.pct', 'when ≥ % in 1 min', A.move.pct, 5)}
          ${ck('al.fills', 'Fill & exit notices', A.fills)}${ck('al.sound', 'Sound', A.sound)}
          ${ck('al.desktop', 'Desktop notifications', A.desktop)}<span class="mut sm">${window.Notification ? 'permission: ' + Notification.permission : 'not supported'}</span></div>
        <span class="sm2">Size & GMGN cards</span>
        <div class="eg two">${f('scalePct', 'Size % (or drag the corner)', Math.round((Number(st.scale) || 1) * 100), 5)}${ck('autoFit', 'Auto-fit screen height', st.autoFit)}
          ${f('qb', 'Card quick buy (◎)', st.qb, 0.01)}${ck('cards', 'Holdings + quick buy on cards', st.cards)}</div>
        <button class="btn wide" data-a="pushtx">Apply P${st.preset + 1} tx settings to my ${st.mode} AG wallets</button>
        <div class="mut sm">AG stores slippage / fee / MEV per wallet, not per order, so this updates the wallets themselves (the AG bot uses them too).</div></div>`;
    }

    async function toggleMode() {
      if (st.mode === 'paper' && !(await ask({ tone: 'warn', title: 'Switch to LIVE?', sub: 'Buttons, hotkeys and triggers will place REAL orders with your AG wallets.',
        actions: [{ label: 'Stay on paper', v: null, kind: 'ghost' }, { label: 'Go LIVE', v: 'go', kind: 'danger' }] }))) return;
      st.mode = st.mode === 'paper' ? 'live' : 'paper'; save(); pos = null; trades = null; wallets = []; ui.autoSel = null; ui.plan = null; held = {}; heldAll = {}; daily = null; srv = { mint: null, list: null, at: 0 };
      scanCards(); loadHeld(); loadDaily(); autoPending = true; render(); loadWallets(); loadPos();
    }
    async function sellLosers() {
      const losers = Object.entries(heldAll).filter(([, h]) => h.pnl < 0);
      if (!losers.length) return;
      const v = await ask({ tone: 'warn', title: `Sell ${losers.length} losing position${losers.length > 1 ? 's' : ''}`, sub: '100% of each, every wallet',
        lines: losers.map(([m, h]) => `${h.sym || tail(m)} · −◎ ${sol(Math.abs(h.pnl))}`), actions: [{ label: 'Cancel', v: null, kind: 'ghost' }, { label: 'Sell all losers', v: 'go', kind: 'danger' }] });
      if (!v) return;
      for (const [m, h] of losers) await execSell({ mint: m, symb: h.sym, pct: 100, interactive: false });
    }

    function onClick(e) {
      const t = e.target.closest('button,input[type=checkbox]');
      if (!t) return;
      const d = t.dataset;
      if (d.mv != null && ui.modal) { const a = ui.modal.actions[+d.mv]; return closeModal(a ? a.v : null); }
      if (d.s || d.se === 'be' || d.tf === 'attach') return; // checkboxes → onChange
      if (d.bu) return buyUnitAmt(d.bu);
      if (d.su) return st.sellUnit === 'sol' ? sellSol(d.su) : sell(d.su);
      if (d.su2) return sell(d.su2);
      if (d.oc) return cancelOrder(d.oc);
      if (d.g) return useGroup(d.g);
      if (d.gd) return delGroup(d.gd);
      if (d.cpm) return copy(d.cpm, 'mint');
      if (d.cp) return copy(d.cp, `${labelOf(d.cp)} address`);
      if (d.open) return openCoin(d.open);
      if (d.alx) return dismissAlert(d.alx);
      if (d.alsell) return execSell({ mint: d.alsell, symb: (heldAll[d.alsell] || {}).sym, pct: 100, interactive: true });
      if (d.alinit) return sellInit(d.alinit);
      if (d.psell) { const h = heldAll[d.psell] || {}; return execSell({ mint: d.psell, symb: h.sym, pct: Number(d.x), interactive: true }); }
      if (d.pinit) return sellInit(d.pinit);
      if (d.ps) { ui.posSort = d.ps; return render(); }
      if (d.hk) { st.hotkeys = d.hk; save(); return render(); }
      if (d.tt) { ui.tf.tab = d.tt; ui.tf.target = ''; return render(); }
      if (d.tq) {
        const mc = mcapNow(getMint());
        let entry = null; { let eW = 0, eS = 0; for (const [, h] of heldBy()) { const m = num(h.avgEntryMcap), c = costOf(h) || 0; if (m > 0 && c > 0) { eW += m * c; eS += c; } } entry = eS ? eW / eS : null; }
        const v = d.tq === 'e' ? entry : d.tq === 'e2' ? entry && entry * 2 : mc && mc * (1 + Number(d.tq) / 100);
        if (v) { ui.tf.target = kfmt(v); render(); }
        return;
      }
      if (d.bunit) { if (ui.edit) captureDraft(); st.buyUnit = d.bunit; save(); return render(); }
      if (d.plan) { ui.plan = ui.plan && ui.plan.kind === d.plan ? null : { kind: d.plan, dest: null, seed: (Math.random() * 2e9) | 0 }; if (ui.plan) { loadWallets(true); loadPos(); } return render(); }
      if (d.p != null && d.p !== '') { st.preset = Number(d.p); save(); return render(); }
      if (d.wa != null) {
        const set = new Set(buySel());
        t.checked ? set.add(d.wa) : set.delete(d.wa);
        setSel([...set]); return render();
      }
      switch (d.w) {
        case 'all': setSel(wallets.map((w) => w.address).filter(Boolean)); return render();
        case 'none': setSel([]); return render();
        case 'fsol': ui.filt.sol = !ui.filt.sol; return render();
        case 'ftok': ui.filt.tok = !ui.filt.tok; return render();
        case 'reload': loadPos(); return loadWallets(true);
        case 'gsave': return saveGroup();
        case 'noauto': ui.autoSel = null; toast('Sells now use your own wallet selection for this coin'); return render();
      }
      const a = d.a || '';
      if (a.startsWith('p:')) {
        const pn = a.slice(2);
        ui.panel = ui.panel === pn ? null : pn;
        if (ui.panel === 'wal') { loadWallets(true); loadPos(); }
        if (ui.panel === 'pos') { loadHeld(); loadDaily(); }
        if (ui.panel === 'info' || ui.panel === 'share') loadInfo(true);
        if (ui.panel === 'set') loadDaily();
        return render();
      }
      switch (a) {
        case 'panelx': ui.panel = null; return render();
        case 'mode': return toggleMode();
        case 'col': ui.collapsed = !ui.collapsed; savePos(); if (!ui.collapsed) loadPos(); return render();
        case 'edit': return startEdit();
        case 'esave': return saveEdit();
        case 'ecancel': ui.edit = false; ui.draft = {}; return render();
        case 'bmode': st.buyMode = st.buyMode === 'split' ? 'each' : 'split'; save(); scanCards(); return render();
        case 'sunit': if (ui.edit) captureDraft(); st.sellUnit = st.sellUnit === 'sol' ? 'pct' : 'sol'; save(); return render();
        case 'cbuy': return buyUnitAmt(el.querySelector('[data-a=camt]').value);
        case 'pushtx': return pushTx();
        case 'sinit': return sellInit();
        case 'omig': return addOrder('mig');
        case 'oinit': return addOrder('miginit');
        case 'oprot': return addOrder('protect');
        case 'arm': return addTrigger();
        case 'selllosers': return sellLosers();
        case 'alclear': for (const x of loadAlerts()) ui.alertsGone[x.id] = 1; GM_setValue('twAlerts', []); return render();
        case 'sharecp': return shareOut('cp');
        case 'sharedl': return shareOut('dl');
        case 'sedit': { const s = st.strats.find((x) => x.id === st.stratId); ui.stratEdit = s ? JSON.parse(JSON.stringify(s)) : { id: id(), name: 'My strategy', levels: [{ t: 'TP', p: 100, a: 50 }, { t: 'SL', p: 35, a: 100 }], be: false, trail: 0, isNew: true }; return render(); }
        case 'scancel': ui.stratEdit = null; return render();
        case 'lvadd': ui.stratEdit.levels.push(d.t === 'SL' ? { t: 'SL', p: 35, a: 100 } : { t: 'TP', p: 200, a: 25 }); return render();
        case 'lvdel': ui.stratEdit.levels.splice(Number(d.i), 1); return render();
        case 'ssave': {
          const s = ui.stratEdit, lv = s.levels.map((l) => ({ t: l.t === 'SL' ? 'SL' : 'TP', p: Number(l.p), a: Number(l.a) })).filter((l) => l.p > 0 && l.a > 0);
          if (!lv.length) return toast('Add at least one level with a trigger % and a sell %', true);
          if (lv.filter((l) => l.t === 'SL').length > 1) return toast('Only one stop-loss per strategy', true);
          if (lv.some((l) => l.t === 'SL' && l.p >= 100)) return toast('A stop-loss must be below 100%', true);
          const clean = { id: s.id, name: String(s.name || 'Strategy').slice(0, 20), levels: lv.sort((x, y) => (x.t === 'SL') - (y.t === 'SL') || x.p - y.p), be: !!s.be, trail: Math.min(90, Math.max(0, Number(s.trail) || 0)) };
          const i = st.strats.findIndex((x) => x.id === s.id);
          if (i >= 0) st.strats[i] = clean; else st.strats.push(clean);
          st.stratId = clean.id; ui.stratEdit = null; save(); toast(`Strategy “${clean.name}” saved`); return render();
        }
        case 'sdel': {
          const s = ui.stratEdit;
          st.strats = st.strats.filter((x) => x.id !== s.id);
          if (st.stratId === s.id) st.stratId = null;
          ui.stratEdit = null; save(); return render();
        }
        case 'sapply': return applyExitNow();
        case 'plancp': { const pl = buildPlan(); if (pl && pl.tx && pl.tx.length) copy(planText(pl), 'transfer plan'); return; }
        case 'reroll': if (ui.plan) ui.plan.seed = (Math.random() * 2e9) | 0; return render();
        case 'planx': ui.plan = null; return render();
      }
    }
    function onChange(e) {
      const d = e.target.dataset, tv = e.target.value;
      if (d.e) { ui.draft[draftKey(d.e)] = tv; return; }
      if (d.f && ui.plan) { ui.plan[d.f] = tv; e.target.blur(); return render(); }
      if (d.tf) { ui.tf[d.tf] = e.target.type === 'checkbox' ? e.target.checked : tv; return render(); }
      if (d.se && ui.stratEdit) {
        const [k, i] = d.se.split(':');
        if (i != null) ui.stratEdit.levels[+i][k] = k === 't' ? tv : tv;
        else ui.stratEdit[k] = e.target.type === 'checkbox' ? e.target.checked : tv;
        if (k === 't' || e.target.type === 'checkbox') return render();
        return;
      }
      if (!d.s) return;
      const v = Number(tv), ch = e.target.checked;
      const S = (st.safety = SF());
      if (d.s.startsWith('al.')) {
        const path = d.s.slice(3).split('.');
        let o = st.alerts;
        for (let i = 0; i < path.length - 1; i++) o = o[path[i]];
        const last = path[path.length - 1];
        o[last] = e.target.type === 'checkbox' ? ch : Math.max(0, v || 0);
        if (d.s === 'al.desktop' && ch && window.Notification && Notification.permission === 'default') Notification.requestPermission().then(render);
      }
      else if (d.s === 'adv') { st.adv = ch; if (ch) loadSrv(); }
      else if (d.s === 'stratId') { st.stratId = tv || null; ui.stratEdit = null; }
      else if (d.s === 'shareHide') { ui.shareHide = ch; return render(); }
      else if (d.s === 'kbHints') st.kbHints = ch;
      else if (d.s === 'cards') { st.cards = ch; save(); scanCards(); return render(); }
      else if (d.s === 'confirmAbove') st.confirmAbove = v || 0;
      else if (d.s === 'qb') st.qb = Math.max(0, v || 0);
      else if (d.s === 'stagger') st.stagger = Math.min(10000, Math.max(0, v || 0));
      else if (d.s === 'reserve') st.reserve = Math.max(0, v || 0);
      else if (d.s === 'variance') st.variance = Math.min(50, Math.max(0, v || 0));
      else if (d.s === 'maxPerCoin' || d.s === 'dailyLoss') { S[d.s] = Math.max(0, v || 0); if (d.s === 'dailyLoss') loadDaily(); }
      else if (d.s === 'impactWarn') S.impactWarn = Math.max(1, v || 10);
      else if (d.s === 'dupSec') S.dupSec = Math.max(0, v || 0);
      else if (d.s === 'scalePct') { st.scale = Math.min(1.8, Math.max(0.7, (v || 100) / 100)); save(); fit(); }
      else if (d.s === 'autoFit') { st.autoFit = ch; save(); setK(Math.min(1.8, Math.max(0.7, Number(st.scale) || 1))); fit(); }
      save();
      if (e.target.type !== 'checkbox' && e.target.tagName !== 'SELECT') e.target.blur();
      render();
    }

    // ---------------------------------------------------------- in-widget dialog (replaces window.confirm)
    // ask({ tone, title, sub, stats:[{k,v,bad}], lines:[], warn:[], note, actions:[{label, v, kind}] }) → Promise<v|null>
    function ask(m) {
      return new Promise((resolve) => {
        if (ui.modal) ui.modal.resolve(null);
        ui.modal = Object.assign({}, m, { resolve });
        if (ui.collapsed) { ui.collapsed = false; ui.wasCollapsed = true; }
        render();
      });
    }
    function closeModal(v) {
      const m = ui.modal;
      if (!m) return;
      ui.modal = null;
      if (ui.wasCollapsed) { ui.collapsed = true; ui.wasCollapsed = false; }
      render();
      m.resolve(v);
    }
    function modalHtml() {
      const m = ui.modal;
      if (!m) return '';
      const stats = (m.stats || []).filter(Boolean);
      return `<div class="mdl"><div class="mbox ${m.tone || ''}" role="dialog" aria-modal="true" aria-label="${escH(m.title)}">
        <div class="mh"><span class="mic">${m.tone === 'warn' ? ICON.warn : ICON.bolt}</span><div class="mt"><b>${escH(m.title)}</b>${m.sub ? `<span class="mut sm">${escH(m.sub)}</span>` : ''}</div></div>
        ${stats.length ? `<div class="ms">${stats.map((s) => `<div class="${s.bad ? 'bad' : ''}"><span>${escH(s.k)}</span><b class="n">${escH(s.v)}</b></div>`).join('')}</div>` : ''}
        ${(m.lines || []).length ? `<div class="ml n">${m.lines.map((l) => `<div>${escH(l)}</div>`).join('')}</div>` : ''}
        ${(m.warn || []).map((w) => `<div class="mw">${escH(w)}</div>`).join('')}
        ${m.note ? `<div class="mut sm">${escH(m.note)}</div>` : ''}
        <div class="ma">${m.actions.map((a, i) => `<button class="btn ${a.kind || ''}" data-mv="${i}">${escH(a.label)}</button>`).join('')}</div>
        <div class="mk mut">${(() => { const d = m.actions.find((a) => a.kind === 'pri' || a.kind === 'ok'); return d ? `Enter = ${escH(d.label)} · ` : ''; })()}Esc = cancel</div></div></div>`;
    }

    // ---------------------------------------------------------- small helpers
    const parseMc = (s) => { const m = String(s || '').replace(/[$,\s]/g, '').match(/^(\d*\.?\d+)([kmb])?$/i); return m ? Number(m[1]) * ({ k: 1e3, m: 1e6, b: 1e9 }[(m[2] || '').toLowerCase()] || 1) : NaN; };
    function openCoin(mint) {
      if (env === 'ag') location.hash = 'token/' + mint;
      else location.href = '/sol/token/' + mint;
    }

    // ---------------------------------------------------------- notifications: toasts, sound, desktop
    let actx = null;
    function beep(kind) {
      if (!st.alerts.sound) return;
      try {
        actx = actx || new (window.AudioContext || window.webkitAudioContext)();
        const o = actx.createOscillator(), g = actx.createGain();
        o.frequency.value = kind === 'alert' ? 880 : 660; o.type = 'sine';
        g.gain.setValueAtTime(0.0001, actx.currentTime); g.gain.exponentialRampToValueAtTime(0.12, actx.currentTime + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, actx.currentTime + (kind === 'alert' ? 0.45 : 0.18));
        o.connect(g); g.connect(actx.destination); o.start(); o.stop(actx.currentTime + 0.5);
      } catch (_) {}
    }
    function notify(title, body, kind, mint) {
      beep(kind);
      if (st.alerts.desktop && document.hidden && window.Notification && Notification.permission === 'granted') {
        try { const n = new Notification(title, { body, tag: 'agtw-' + (mint || title) }); n.onclick = () => { window.focus(); if (mint) openCoin(mint); }; } catch (_) {}
      }
    }

    // ---------------------------------------------------------- alerts (dev / whale / mcap moves), run by the backtester leader
    // Cards are shared with every tab through storage; buttons act from the tab you click in.
    const loadAlerts = () => (GM_getValue('twAlerts', []) || []).filter((a) => Date.now() - a.at < 30 * 60e3);
    function pushAlert(a) {
      const list = loadAlerts();
      if (list.some((x) => x.key && x.key === a.key)) return;
      a = Object.assign({ id: id(), at: Date.now() }, a);
      GM_setValue('twAlerts', list.concat([a]).slice(-12));
      showAlert(a);
    }
    function showAlert(a) {
      if (ui.alertsSeen[a.id]) return;
      ui.alertsSeen[a.id] = 1;
      notify(a.title, a.body, 'alert', a.mint);
      render();
    }
    function dismissAlert(aid) { ui.alertsGone[aid] = 1; GM_setValue('twAlerts', loadAlerts().filter((a) => a.id !== aid)); render(); }
    const devLast = {};
    async function pollDev() {
      if (env !== 'ag' || !st.alerts.dev.on || !isLeader()) return;
      const mints = Object.keys(heldAll).slice(0, 8);
      if (getMint() && !mints.includes(getMint())) mints.push(getMint());
      if (!mints.length) return;
      const rs = await call(mints.map((m) => ({ method: 'GET', path: `/api/tokens/${m}/creator-holdings` })));
      for (let i = 0; i < mints.length; i++) {
        const r = rs[i], mint = mints[i];
        const f = r && r.ok && r.j && r.j.available !== false && r.j.figures && r.j.figures.creator;
        if (!f) continue;
        const nowPct = parseFloat(String(f.now).replace(/[^\d.]/g, ''));
        if (!isFinite(nowPct)) continue;
        const prev = devLast[mint];
        devLast[mint] = nowPct;
        if (prev == null) continue;
        const drop = prev - nowPct;
        if (drop >= Number(st.alerts.dev.pct || 1)) {
          const h = heldAll[mint], name = (h && h.sym) || (mint === getMint() ? sym : '') || tail(mint);
          const auto = st.alerts.dev.auto && h;
          pushAlert({ kind: 'dev', key: `dev:${mint}:${nowPct}`, mint, sym: name, title: `Dev sold ${drop.toFixed(1)}% of supply · ${name}`, body: `Creator holds ${nowPct.toFixed(1)}% now (was ${prev.toFixed(1)}%)${auto ? ' · auto-selling' : ''}`, auto: !!auto });
          if (auto) execSell({ mint, symb: name, pct: 100, mode: st.mode, label: 'dev dump auto-sell' });
        }
      }
    }
    function onSwap(d) {
      if (!d || d.side !== 'sell' || !st.alerts.whale.on) return;
      const mint = d.tokenAddress, h = heldAll[mint];
      const s = num(d.solAmount, d.amountSol, d.sol);
      if (!h || !(s >= Number(st.alerts.whale.sol || 5))) return;
      pushAlert({ kind: 'whale', key: `whale:${d.signature || mint + s}`, mint, sym: h.sym || tail(mint), title: `Whale sold ${sol(s)} ◎ of ${h.sym || tail(mint)}`, body: `${d.isSmartMoney ? 'Smart money · ' : ''}${tail(d.wallet || d.walletKey || '')}${d.mcap ? ' · mcap ' + mc$(num(d.mcap)) : ''}` });
    }
    const moveRef = {};
    function checkMove(mint, mcap) {
      if (!st.alerts.move.on || !heldAll[mint]) return;
      const r = moveRef[mint], now = Date.now();
      if (!r || now - r.at > 60000) { moveRef[mint] = { mcap, at: now }; return; }
      const ch = (mcap / r.mcap - 1) * 100;
      if (Math.abs(ch) >= Number(st.alerts.move.pct || 30)) {
        moveRef[mint] = { mcap, at: now };
        const h = heldAll[mint];
        pushAlert({ kind: 'move', key: `move:${mint}:${Math.round(now / 60000)}`, mint, sym: h.sym, title: `${h.sym || tail(mint)} ${ch > 0 ? '+' : ''}${ch.toFixed(0)}% in ${Math.round((now - r.at) / 1000)}s`, body: `mcap ${mc$(r.mcap)} → ${mc$(mcap)}` });
      }
    }
    function alertsHtml() {
      const all = loadAlerts().filter((a) => !ui.alertsGone[a.id]), list = all.slice(-2).reverse();
      if (!list.length) return '';
      return `<div class="als">${all.length > 2 ? `<div class="sh mut sm">${all.length - 2} older alert${all.length > 3 ? 's' : ''} hidden<span class="sp"></span><button class="lk" data-a="alclear">Clear all</button></div>` : ''}${list.map((a) => `<div class="al ${a.kind}"><div class="sh"><span class="atag">${{ dev: 'DEV SELL', whale: 'WHALE', move: 'MOVE' }[a.kind] || 'ALERT'}</span><b>${escH(a.title)}</b><span class="sp"></span><span class="n mut sm">${Math.max(0, Math.round((Date.now() - a.at) / 1000))}s</span></div>
        <div class="sm">${escH(a.body)}</div>
        ${a.kind === 'dev' && !a.auto ? `<div class="g3"><button class="btn danger" data-alsell="${a.mint}">Sell 100%</button><button class="btn" data-alinit="${a.mint}">Sell init</button><button class="btn ghost" data-alx="${a.id}">Dismiss</button></div>`
          : `<div class="ab"><button class="lk" data-open="${a.mint}">Open</button><span class="sp"></span><button class="btn sm ghost" data-alx="${a.id}">Dismiss</button></div>`}</div>`).join('')}</div>`;
    }

    // ---------------------------------------------------------- every position in the current mode (both tabs)
    let heldAll = {}, heldAt = 0;
    // ---------------------------------------------------------- coin info: AG profile chips + your trades
    let info = { mint: null, chips: null, trades: null, at: 0 };
    const PROFILE_KEYS = [[/fresh/i, 'Fresh'], [/dev.*hold|creator.*hold/i, 'Dev hold'], [/bundl/i, 'Bundled'], [/top.?10|top.*holder/i, 'Top-10'], [/smart/i, 'Smart money'], [/win.?pred/i, 'Win pred'], [/sniper/i, 'Snipers'], [/insider/i, 'Insiders']];
    function profileChips(j) {
      const out = [], seen = new Set();
      const walk = (o, depth) => {
        if (!o || typeof o !== 'object' || depth > 2) return;
        for (const [k, v] of Object.entries(o)) {
          if (v && typeof v === 'object') { walk(v, depth + 1); continue; }
          const hit = PROFILE_KEYS.find(([re]) => re.test(k));
          if (!hit || seen.has(hit[1]) || v == null || v === '' || typeof v === 'boolean') continue;
          const n = Number(v);
          if (!isFinite(n)) continue;
          seen.add(hit[1]);
          const pct = /pct|percent|share|ratio/i.test(k) || (n > 0 && n < 1 && !/count|num/i.test(k));
          out.push({ k: hit[1], v: pct ? (n <= 1 && !/pct|percent/i.test(k) ? n * 100 : n).toFixed(1) + '%' : String(Math.round(n * 100) / 100) });
        }
      };
      walk(j, 0);
      return out;
    }
    function tradeRows(j) {
      const arr = j && (j.trades || j.swaps || j.items || j.history || j.fills);
      if (!Array.isArray(arr)) return null;
      return arr.map((t) => {
        const ts = num(t.blockTime, t.timestamp, t.time, t.ts) || (t.at || t.createdAt ? new Date(t.at || t.createdAt).getTime() / 1000 : null);
        return { side: String(t.side || t.type || '').toLowerCase().includes('sell') ? 'SELL' : 'BUY', sol: num(t.solAmount, t.amountSol, t.sol, t.amount), mc: num(t.mcap, t.mcapUsd, t.marketCap, t.mcapAtTrade),
          w: t.walletAddress || t.wallet || t.walletKey || '', t: ts ? ts * (ts < 1e12 ? 1000 : 1) : null };
      }).sort((a, b) => (a.t || 0) - (b.t || 0));
    }
    async function loadInfo(force) {
      const mint = getMint();
      if (!mint || (!force && info.mint === mint && Date.now() - info.at < 30000)) return;
      info = { mint, chips: info.mint === mint ? info.chips : null, trades: info.mint === mint ? info.trades : null, at: Date.now() };
      const [p, t] = await call([{ method: 'GET', path: `/api/tokens/${mint}/profile` }, { method: 'GET', path: `/api/tokens/${mint}/my-trades${st.mode === 'paper' ? '?source=paper' : ''}` }]);
      if (getMint() !== mint) return;
      if (DEBUG) console.log('[AG widget] profile', p && p.j, 'my-trades', t && t.j);
      info.chips = p && p.ok ? profileChips(p.j) : [];
      info.trades = t && t.ok ? tradeRows(t.j) : null;
      render();
    }

    // ---------------------------------------------------------- shareable PnL card (PNG, drawn on a canvas)
    function shareData() {
      const mint = getMint(), sm = summary();
      if (!mint || !sm || sm.pnl == null) return null;
      const held = heldBy();
      let eW = 0, eS = 0;
      for (const [, h] of held) { const m = num(h.avgEntryMcap), c = costOf(h) || 0; if (m > 0 && c > 0) { eW += m * c; eS += c; } }
      const tr = info.mint === mint && info.trades ? info.trades : null;
      const t0 = tr && tr.length ? tr[0].t : null;
      return { sym: sym || tail(mint), pct: sm.pnl, sol: sm.pnlSol, usd: usdRate && sm.pnlSol != null ? sm.pnlSol * usdRate : null, entry: eS ? eW / eS : null,
        now: mcapNow(mint), invested: sm.bought, wallets: Math.max(1, held.length), mins: t0 ? Math.round((Date.now() - t0) / 60000) : null };
    }
    function drawShare(d, hide) {
      const W = 880, H = 800, c = document.createElement('canvas');
      c.width = W; c.height = H;
      const g = c.getContext('2d'), up = d.pct >= 0;
      const SANS = "'IBM Plex Sans', Inter, system-ui, sans-serif", MONO = "'IBM Plex Mono', ui-monospace, Menlo, monospace";
      const bg = g.createLinearGradient(0, 0, W, H);
      bg.addColorStop(0, up ? '#0F1E16' : '#1E1013'); bg.addColorStop(1, '#0B0D10');
      g.fillStyle = bg; g.fillRect(0, 0, W, H);
      g.strokeStyle = up ? 'rgba(143,230,180,.22)' : 'rgba(245,154,166,.22)'; g.lineWidth = 6; g.beginPath();
      for (let i = 0; i <= 40; i++) { const x = (W * i) / 40, t = i / 40, y = up ? H * 0.82 - t * t * H * 0.7 + Math.sin(i * 1.7) * 14 : H * 0.2 + t * t * H * 0.6 + Math.sin(i * 1.7) * 14; i ? g.lineTo(x, y) : g.moveTo(x, y); }
      g.stroke();
      const col = up ? '#8FE6B4' : '#F59AA6', soft = up ? '#7FBF9C' : '#C99AA2';
      g.fillStyle = '#B8F04A'; g.font = `700 34px ${SANS}`; g.fillText('AG ⚡', 44, 70);
      g.fillStyle = soft; g.font = `400 24px ${MONO}`; g.textAlign = 'right'; g.fillText(new Date().toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' }), W - 44, 70); g.textAlign = 'left';
      g.fillStyle = '#E6E8EC'; g.font = `700 54px ${SANS}`; g.fillText(d.sym, 44, 200);
      g.fillStyle = soft; g.font = `400 24px ${SANS}`; g.fillText(`${d.wallets} wallet${d.wallets > 1 ? 's' : ''}${d.mins != null ? ' · ' + (d.mins >= 60 ? Math.round(d.mins / 60) + ' h' : d.mins + ' min') : ''}`, 44, 240);
      g.fillStyle = col; g.font = `700 132px ${MONO}`; g.fillText(`${up ? '+' : ''}${d.pct.toFixed(1)}%`, 40, 390);
      if (!hide && d.sol != null) { g.fillStyle = up ? '#CFF7E1' : '#FFD9DF'; g.font = `500 36px ${MONO}`; g.fillText(`${up ? '+' : '−'}◎ ${sol(Math.abs(d.sol))}${d.usd != null ? ' · ' + (up ? '+' : '') + usdV(d.usd) : ''}`, 44, 450); }
      const cells = [['ENTRY', d.entry ? '$' + kfmt(d.entry) : '--'], ['NOW', d.now ? '$' + kfmt(d.now) : '--'], ['INVESTED', hide ? '•••' : d.invested != null ? '◎ ' + sol(d.invested) : '--']];
      cells.forEach(([k, v], i) => { const x = 44 + i * 280; g.fillStyle = soft; g.font = `500 20px ${SANS}`; g.fillText(k, x, 690); g.fillStyle = '#E6E8EC'; g.font = `600 34px ${MONO}`; g.fillText(v, x, 736); });
      return c;
    }
    function shareHtml() {
      const d = shareData();
      if (!d) return `<div class="olp"><div class="sh"><b>Share PnL</b><span class="sp"></span><button class="ib" data-a="panelx" aria-label="Close">${ICON.x}</button></div><div class="mut">Open a coin you hold (or held) to make a card.</div></div>`;
      const key = JSON.stringify([d.sym, d.pct.toFixed(1), d.sol != null && d.sol.toFixed(3), ui.shareHide]);
      if (ui.shareKey !== key) { ui.shareKey = key; try { ui.shareUrl = drawShare(d, ui.shareHide).toDataURL('image/png'); } catch (_) { ui.shareUrl = ''; } }
      return `<div class="olp"><div class="sh"><b>Share PnL</b><span class="sp"></span><button class="ib" data-a="panelx" aria-label="Close">${ICON.x}</button></div>
        ${ui.shareUrl ? `<img class="shimg" src="${ui.shareUrl}" alt="PnL card for ${escH(d.sym)}: ${d.pct >= 0 ? '+' : ''}${d.pct.toFixed(1)}%">` : '<div class="mut">Could not draw the card.</div>'}
        <div class="sh"><label class="adv"><input type="checkbox" data-s="shareHide" ${ui.shareHide ? 'checked' : ''}>Hide SOL amounts</label><span class="sp"></span><button class="btn" data-a="sharecp">Copy image</button><button class="btn pri" data-a="sharedl">Download PNG</button></div></div>`;
    }
    async function shareOut(how) {
      const d = shareData();
      if (!d) return;
      const c = drawShare(d, ui.shareHide);
      if (how === 'dl') { const a = document.createElement('a'); a.href = c.toDataURL('image/png'); a.download = `${d.sym}-pnl.png`; document.body.appendChild(a); a.click(); a.remove(); return toast('PnL card downloaded'); }
      try { const blob = await new Promise((r) => c.toBlob(r, 'image/png')); await navigator.clipboard.write([new window.ClipboardItem({ 'image/png': blob })]); toast('PnL card copied'); }
      catch (_) { toast('Copy blocked by the browser – use Download', true); }
    }

    // ---------------------------------------------------------- hotkeys
    // 1–8 buy tile · ⇧1–8 sell tile · X initials · U unit · S split/each · G next group · Alt+1–3 preset
    // D dip trigger · L paper/LIVE · C collapse · / custom amount · Esc close
    let hovering = false;
    function onHotkey(e) {
      if (!el) return;
      if (ui.modal) { // the dialog owns the keyboard
        if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); closeModal(null); }
        else if (e.key === 'Enter') { const i = ui.modal.actions.findIndex((a) => a.kind === 'pri' || a.kind === 'ok'); if (i >= 0) { e.preventDefault(); e.stopImmediatePropagation(); closeModal(ui.modal.actions[i].v); } }
        return;
      }
      if (st.hotkeys === 'off' || (st.hotkeys === 'hover' && !hovering) || e.ctrlKey || e.metaKey || ui.edit) return;
      const t = e.target;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return; // typing somewhere
      const dm = (e.code || '').match(/^(?:Digit|Numpad)([1-8])$/), k = (e.key || '').toLowerCase();
      let done = true;
      const p = P();
      if (dm && e.altKey) { const i = +dm[1] - 1; if (i < 3) { st.preset = i; save(); render(); toast(`Preset P${i + 1}`); } else done = false; }
      else if (dm && e.shiftKey) { const v = (st.sellUnit === 'sol' ? p.sellSol : p.sell).filter((a) => a > 0)[+dm[1] - 1]; if (v) st.sellUnit === 'sol' ? sellSol(v) : sell(v); else done = false; }
      else if (dm) { const v = (st.buyUnit === 'pct' ? p.sup : st.buyUnit === 'usd' ? p.usd : p.buy).filter((a) => a > 0)[+dm[1] - 1]; if (v) buyUnitAmt(v); else done = false; }
      else if (e.altKey || e.shiftKey) done = false;
      else switch (k) {
        case 'x': sellInit(); break;
        case 'u': st.buyUnit = { sol: 'usd', usd: 'pct', pct: 'sol' }[st.buyUnit] || 'sol'; save(); render(); toast(`Buying in ${{ sol: 'SOL', usd: 'USD', pct: '% of supply' }[st.buyUnit]}`); break;
        case 's': st.buyMode = st.buyMode === 'split' ? 'each' : 'split'; save(); render(); toast(st.buyMode === 'split' ? 'Split the total across wallets' : 'Each wallet buys the amount'); break;
        case 'g': { const gs = [{ id: '__all' }].concat(groupsHere()); const cur = gs.findIndex((g) => g.id !== '__all' && sameSet(buySel(), g.wallets)); const nx = gs[(cur + 1) % gs.length]; useGroup(nx.id); break; }
        case 'd': ui.panel = 'trig'; ui.tf.tab = 'dip'; render(); break;
        case 'l': toggleMode(); break;
        case 'c': ui.collapsed = !ui.collapsed; savePos(); render(); break;
        case '/': { if (ui.collapsed) { ui.collapsed = false; render0(); } const i = el.querySelector('[data-a=camt]'); if (i) i.focus(); break; }
        case 'escape': if (ui.panel) { ui.panel = null; render(); } else done = false; break;
        default: done = false;
      }
      if (done) { e.preventDefault(); e.stopImmediatePropagation(); }
    }

    function mountW() {
      if (document.getElementById('agtw')) return;
      const s = document.createElement('style'); const ti = CSS.indexOf('.agtw-toast'); s.textContent = `#agtw{--k:1px}` + scalePx(CSS.slice(0, ti)) + CSS.slice(ti); document.head.appendChild(s);
      try { const f = document.createElement('link'); f.rel = 'stylesheet'; f.href = 'https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap'; document.head.appendChild(f); } catch (_) {}
      el = document.createElement('div'); el.id = 'agtw';
      el.style.left = (pos0.x ?? 20) + 'px';
      el.style.top = (pos0.y ?? Math.max(8, window.innerHeight - 790)) + 'px';
      document.body.appendChild(el);
      el.addEventListener('click', onClick);
      el.addEventListener('change', onChange);
      el.addEventListener('input', (e) => {
        const d = e.target.dataset;
        if (d.e) ui.draft[draftKey(d.e)] = e.target.value;
        if (d.tf && e.target.type !== 'checkbox') { ui.tf[d.tf] = e.target.value; render(); }
        if (d.se && ui.stratEdit && e.target.type !== 'checkbox' && e.target.tagName !== 'SELECT') { const [k, i] = d.se.split(':'); if (i != null) ui.stratEdit.levels[+i][k] = e.target.value; else ui.stratEdit[k] = e.target.value; render(); }
      });
      el.addEventListener('mouseenter', () => { hovering = true; });
      el.addEventListener('mouseleave', () => { hovering = false; });
      window.addEventListener('keydown', onHotkey, true);
      el.addEventListener('keydown', (e) => {
        if (ui.modal) return; // handled by the window listener
        if (e.key === 'Enter' && e.target.dataset.a === 'camt') buyUnitAmt(e.target.value);
        if (e.key === 'Enter' && e.target.dataset.tf) { e.preventDefault(); addTrigger(); }
        if (e.key === 'Escape' && !ui.edit) { e.target.blur(); }
        if (ui.edit && e.target.dataset.e) {
          if (e.key === 'Enter') { e.preventDefault(); saveEdit(); }
          if (e.key === 'Escape') { ui.edit = false; ui.draft = {}; e.target.blur(); render(); }
        }
        e.stopPropagation(); // keep GMGN / AG hotkeys out of the widget's inputs
      });
      setK(Math.min(1.8, Math.max(0.7, Number(st.scale) || 1)));
      window.addEventListener('resize', () => fit());
      el.addEventListener('dblclick', (e) => { if (e.target.closest('.rz')) { st.scale = 1; save(); setK(1); fit(); } });
      el.addEventListener('mousedown', (e) => {
        if (e.target.closest('.rz')) { // resize: scale the whole widget proportionally
          e.preventDefault();
          const sx = e.clientX, sw = el.offsetWidth, sk = curK;
          const mv = (ev) => setK(Math.min(1.8, Math.max(0.7, (sk * (sw + ev.clientX - sx)) / sw)));
          const up = () => { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); st.scale = +curK.toFixed(3); save(); fit(); toast(`Size ${Math.round(curK * 100)}%`); };
          document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
          return;
        }
        if (!e.target.closest('.h') || e.target.closest('button')) return;
        const ox = e.clientX - el.offsetLeft, oy = e.clientY - el.offsetTop;
        const mv = (ev) => { el.style.left = Math.max(0, ev.clientX - ox) + 'px'; el.style.top = Math.max(0, ev.clientY - oy) + 'px'; };
        const up = () => { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); savePos(); };
        document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
      });
      render();
      loadWallets();
      // follow the current token; refresh the position every 5s
      setInterval(() => {
        if (document.hidden && env === 'ag') return; // nothing to show; the order watcher doesn't need it
        const m = getMint();
        if (m !== lastMint) { lastMint = m; pos = null; trades = null; ui.autoSel = null; autoPending = !!m; sym = m ? getSymbol(m) || '' : ''; srv = { mint: null, list: null, at: 0 }; ui.shareKey = null; render(); if (m) loadPos(); }
        else if (m) { const s2 = getSymbol(m) || ''; if (s2 && s2 !== sym) { sym = s2; render(); } }
      }, 700);
      // position refresh: 5s, stretched up to 30s while the backtester API is slow; never overlaps
      const posTick = async () => {
        if (!document.hidden && getMint() && !ui.busy) await loadPos();
        setTimeout(posTick, 5000 * (env === 'ag' ? bus.slow() : 1));
      };
      setTimeout(posTick, 5000);
      // balances for split buys / planner: refresh every 30s while LIVE (wallets-list is cached 30s on the bus anyway)
      setInterval(() => { if (st.mode === 'live' && !document.hidden && !ui.busy) loadWallets(); }, 30000);
      if (env === 'ag') setInterval(watch, 2500); else startCards();
      loadHeld(); loadDaily();
      const heldTick = async () => { if (!document.hidden || env === 'ag') await loadHeld(); setTimeout(heldTick, 5000); };
      setTimeout(heldTick, 5000);
      setInterval(() => { if (st.mode === 'live' && SF().dailyLoss > 0) loadDaily(); }, 60000);
      setInterval(() => { if (!document.hidden && st.adv && getMint()) loadSrv(); }, 5000);
      if (env === 'ag') setInterval(() => { pollDev().catch(() => {}); }, 15000);
      GM_addValueChangeListener('twAlerts', (_k, _o, v, remote) => { if (remote) for (const a of v || []) showAlert(a); render(); });
      setInterval(() => { if (!document.hidden && (loadAlerts().length || ui.panel === 'trig')) render(); }, 1000);
      try { startStream(); } catch (e) { console.warn('[AG widget] live stream', e); }
      // test hook (only when localStorage.agtwTest = '1'): lets the test-suite drive timers directly
      try { if (localStorage.getItem('agtwTest') === '1') unsafeWindow.__agtw = { watch, pollDev, loadHeld, loadDaily, loadSrv, loadPos, st, ui, ticks, heldAll: () => heldAll, render0 }; } catch (_) {}
      setInterval(() => { if (!document.hidden && posRef && !isLive(getMint())) render(); }, 1000); // "synced Xs ago"
      setInterval(() => { const m = getMint(); if (m && srv.mint !== m && st.adv) loadSrv(); }, 900);
      const prevSold = {};
      for (const o of loadOrders()) prevSold[o.id] = Object.values(o.state || {}).filter((x) => x.sold && x.sold !== 'skip').length;
      GM_addValueChangeListener('twOrders', (_k, _o, v, remote) => {
        el.__html = ''; render();
        if (!remote) return;
        for (const o of v || []) { // tell the GMGN tab when the backtester executed something
          const n = Object.values(o.state || {}).filter((s) => s.sold && s.sold !== 'skip').length;
          if (n > (prevSold[o.id] || 0)) toast(`${o.sym}: ${orderLabel(o)} → sold (${n} wallet${n > 1 ? 's' : ''})`);
          prevSold[o.id] = n;
        }
      });
      // groups / buy mode changed in the other tab (GMGN ↔ backtester share the same storage)
      GM_addValueChangeListener('tw', (_k, _o, v, remote) => {
        if (!remote || !v) return;
        st.groups = Array.isArray(v.groups) ? v.groups : st.groups; st.buyMode = v.buyMode || st.buyMode;
        if (v.mode === st.mode && v.wallets) st.wallets = Object.assign(st.wallets, v.wallets);
        render(); scanCards();
      });
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountW); else mountW();
  }
  // ---------------------------------------------------------------- shared request bus
  // One in-flight request + a short cache per GET path, shared by the AG userscripts on this page
  // (AG Intel and AG Trade Widget define the same bus; whichever loads first owns it). If the page
  // can't be shared (different script worlds) each script simply gets its own copy.
  // Also tracks backend latency so pollers can slow down while the backtester API is struggling.
  function agBus(W, fetchFn) {
    try { const b = W.__agBus; if (b && b.v === 1 && typeof b.get === 'function') return b; } catch (_) {}
    const cache = new Map();
    let lat = 0;
    const bus = {
      v: 1,
      get(path, maxAge) {
        const now = Date.now(), e = cache.get(path);
        if (e) {
          if (e.p) return e.p;
          if (now - e.at < (e.r && e.r.ok ? maxAge : Math.min(maxAge, 3000))) return Promise.resolve(e.r);
        }
        const ph = { at: 0, r: e && e.r, p: null };
        ph.p = fetchFn(path, { credentials: 'same-origin' })
          .then(async (r) => ({ status: r.status, ok: r.ok, j: await r.json().catch(() => ({})) }))
          .catch((err) => ({ status: 0, ok: false, j: { error: String(err) } }))
          .then((r) => {
            const d = Date.now() - now; lat = lat ? lat * 0.7 + d * 0.3 : d;
            if (cache.get(path) === ph) cache.set(path, { at: Date.now(), r, p: null }); // dropped meanwhile → don't cache stale data
            if (cache.size > 300) cache.delete(cache.keys().next().value);
            return r;
          });
        cache.set(path, ph);
        return ph.p;
      },
      drop(prefix) { for (const k of [...cache.keys()]) if (k.startsWith(prefix)) cache.delete(k); },
      lat: () => lat,
      // poll-interval multiplier: 1 when the API answers in <1.5s, up to 6 when it's very slow
      slow: () => Math.max(1, Math.min(6, lat / 1500)),
    };
    try { W.__agBus = bus; } catch (_) {}
    return bus;
  }
})();
