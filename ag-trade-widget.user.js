// ==UserScript==
// @name         AG Trade Widget
// @namespace    milerius.ag.trade
// @version      1.7.0
// @description  Floating quick buy/sell panel (GMGN / Axiom style) that trades through your Alpha Gardeners wallets. P1–P3 presets, multi-wallet with groups, split buys (jitter / stagger), split & consolidate planner, buy by % of supply, paper or LIVE. Works on the AG backtester and on GMGN.
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
// ==/UserScript==

(function () {
  'use strict';
  const MINT_RE = /[1-9A-HJ-NP-Za-km-z]{32,44}/;

  if (/(^|\.)gmgn\.ai$/.test(location.hostname)) {
    // ---------------------------------------------------------------- GMGN
    // Token = the GMGN token page you're on. Orders are relayed through your open backtester tab.
    tradeWidget('gmgn',
      () => (location.pathname.match(/\/sol\/token\/(?:[A-Za-z0-9]+_)?([1-9A-HJ-NP-Za-km-z]{32,44})/) || [])[1] || null,
      () => { const m = document.title.match(/\$?([A-Za-z0-9]{1,15})/); return m ? m[1] : ''; },
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
      /^\/api\/(tokens\/[1-9A-HJ-NP-Za-km-z]{32,44}\/(buy|sell|profile|my-trades|annotations)|performance\/(wallets-list|holdings|wallets\/tx-settings-all))(\?[\w=&.-]*)?$/.test(path);
  }

  function tradeWidget(env, getMint, getSymbol, localCall) {
    const AG = 'https://backtester.alphagardeners.xyz';
    const DEF_PRESET = () => ({ buy: [0.01, 0.1, 0.5, 1, 0.25, 2, 5, 10], sell: [10, 25, 50, 100, 0, 0, 0, 0], sup: [0.1, 0.25, 0.5, 1, 1.5, 2, 3, 5], slippage: 60, fee: 0.001, mev: 'JITO' });
    const st = Object.assign({ mode: 'paper', preset: 0, wallets: { live: [] }, confirmAbove: 2, presets: [DEF_PRESET(), DEF_PRESET(), DEF_PRESET()],
      migPct: 100, protect: { arm: 70, floor: 15, pct: 100 }, qb: 0.1, cards: true,
      // multi-wallet (GMGN / Axiom style)
      groups: [],        // [{id, name, mode, wallets:[addr]}]
      buyMode: 'each',   // 'each' = amount per wallet · 'split' = amount is the total, divided across wallets
      jitter: 0,         // ±% random variation per wallet (sums stay exact in split mode)
      stagger: 0,        // ms between wallets (randomised 0.5–1.5×), 0 = all at once
      reserve: 0.01,     // SOL kept in each wallet for fees / rent (buys + planner)
      buyUnit: 'sol',    // 'sol' = buttons are SOL amounts · 'pct' = buttons are % of the token supply
    }, GM_getValue('tw', {}));
    st.wallets = Object.assign({ live: [], paper: [] }, st.wallets || {});
    st.protect = Object.assign({ arm: 70, floor: 15, pct: 100 }, st.protect || {});
    if (!Array.isArray(st.groups)) st.groups = [];
    const pos0 = GM_getValue('twPos_' + env, {});
    const ui = { collapsed: !!pos0.collapsed, walletOpen: false, setOpen: false, busy: '', fund: null };
    const save = () => GM_setValue('tw', st);
    const savePos = () => GM_setValue('twPos_' + env, { x: el.offsetLeft, y: el.offsetTop, collapsed: ui.collapsed });
    const id = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
    const escH = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const tail = (a) => (a ? a.slice(0, 4) + '…' + a.slice(-4) : '');
    const sol = (v) => (v == null || isNaN(v) ? '--' : (Math.abs(v) >= 100 ? v.toFixed(1) : Math.abs(v) >= 1 ? v.toFixed(2) : v.toFixed(3)));
    const P = () => { const p = st.presets[st.preset] || (st.presets[st.preset] = DEF_PRESET()); if (!Array.isArray(p.sup)) p.sup = DEF_PRESET().sup; return p; };
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
    const selected = () => ui.autoSel || st.wallets[st.mode] || [];
    // paper with nothing selected = all paper wallets (sells / auto orders)
    const inSel = (w) => { const s = selected(); return (st.mode === 'paper' && !s.length) || s.includes(w); };
    function setSel(list) {
      if (ui.autoSel) ui.autoSel = list; else { st.wallets[st.mode] = list; save(); }
    }
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
    const heldBy = () => Object.entries(pos || {}).filter(([w]) => inSel(w));
    function summary() {
      if (!pos) return null;
      const ws = heldBy();
      // Bought / Sold / PnL: token totals from AG's my-trades (all wallets in this mode), so they stay after selling.
      const fromTrades = () => {
        if (!trades) return null;
        const bag = Object.values(pos).reduce((a, h) => a + (num(h.worthSol) || 0), 0);
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
      const mu = mcapUsd(mint);
      if (!(mu > 0) || !(usdRate > 0) || !(pct > 0)) return null;
      const mSol = mu / usdRate, dy = (pct / 100) * SUPPLY, p = mSol / SUPPLY;
      if (/pump$/i.test(mint) && mSol < CURVE_END_MCAP_SOL) {
        const x = Math.sqrt(PUMP_K * p), y = Math.sqrt(PUMP_K / p);
        if (dy < y * 0.98) return { sol: ((x * dy) / (y - dy)) * PUMP_FEE, curve: true, mSol, mu };
      }
      return { sol: (mSol * pct) / 100, curve: false, mSol, mu };
    }
    // % mode: "each" → every wallet gets pct% (priced as one combined buy, then divided); "split" → pct% in total.
    function pctWallets() { return st.mode === 'live' ? Math.max(1, selected().length) : 1; }
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

    // ---------------------------------------------------------- orders
    function report(side, res, label) {
      const ok = res.filter((r) => r && r.ok).length, bad = res.filter((r) => !r || !r.ok);
      const errs = [...new Set(bad.map((r) => (r && r.j && (r.j.error || r.j.message)) || (r && r.status === 409 ? 'already in progress' : 'failed')))];
      toast(`${side} ${label}: ${ok}/${res.length} submitted${errs.length ? ' · ' + errs.join('; ') : ''}`, !ok);
      setTimeout(loadPos, 2500); setTimeout(loadPos, 8000);
    }
    // Multi-wallet buy legs (GMGN / Axiom conventions):
    //  each  → every wallet buys `amount`          split → `amount` is the total, divided across wallets
    //  jitter → ±% random size per wallet (split keeps the exact total) so the buys don't look bundled
    //  wallets whose known balance can't cover their leg + the fee reserve are skipped (split re-divides)
    function buyLegs(amount, ws) {
      const split = st.buyMode === 'split', j = Math.min(0.5, Math.max(0, Number(st.jitter) || 0) / 100);
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
    async function buy(amount, mintArg, symArg, note) {
      const mint = mintArg || getMint();
      amount = Number(amount);
      if (!mint) return toast('Open a token first', true);
      if (!(amount > 0) || ui.busy) return;
      const live = st.mode === 'live';
      const ws = live ? (mintArg ? st.wallets.live || [] : selected()) : [null]; // paper: one paper account, no wallet address
      if (!ws.length) return toast('Select at least one wallet', true);
      const { legs, skipped } = live ? buyLegs(amount, ws) : { legs: [{ w: null, amt: amount }], skipped: [] };
      if (!legs.length) return toast(`Buy: no selected wallet can cover it (+${st.reserve} SOL reserve) · ${skipped.join(', ')}`, true);
      const total = +legs.reduce((a, x) => a + x.amt, 0).toFixed(6);
      const multi = legs.length > 1;
      if (live && total > Number(st.confirmAbove || 0) &&
        !confirm(`LIVE BUY ${total} SOL on ${legs.length} wallet${multi ? 's' : ''} (${st.buyMode === 'split' ? 'split' : 'each'})\n${symArg || sym || tail(mint)} (${mint})${note ? '\n' + note : ''}\n\n` +
          legs.map((x) => `${labelOf(x.w)}: ${x.amt} SOL`).join('\n') +
          (Number(st.stagger) > 0 && multi ? `\n\nStaggered ~${st.stagger} ms apart` : '') +
          (skipped.length ? `\n\nSkipped (low balance): ${skipped.join(', ')}` : ''))) return;
      ui.busy = 'buy'; render();
      const mk = (x) => ({ method: 'POST', path: `/api/tokens/${mint}/buy`,
        body: { amount: x.amt, source: st.mode, idempotencyKey: id(), ...(x.w ? { walletAddress: x.w } : {}) } });
      let res;
      if (Number(st.stagger) > 0 && multi) {
        res = [];
        for (let i = 0; i < legs.length; i++) {
          if (i) await sleep(Number(st.stagger) * (0.5 + Math.random()));
          ui.busy = `buy ${i + 1}/${legs.length}`; render();
          const [r] = await call([mk(legs[i])], true);
          res.push(r);
        }
      } else res = await call(legs.map(mk), true);
      ui.busy = ''; render();
      const lbl = multi ? (st.buyMode === 'split' ? `${total} SOL ÷${legs.length}` : `${amount} SOL ×${legs.length}`) : `${legs[0].amt} SOL`;
      report('Buy', res, `${note ? note.split(' @')[0] + ' · ' : ''}${lbl}${mintArg ? ' of ' + (symArg || tail(mint)) : ''}`);
      if (skipped.length) setTimeout(() => toast('Skipped (low balance): ' + skipped.join(', '), true), 1200);
      if (live) setTimeout(() => loadWallets(true), 8000); // refresh balances
      if (mintArg) { setTimeout(loadHeld, 2500); setTimeout(loadHeld, 8000); }
    }
    async function sell(pct) {
      const mint = getMint();
      pct = Number(pct);
      if (!mint) return toast('Open a token first', true);
      if (!(pct > 0) || ui.busy) return;
      ui.busy = 'sell'; render();
      await loadPos();
      let ws = Object.keys(pos || {});
      ws = ws.filter(inSel);
      if (!ws.length) { ui.busy = ''; render(); return toast('No position in the selected wallet(s)', true); }
      const res = await call(ws.map((w) => ({ method: 'POST', path: `/api/tokens/${mint}/sell`,
        body: { percent: pct, source: st.mode, idempotencyKey: id(), walletAddress: w } })), true);
      ui.busy = ''; render();
      report('Sell', res, `${pct}%${ws.length > 1 ? ' ×' + ws.length : ''}`);
    }
    // Sell initials: per wallet, sell just enough to take out what you put in (cost − already sold).
    async function sellInit() {
      const mint = getMint();
      if (!mint) return toast('Open a token first', true);
      if (ui.busy) return;
      ui.busy = 'sell init'; render();
      await loadPos();
      const plan = [], skipped = [];
      for (const [w, h] of heldBy()) {
        const name = labelOf(w);
        const ip = initPlan(h);
        if (ip.skip) { skipped.push(`${name}: ${ip.skip}`); continue; }
        plan.push({ w, pct: ip.pct, need: ip.need });
      }
      if (!plan.length) { ui.busy = ''; render(); return toast('Sell initials: nothing to sell · ' + (skipped.join(' · ') || 'no position in the selected wallet(s)'), true); }
      if (st.mode === 'live' && !confirm(`LIVE · Sell initials on ${plan.length} wallet${plan.length > 1 ? 's' : ''}:\n` +
        plan.map((x) => `${labelOf(x.w)}: sell ${x.pct}% (≈${sol(x.need)} SOL)`).join('\n') +
        (skipped.length ? `\n\nSkipped: ${skipped.join('; ')}` : ''))) { ui.busy = ''; return render(); }
      const res = await call(plan.map((x) => ({ method: 'POST', path: `/api/tokens/${mint}/sell`,
        body: { percent: x.pct, source: st.mode, idempotencyKey: id(), walletAddress: x.w } })), true);
      ui.busy = ''; render();
      report('Sell initials', res, plan.length > 1 ? `×${plan.length}` : `${plan[0].pct}%`);
      if (skipped.length) setTimeout(() => toast('Skipped: ' + skipped.join(' · ')), 1200);
    }

    // ---------------------------------------------------------- wallet groups
    // Named wallet sets per mode (Axiom / GMGN "wallet groups"): one click selects the group for buys,
    // sells and new auto orders.
    const groupsHere = () => st.groups.filter((g) => g.mode === st.mode);
    function useGroup(gid) {
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

    // ---------------------------------------------------------- split / consolidate planner
    // AG keeps the wallet keys server-side and exposes no wallet-to-wallet transfer endpoint, so this only
    // PLANS the transfers (Axiom-style: source wallets → destination, or even split). Execute them yourself.
    function fundPlan() {
      const f = ui.fund, ws = selected().filter((w) => balOf(w) != null);
      const reserve = Math.max(0, Number(st.reserve) || 0), MIN = 0.001;
      if (ws.length < 2) return { err: 'Select at least 2 live wallets (with known balances).' };
      const bal = Object.fromEntries(ws.map((w) => [w, balOf(w)]));
      const total = ws.reduce((a, w) => a + bal[w], 0);
      const tx = [];
      if (f.kind === 'cons') {
        const dest = ws.includes(f.dest) ? f.dest : (ws.find((w) => (wallets.find((x) => x.address === w) || {}).isMain) || ws[0]);
        f.dest = dest;
        for (const w of ws) if (w !== dest) { const a = Math.floor((bal[w] - reserve) * 1e4) / 1e4; if (a >= MIN) tx.push({ from: w, to: dest, amt: a }); }
        return { tx, total, note: `Everything above ${reserve} SOL per wallet → ${labelOf(dest)}` };
      }
      // even split: greedy match donors (above target) with receivers (below target)
      const target = total / ws.length;
      const don = ws.filter((w) => bal[w] - target >= MIN).map((w) => ({ w, x: bal[w] - target })).sort((a, b) => b.x - a.x);
      const rec = ws.filter((w) => target - bal[w] >= MIN).map((w) => ({ w, x: target - bal[w] })).sort((a, b) => b.x - a.x);
      let i = 0, k = 0;
      while (i < don.length && k < rec.length) {
        const a = Math.min(don[i].x, rec[k].x);
        if (a >= MIN) tx.push({ from: don[i].w, to: rec[k].w, amt: Math.floor(a * 1e4) / 1e4 });
        don[i].x -= a; rec[k].x -= a;
        if (don[i].x < MIN) i++;
        if (rec[k].x < MIN) k++;
      }
      return { tx, total, note: `Target ≈ ${sol(target)} SOL per wallet (${ws.length} wallets)` };
    }
    function fundPanel() {
      if (!ui.fund) return '';
      if (st.mode !== 'live') return `<div class="wl"><div class="mut">The split / consolidate planner is for LIVE wallets (paper has no real SOL to move).</div></div>`;
      const f = ui.fund, p = fundPlan(), sel = selected();
      const head = `<div class="q"><select data-f="kind" style="width:auto"><option value="split" ${f.kind === 'split' ? 'selected' : ''}>Split evenly</option><option value="cons" ${f.kind === 'cons' ? 'selected' : ''}>Consolidate →</option></select>
        ${f.kind === 'cons' ? `<select data-f="dest">${sel.map((w) => `<option value="${escH(w)}" ${f.dest === w ? 'selected' : ''}>${escH(labelOf(w))}</option>`).join('')}</select>` : '<span class="sp"></span>'}
        <button data-a="fundrf" title="Refresh balances">↻</button></div>`;
      if (p.err) return `<div class="wl">${head}<div class="mut">${escH(p.err)}</div></div>`;
      const rows = p.tx.map((t) => `<div class="orow"><span><button class="cp" data-cp="${escH(t.from)}" title="Copy ${escH(t.from)}">${escH(labelOf(t.from))}</button> → <button class="cp" data-cp="${escH(t.to)}" title="Copy ${escH(t.to)}">${escH(labelOf(t.to))}</button></span><b>${t.amt} ◎</b></div>`).join('');
      return `<div class="wl">${head}
        <div class="mut" style="margin:2px 0 4px">${escH(p.note)} · total ${sol(p.total)} ◎ · keep ${st.reserve} ◎ each</div>
        ${rows || '<div class="up">Already balanced – nothing to move.</div>'}
        ${p.tx.length ? '<button data-a="fundcp" style="width:100%;margin-top:6px">Copy plan</button>' : ''}
        <div class="mut" style="font-size:10px;margin-top:5px">AG has no wallet-to-wallet transfer API, so the widget can't move SOL itself. Click a wallet name to copy its address and run these transfers wherever you move funds.</div></div>`;
    }
    function copy(text, what) {
      (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(() => toast(`Copied ${what}`), () => { prompt('Copy:', text); });
    }

    // ---------------------------------------------------------- auto orders
    // Saved in this script's storage (shared by the GMGN and backtester tabs). They are executed by ONE
    // backtester tab (leader lock), so keep the backtester open for orders to fire.
    //  mig      = sell X% when the coin migrates (AG's own migration signal: /annotations → migration.t)
    //  miginit  = sell initials when the coin migrates
    //  protect  = per wallet: once PnL ≥ +arm%, sell if it falls back to ≤ +floor% (AG's PnL vs your entry)
    const loadOrders = () => GM_getValue('twOrders', []) || [];
    const saveOrders = (list) => GM_setValue('twOrders', list.filter((o) => o.status === 'active' || Date.now() - (o.doneAt || 0) < 6 * 3600e3).slice(-200));
    const orderLabel = (o) => o.type === 'mig' ? `Sell ${o.pct}% @ migration` : o.type === 'miginit' ? 'Sell initials @ migration'
      : `Protect +${o.arm}%→+${o.floor}% (sell ${o.pct}%)`;
    function addOrder(type) {
      const mint = getMint();
      if (!mint) return toast('Open a token first', true);
      const live = st.mode === 'live', ws = selected().length ? selected().slice() : null; // null = all (paper only)
      if (live && !ws) return toast('Select at least one wallet', true);
      const o = { id: id(), type, mint, sym: sym || tail(mint), mode: st.mode, wallets: ws, created: Date.now(), status: 'active', state: {}, log: [],
        pct: type === 'protect' ? Number(st.protect.pct) || 100 : Number(st.migPct) || 100, arm: Number(st.protect.arm), floor: Number(st.protect.floor) };
      if (type === 'protect' && !(o.arm > o.floor)) return toast('Protect: arm % must be above the sell-back %', true);
      const list = loadOrders();
      if (list.some((x) => x.status === 'active' && x.mint === mint && x.type === type && x.mode === st.mode)) return toast('That order already exists for this token', true);
      if (live && !confirm(`LIVE auto order on ${o.sym}:\n${orderLabel(o)}\nWallets: ${(ws || []).map(labelOf).join(', ')}\n\nRuns from your open backtester tab.`)) return;
      list.push(o); saveOrders(list);
      toast(`Order saved: ${orderLabel(o)}${env !== 'ag' && Date.now() - (GM_getValue('agRelayAt', 0) || 0) > 30000 ? ' · open the backtester tab so it can run' : ''}`);
      render();
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
    let watching = false;
    async function watch() {
      if (watching) return;
      const act = loadOrders().filter((o) => o.status === 'active');
      if (!act.length || !isLeader()) return; // no orders → no storage writes, no requests
      watching = true;
      try {
        const now = Date.now(), upd = new Map(), fullThisTick = new Set(); // mint:wallet already fully sold this tick
        const modes = [...new Set(act.map((o) => o.mode))];
        const migMints = [...new Set(act.filter((o) => o.type !== 'protect').map((o) => o.mint))];
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
          if (o.type === 'protect') {
            for (const w of ws) {
              const h = hs[w]; if (h.pnlPct == null) continue;
              const s = o.state[w] || (o.state[w] = { peak: h.pnlPct });
              s.peak = Math.max(s.peak, h.pnlPct); s.last = h.pnlPct;
              if (!s.armed && s.peak >= o.arm) { s.armed = now; logp(`armed ${tail(w)} (peak +${s.peak.toFixed(1)}%)`); }
              if (s.armed && !s.sold && h.pnlPct <= o.floor && (s.tries || 0) < 3 && (!s.lastTry || now - s.lastTry > 15000)) sells.push({ w, pct: o.pct });
            }
            const tracked = Object.keys(o.state);
            if (tracked.length && tracked.every((w) => o.state[w].sold || !hs[w])) { o.status = 'done'; o.doneAt = now; logp('position closed'); }
          } else if (migrated[o.mint]) {
            if (!o.migSeen) { o.migSeen = now; logp('migration detected'); }
            for (const w of ws) {
              const s = o.state[w] || (o.state[w] = {});
              if (s.sold || (s.tries || 0) >= 3 || (s.lastTry && now - s.lastTry < 15000)) continue;
              if (o.type === 'mig') { sells.push({ w, pct: o.pct }); continue; }
              const ip = initPlan(hs[w]);
              if (ip.skip) { s.sold = 'skip'; logp(`${tail(w)} skipped: ${ip.skip}`); continue; }
              sells.push({ w, pct: ip.pct });
            }
            if (!ws.length || ws.every((w) => o.state[w] && o.state[w].sold)) { o.status = 'done'; o.doneAt = now; if (!ws.length) logp('migrated, no position left'); }
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
            toast(`${o.sym}: ${orderLabel(o)} → sold on ${rs.filter((r) => r && r.ok).length}/${sells.length} wallet(s)`, !rs.some((r) => r && r.ok));
            if (o.type !== 'protect' && ws.every((w) => o.state[w] && o.state[w].sold)) { o.status = 'done'; o.doneAt = now; }
            if (o.type === 'protect' && ws.length && ws.every((w) => o.state[w] && o.state[w].sold)) { o.status = 'done'; o.doneAt = now; }
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
      if (!confirm(`Apply P${st.preset + 1} transaction settings to ALL your ${st.mode.toUpperCase()} AG wallets?\n\nSlippage ${p.slippage}% · Priority fee ${p.fee} SOL · MEV ${p.mev}\n\nThese are the wallets' own AG settings, so the AG bot uses them too.`)) return;
      const res = await call([
        { method: 'POST', path: '/api/performance/wallets/tx-settings-all', body: { slippage: Number(p.slippage), source: st.mode } },
        { method: 'POST', path: '/api/performance/wallets/tx-settings-all', body: { priorityFeeSol: Number(p.fee), source: st.mode } },
        { method: 'POST', path: '/api/performance/wallets/tx-settings-all', body: { mevProtection: p.mev, source: st.mode } },
      ], true);
      const ok = res.filter((r) => r && r.ok).length;
      toast(ok === 3 ? `P${st.preset + 1} tx settings applied to your ${st.mode} wallets` : `Tx settings: ${ok}/3 applied · ${(res.find((r) => !r || !r.ok) || {}).j?.error || 'error'}`, ok !== 3);
    }

    // ---------------------------------------------------------- UI
    const CSS = `
    #agtw{position:fixed;z-index:100001;width:330px;background:#0d1117f5;border:1px solid #2b3240;border-radius:12px;color:#d1d5db;
      font:12px/1.35 Inter,system-ui,sans-serif;box-shadow:0 10px 34px #000a;user-select:none}
    #agtw *{box-sizing:border-box}
    #agtw .h{display:flex;align-items:center;gap:6px;padding:7px 9px;border-bottom:1px solid #222a36;cursor:move}
    #agtw .h b{color:#a3e635;letter-spacing:.04em;font-size:11.5px}
    #agtw .sp{flex:1}
    #agtw button{background:#1a212d;border:1px solid #2f3747;color:#d1d5db;border-radius:7px;padding:2px 8px;font:inherit;cursor:pointer}
    #agtw button:disabled{opacity:.45;cursor:default}
    #agtw .md.live{background:#7f1d1d;border-color:#ef4444;color:#fff;font-weight:700}
    #agtw .md.paper{color:#93c5fd}
    #agtw .bd{padding:8px 10px 9px}
    #agtw.col .bd,#agtw.col .wl,#agtw.col .st{display:none}
    #agtw .tg{font-size:11px;color:#8b95a7;margin-bottom:6px;display:flex;justify-content:space-between;gap:6px}
    #agtw .tg b{color:#e5e7eb}
    #agtw .row{display:flex;align-items:center;gap:6px;margin:4px 0 6px}
    #agtw .row .t{font-weight:600;color:#e5e7eb}
    #agtw .pr{background:none;border:none;color:#6b7280;padding:0 3px}
    #agtw .pr.on{color:#86efac}
    #agtw .bm{padding:0 6px;font-size:10.5px;color:#c4b5fd;border-color:#8b5cf688}
    #agtw .g button small{display:block;font-size:9.5px;font-weight:400;color:#86efacaa;margin-top:1px}
    #agtw .bm.u{color:#fde68a;border-color:#fbbf2488}
    #agtw .gr{display:flex;flex-wrap:wrap;gap:4px;margin:-2px 0 6px}
    #agtw .gr button{padding:0 7px;font-size:10.5px;border-radius:10px;color:#9ca3af}
    #agtw .gr button.on{color:#0d1117;background:#a3e635;border-color:#a3e635;font-weight:700}
    #agtw .g{display:grid;grid-template-columns:repeat(4,1fr);gap:6px}
    #agtw .g button{padding:6px 0;font-weight:600;border-radius:7px;background:transparent}
    #agtw .gb button{border-color:#86efac88;color:#bbf7d0}#agtw .gb button:hover:not(:disabled){background:#14532d55}
    #agtw .gs button{border-color:#f8717188;color:#fecaca}#agtw .gs button:hover:not(:disabled){background:#7f1d1d55}
    #agtw .cu{display:flex;gap:6px;margin-top:6px}
    #agtw input,#agtw select{width:100%;background:#151b26;border:1px solid #2b3240;border-radius:6px;color:#e5e7eb;padding:4px 6px;font:inherit}
    #agtw .cu input{flex:1}
    #agtw .meta{font-size:10.5px;color:#6b7280;margin-top:5px}
    #agtw hr{border:0;border-top:1px solid #222a36;margin:8px 0}
    #agtw .ft{display:grid;grid-template-columns:repeat(4,1fr);text-align:center;margin-top:8px;border-top:1px solid #222a36;padding-top:6px}
    #agtw .ft div div:first-child{font-size:10px;color:#6b7280}
    #agtw .ft>div>div:nth-child(2){font-weight:600}
    #agtw .ft .u{font-size:10px;color:#8b95a7;font-weight:400}
    #agtw .g3{display:grid;grid-template-columns:repeat(3,1fr);gap:6px}
    #agtw .g3 button{padding:5px 0;font-size:11px;font-weight:600;border-color:#fbbf2488;color:#fde68a;background:transparent}
    #agtw .olist{margin-top:6px}
    #agtw .orow{display:flex;justify-content:space-between;align-items:center;gap:6px;font-size:10.5px;padding:2px 0;border-bottom:1px dashed #222a36}
    #agtw .orow .y{color:#fde68a}
    #agtw .x{padding:0 5px;line-height:1.2;border-color:#7f1d1d;color:#fca5a5}
    #agtw .cp{padding:0 5px;font-size:10.5px;border-color:#374151;color:#e5e7eb}
    #agtw .ini{border-color:#f8717188;color:#fecaca;background:transparent;font-weight:600;padding:3px 10px}
    #agtw .up{color:#86efac}#agtw .dn{color:#fca5a5}
    #agtw .wl,#agtw .st{border-bottom:1px solid #222a36;padding:7px 10px;max-height:260px;overflow:auto}
    #agtw .wl label{display:flex;align-items:center;gap:6px;padding:3px 0;cursor:pointer}
    #agtw .wl label input{width:auto}
    #agtw .wl .q{display:flex;gap:5px;margin-bottom:5px;align-items:center}
    #agtw .wl .q select{flex:1}
    #agtw .gl{display:flex;flex-wrap:wrap;gap:4px;margin:6px 0 2px;padding-top:6px;border-top:1px dashed #222a36}
    #agtw .gl span{display:inline-flex;align-items:center;gap:3px;background:#151b26;border:1px solid #2b3240;border-radius:10px;padding:0 3px 0 7px;font-size:10.5px}
    #agtw .st label{display:block;font-size:10.5px;color:#8b95a7;margin:5px 0}
    #agtw .st .two{display:grid;grid-template-columns:1fr 1fr;gap:0 8px}
    #agtw .st .three{display:grid;grid-template-columns:1fr 1fr 1fr;gap:0 8px}
    #agtw .mut{color:#6b7280}
    .agtw-toast{position:fixed;z-index:100002;left:50%;bottom:24px;transform:translateX(-50%);max-width:520px;padding:8px 14px;border-radius:8px;
      font:600 12.5px system-ui,sans-serif;box-shadow:0 6px 24px #0008;background:#14532d;color:#dcfce7;border:1px solid #22c55e}
    .agtw-toast.err{background:#7f1d1d;color:#fee2e2;border-color:#ef4444}`;

    function oRow(o, showSym) {
      const armed = Object.values(o.state || {}).filter((s) => s.armed).length, sold = Object.values(o.state || {}).filter((s) => s.sold && s.sold !== 'skip').length;
      const st8 = o.status !== 'active' ? `<span class="${o.status === 'done' ? 'up' : 'mut'}">${o.status}</span>`
        : o.type === 'protect' ? (armed ? `<span class="y">armed ${armed}</span>` : '<span class="mut">waiting</span>') : (o.migSeen ? '<span class="y">migrated</span>' : '<span class="mut">waiting</span>');
      const peak = o.type === 'protect' ? Object.values(o.state || {}).map((s) => s.peak).filter((v) => v != null) : [];
      return `<div class="orow" title="${escH((o.log || []).join('\n'))}">
        <span>${showSym ? `<b>${escH(o.sym)}</b> ` : ''}${escH(orderLabel(o))} <span class="mut">${o.mode === 'live' ? 'LIVE' : 'paper'}${o.wallets ? ' · ' + o.wallets.length + 'w' : ''}${peak.length ? ' · pk +' + Math.max(...peak).toFixed(0) + '%' : ''}${sold ? ' · sold ' + sold : ''}</span></span>
        <span>${st8}${o.status === 'active' ? ` <button class="x" data-oc="${o.id}" title="Cancel">×</button>` : ''}</span></div>`;
    }
    function tokOrders(mint, all) {
      if (!mint) return '';
      const l = (all || loadOrders()).filter((o) => o.mint === mint && (o.status === 'active' || Date.now() - (o.doneAt || 0) < 600e3));
      return l.length ? `<div class="olist">${l.map((o) => oRow(o, false)).join('')}</div>` : '';
    }
    function ordersPanel(all) {
      const l = (all || loadOrders()).filter((o) => o.status === 'active');
      return `<div class="wl"><div class="mut" style="margin-bottom:4px">Active auto orders (all tokens). Hover for the log.</div>${l.map((o) => oRow(o, true)).join('') || '<div class="mut">None.</div>'}</div>`;
    }
    function groupChips() {
      const gs = groupsHere();
      if (!gs.length) return '';
      const sel = selected();
      return `<div class="gr">${gs.map((g) => `<button data-g="${g.id}" class="${!ui.autoSel && sameSet(sel, g.wallets) ? 'on' : ''}" title="${escH(g.wallets.map(labelOf).join(', '))}">${escH(g.name)} · ${g.wallets.length}</button>`).join('')}</div>`;
    }

    // ---------------------------------------------------------- GMGN card overlay
    // On every GMGN token card / table row: your position (all wallets in the current mode) with PnL,
    // plus a ⚡ quick-buy button (amount in ⚙, uses the current mode, buy mode and your default wallet selection).
    let held = {};
    const CARD_MINT = /\/sol\/token\/(?:[A-Za-z0-9]+_)?([1-9A-HJ-NP-Za-km-z]{32,44})/;
    let heldBusy = null;
    function loadHeld() { return heldBusy || (heldBusy = loadHeld0().finally(() => { heldBusy = null; })); }
    async function loadHeld0() {
      if (env === 'ag' || !st.cards) return;
      const [r] = await call([{ method: 'GET', path: `/api/performance/holdings?source=${st.mode}` }]);
      if (!r || !r.ok || !r.j.byWallet) return;
      const m = {};
      for (const x of Object.values(r.j.byWallet)) for (const h of x.holdings || []) {
        const worth = num(h.worthSol);
        if (!h.tokenAddress || worth == null || worth < 0.0005) continue; // dust = closed
        if (num(h.worthUsd) > 0 && worth > 0) usdRate = num(h.worthUsd) / worth;
        const a = m[h.tokenAddress] || (m[h.tokenAddress] = { worth: 0, pnl: 0, n: 0 });
        a.worth += worth; a.pnl += num(h.pnlSol) || 0; a.n++;
      }
      held = m; scanCards();
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
      const heldTick = async () => { if (!document.hidden) await loadHeld(); setTimeout(heldTick, 5000); };
      setTimeout(heldTick, 5000);
    }

    let el;
    function toast(msg, err) {
      const t = document.createElement('div');
      t.className = 'agtw-toast' + (err ? ' err' : ''); t.textContent = msg;
      document.body.appendChild(t); setTimeout(() => t.remove(), 5000);
    }

    let rq = 0;
    // coalesce bursts of render() calls (data + clicks + timers) into one per animation frame
    function render() { if (!rq) rq = requestAnimationFrame(() => { rq = 0; render0(); }); if (document.hidden) { cancelAnimationFrame(rq); rq = 0; render0(); } }
    function render0() {
      if (!el) return;
      const ae0 = document.activeElement;
      if (ae0 && el.contains(ae0) && ae0.tagName === 'INPUT') return; // don't wipe what the user is typing
      const mint = getMint(), p = P(), live = st.mode === 'live', sm = summary(), orders = loadOrders();
      const selN = live ? selected().length : selected().length || 'all';
      const dis = !mint || ui.busy ? 'disabled' : '';
      const fmtPct = (v) => (v == null ? '--' : (v >= 0 ? '+' : '') + v.toFixed(1) + '%');
      const split = st.buyMode === 'split', pm = st.buyUnit === 'pct';
      const est = (a) => { const c = mint && pctToSol(a, mint); return c ? sol(c.sol) + '◎' : '—'; };
      const mu = pm && mint ? mcapUsd(mint) : null;
      let walletHtml = '';
      if (ui.walletOpen) {
        const selBal = selected().reduce((a, w) => a + (balOf(w) || 0), 0);
        walletHtml = `<div class="wl">${live ? `<div class="q"><button data-w="all">All</button><button data-w="none">None</button><button data-w="main">Main</button>
          <span class="sp"></span><span class="mut">${selected().length} · ${sol(selBal)}◎</span><button data-w="reload">↻</button></div>
          ${ui.autoSel ? '<div class="mut" style="margin-bottom:4px">Auto: wallets holding this token. Changes here apply to this token only.</div>' : ''}` : `<div class="q"><button data-w="all">All</button><button data-w="none">None</button><span class="sp"></span><button data-w="reload">↻</button></div>
          <div class="mut" style="margin-bottom:4px">Paper: selection applies to sells & auto orders (none = all). Paper buys go to your main paper wallet.</div>
          ${ui.autoSel ? '<div class="mut" style="margin-bottom:4px">Auto: wallets holding this token.</div>' : ''}`}
          ${walletErr ? `<div class="dn">${escH(walletErr)}</div>` : ''}
          ${wallets.map((w) => `<label><input type="checkbox" data-wa="${escH(w.address || '')}" ${selected().includes(w.address) ? 'checked' : ''} ${w.address ? '' : 'disabled'}>
            <span>${escH(w.label || 'Wallet')}${w.isMain ? ' <span class="mut">(main)</span>' : ''}</span><span class="sp"></span>${num(w.balanceSol) != null ? `<span>${sol(num(w.balanceSol))}◎</span>` : ''}<span class="mut">${tail(w.address)}</span>
            ${pos && pos[w.address] ? `<span class="${(pos[w.address].pnlPct || 0) >= 0 ? 'up' : 'dn'}">${fmtPct(pos[w.address].pnlPct)}</span>` : ''}</label>`).join('') || (walletErr ? '' : '<div class="mut">Loading wallets…</div>')}
          <div class="gl">${groupsHere().map((g) => `<span>${escH(g.name)} · ${g.wallets.length}<button class="x" data-gd="${g.id}" title="Delete group">×</button></span>`).join('') || '<span class="mut" style="border:0;background:none;padding:0">No groups yet.</span>'}</div>
          <div class="q" style="margin:6px 0 0"><button data-w="gsave" style="flex:1">＋ Save selection as group</button>${live ? '<button data-w="fund" style="flex:1">💸 Split / consolidate</button>' : ''}</div></div>`;
      }
      const setHtml = !ui.setOpen ? '' : `<div class="st">
        <div class="mut">P${st.preset + 1} preset · buttons & transaction settings</div>
        <label>Buy amounts (SOL, 8, comma separated)<input data-s="buy" value="${p.buy.join(', ')}"></label>
        <label>Buy % of supply (8, comma separated)<input data-s="sup" value="${p.sup.join(', ')}"></label>
        <label>Sell % (8, comma separated, 0 = unused)<input data-s="sell" value="${p.sell.join(', ')}"></label>
        <div class="two">
          <label>Slippage %<input type="number" data-s="slippage" value="${p.slippage}"></label>
          <label>Priority fee (SOL)<input type="number" step="0.0001" data-s="fee" value="${p.fee}"></label>
          <label>MEV<select data-s="mev">${['JITO', 'HELIUS', 'DISABLED'].map((m) => `<option ${p.mev === m ? 'selected' : ''}>${m}</option>`).join('')}</select></label>
          <label>Confirm LIVE buys above (SOL total)<input type="number" step="0.1" data-s="confirmAbove" value="${st.confirmAbove}"></label>
        </div>
        <div class="mut" style="margin-top:6px">Multi-wallet buys (all presets)</div>
        <div class="three">
          <label title="±% random size per wallet; split keeps the exact total">Jitter ±%<input type="number" min="0" max="50" data-s="jitter" value="${st.jitter}"></label>
          <label title="Delay between wallets, randomised 0.5–1.5×. 0 = all at once">Stagger ms<input type="number" min="0" step="50" data-s="stagger" value="${st.stagger}"></label>
          <label title="SOL kept in each wallet for fees/rent; wallets that can't cover their buy + this are skipped">Keep ◎<input type="number" min="0" step="0.005" data-s="reserve" value="${st.reserve}"></label>
        </div>
        <div class="mut" style="margin-top:6px">GMGN cards</div>
        <div class="two">
          <label>Quick buy (SOL)<input type="number" step="0.01" data-s="qb" value="${st.qb}"></label>
          <label style="display:flex;align-items:center;gap:6px;margin-top:18px"><input type="checkbox" data-s="cards" style="width:auto" ${st.cards ? 'checked' : ''}> Show holdings + quick buy</label>
        </div>
        <div class="mut" style="margin-top:6px">Auto orders (all presets)</div>
        <div class="two">
          <label>Sell @ migration %<input type="number" data-s="migPct" value="${st.migPct}"></label>
          <label>Protect: sell %<input type="number" data-s="protPct" value="${st.protect.pct}"></label>
          <label>Protect: arm at PnL ≥ +%<input type="number" data-s="protArm" value="${st.protect.arm}"></label>
          <label>Protect: sell back at ≤ +%<input type="number" data-s="protFloor" value="${st.protect.floor}"></label>
        </div>
        <button data-a="pushtx" style="width:100%;margin-top:4px">Apply P${st.preset + 1} tx settings to my ${st.mode} AG wallets</button>
        <div class="mut" style="font-size:10px;margin-top:4px">AG stores slippage / fee / MEV per wallet, not per order, so this updates the wallets themselves (the AG bot uses them too).</div>
      </div>`;
      const multiMeta = live ? (selN > 1 ? ` · ${split ? 'split ÷' + selN : '×' + selN + ' wallets'}${Number(st.jitter) ? ' · ±' + st.jitter + '%' : ''}${Number(st.stagger) ? ' · ' + st.stagger + 'ms' : ''}` : ` · ${selN} wallet${selN === 1 ? '' : 's'}`) : ' · paper buys → main paper wallet';
      const html = `
        <div class="h"><b>AG ⚡</b>
          <button class="md ${live ? 'live' : 'paper'}" data-a="mode" title="Switch paper / LIVE">${live ? 'LIVE' : 'PAPER'}</button>
          <span class="sp"></span>
          <button data-a="olist" title="Active auto orders (all tokens)">⏱ ${orders.filter((o) => o.status === 'active').length}</button>
          <button data-a="wal" title="${ui.autoSel ? 'Auto-selected: wallets holding this token' : 'Wallets & groups'}">👛 ${selN}${ui.autoSel ? ' <span style="color:#a3e635">auto</span>' : ''} ▾</button>
          <button data-a="set" title="Edit preset">⚙</button>
          <button data-a="col">${ui.collapsed ? '▢' : '–'}</button></div>
        ${walletHtml}${ui.walletOpen ? fundPanel() : ''}${setHtml}${ui.olist ? ordersPanel(orders) : ''}
        <div class="bd">
          <div class="tg">${mint ? `<span><b>${escH(sym || 'Token')}</b> <span class="mut">${tail(mint)}</span></span>` : '<span>Open a token to trade</span>'}
            <span>${ui.busy ? ui.busy + '…' : ''}</span></div>
          ${groupChips()}
          <div class="row"><span class="t">Buy</span>${[0, 1, 2].map((i) => `<button class="pr ${st.preset === i ? 'on' : ''}" data-p="${i}">P${i + 1}</button>`).join('')}
            <span class="sp"></span>${live ? `<button class="bm" data-a="bmode" title="${split ? 'Split: the amount is the TOTAL, divided across the selected wallets. Click for per-wallet.' : 'Each: every selected wallet buys the amount. Click to split the total instead.'}">${split ? '÷ split total' : '× per wallet'}</button>` : ''}<button class="bm u" data-a="bunit" title="${pm ? 'Buttons buy a % of the token supply (converted to SOL). Click for SOL amounts.' : 'Buttons are SOL amounts. Click to buy by % of supply.'}">${pm ? '% supply' : 'SOL'}</button></div>
          <div class="g gb">${pm ? p.sup.slice(0, 8).map((a) => `<button data-bp="${a}" ${dis || !(a > 0) ? 'disabled' : ''} title="${a}% of supply${live && selN > 1 ? (split ? ' in total' : ' per wallet') : ''}">${a}%<small>${a > 0 ? est(a) : ''}</small></button>`).join('')
            : p.buy.slice(0, 8).map((a) => `<button data-b="${a}" ${dis}>${a}</button>`).join('')}</div>
          <div class="cu"><input type="number" step="${pm ? '0.05' : '0.01'}" min="0" placeholder="${pm ? '% of supply' + (live && selN > 1 ? (split ? ' (total)' : ' (each)') : '') : live && split && selN > 1 ? 'Total SOL (split)' : 'Custom SOL'}" data-a="camt"><button data-a="cbuy" ${dis}>Buy</button></div>
          <div class="meta">Slip ${p.slippage}% · Fee ${p.fee} · MEV ${p.mev}${multiMeta}${pm ? ` · ${mu ? 'mcap $' + (mu >= 1e6 ? (mu / 1e6).toFixed(2) + 'M' : (mu / 1e3).toFixed(1) + 'K') + (mint && /pump$/i.test(mint) && usdRate && mu / usdRate < CURVE_END_MCAP_SOL ? ' · curve' : '') : '<span class="dn">no mcap yet</span>'}` : ''}</div>
          <hr>
          <div class="row"><span class="t">Sell %</span><span class="sp"></span>${sm && sm.bal ? `<span class="mut">${sol(sm.bal)} SOL ${usd(sm.bal) ? '· ' + usd(sm.bal) : ''} held</span>` : ''}</div>
          <div class="g gs">${p.sell.slice(0, 8).map((a) => `<button data-s2="${a}" ${dis || !(a > 0) ? 'disabled' : ''}>${a}%</button>`).join('')}</div>
          <div class="cu"><span class="sp"></span><button class="ini" data-a="sinit" ${dis} title="Sell just enough to take out what you put in, in every selected wallet holding this token">Sell Init.</button></div>
          <hr>
          <div class="row"><span class="t">Auto</span><span class="sp"></span>
            ${env !== 'ag' && Date.now() - (GM_getValue('agRelayAt', 0) || 0) > 30000 ? '<span class="dn" style="font-size:10.5px">open the backtester tab to run orders</span>' : '<span class="mut" style="font-size:10.5px">runs in the backtester tab</span>'}</div>
          <div class="g3">
            <button data-a="omig" ${mint ? '' : 'disabled'} title="Sell ${st.migPct}% of the selected wallets when the coin migrates">Sell ${st.migPct}% @ Mig</button>
            <button data-a="oinit" ${mint ? '' : 'disabled'} title="Sell initials in the selected wallets when the coin migrates">Init @ Mig</button>
            <button data-a="oprot" ${mint ? '' : 'disabled'} title="After +${st.protect.arm}%, sell ${st.protect.pct}% if it falls back to +${st.protect.floor}%">Protect ${st.protect.arm}→${st.protect.floor}</button>
          </div>
          ${tokOrders(mint, orders)}
          <div class="ft">
            <div><div>Bal</div><div>${sm ? sol(sm.bal) : '--'}</div><div class="u">${sm ? (sm.balUsd ? '$' + (sm.balUsd >= 1000 ? (sm.balUsd / 1000).toFixed(1) + 'K' : sm.balUsd.toFixed(2)) : '') : ''}</div></div>
            <div><div>Bought</div><div>${sm ? sol(sm.bought) : '--'}</div><div class="u">${sm ? usd(sm.bought) : ''}</div></div>
            <div><div>Sold</div><div>${sm ? sol(sm.sold) : '--'}</div><div class="u">${sm ? usd(sm.sold) : ''}</div></div>
            <div><div>PnL</div><div class="${sm && sm.pnl != null ? (sm.pnl >= 0 ? 'up' : 'dn') : ''}">${sm ? fmtPct(sm.pnl) : '--'}</div>
              <div class="u ${sm && sm.pnlSol != null ? (sm.pnlSol >= 0 ? 'up' : 'dn') : ''}">${sm && sm.pnlSol != null ? (sm.pnlSol >= 0 ? '+' : '') + sol(sm.pnlSol) + (usd(sm.pnlSol) ? ' · ' + usd(sm.pnlSol).replace('$-', '-$') : '') : ''}</div></div>
          </div>
        </div>`;
      if (html !== el.__html) { el.__html = html; el.innerHTML = html; }
      el.classList.toggle('col', ui.collapsed);
    }

    function onClick(e) {
      const t = e.target.closest('button,input[type=checkbox]');
      if (!t) return;
      const d = t.dataset;
      if (d.b) return buy(d.b);
      if (d.bp) return buyPct(d.bp);
      if (d.oc) return cancelOrder(d.oc);
      if (d.s2) return sell(d.s2);
      if (d.g) return useGroup(d.g);
      if (d.gd) return delGroup(d.gd);
      if (d.cp) return copy(d.cp, `${labelOf(d.cp)} address`);
      if (d.p != null && d.p !== '') { st.preset = Number(d.p); save(); return render(); }
      if (d.wa != null) {
        const set = new Set(selected());
        t.checked ? set.add(d.wa) : set.delete(d.wa);
        setSel([...set]); return render();
      }
      if (d.w === 'all') setSel(wallets.map((w) => w.address).filter(Boolean));
      if (d.w === 'none') setSel([]);
      if (d.w === 'main') { const m = wallets.find((w) => w.isMain); setSel(m ? [m.address] : []); }
      if (d.w === 'reload') return loadWallets(true);
      if (d.w === 'gsave') return saveGroup();
      if (d.w === 'fund') { ui.fund = ui.fund ? null : { kind: 'split', dest: null }; if (ui.fund) loadWallets(true); return render(); }
      if (d.w) return render();
      switch (d.a) {
        case 'mode':
          if (st.mode === 'paper' && !confirm('Switch the AG trade widget to LIVE?\nButtons will place REAL orders with your AG wallets.')) return;
          st.mode = st.mode === 'paper' ? 'live' : 'paper'; save(); pos = null; trades = null; wallets = []; ui.autoSel = null; ui.fund = null; held = {}; scanCards(); loadHeld(); autoPending = true; render(); loadWallets(); loadPos(); return;
        case 'wal': ui.walletOpen = !ui.walletOpen; ui.setOpen = false; if (ui.walletOpen && !wallets.length) loadWallets(); return render();
        case 'set': ui.setOpen = !ui.setOpen; ui.walletOpen = false; return render();
        case 'col': ui.collapsed = !ui.collapsed; savePos(); return render();
        case 'bmode': st.buyMode = st.buyMode === 'split' ? 'each' : 'split'; save(); scanCards(); return render();
        case 'bunit': st.buyUnit = st.buyUnit === 'pct' ? 'sol' : 'pct'; save(); return render();
        case 'cbuy': { const v = el.querySelector('[data-a=camt]').value; return st.buyUnit === 'pct' ? buyPct(v) : buy(v); }
        case 'pushtx': return pushTx();
        case 'sinit': return sellInit();
        case 'omig': return addOrder('mig');
        case 'oinit': return addOrder('miginit');
        case 'oprot': return addOrder('protect');
        case 'olist': ui.olist = !ui.olist; ui.walletOpen = false; ui.setOpen = false; return render();
        case 'fundrf': return loadWallets(true);
        case 'fundcp': {
          const p = fundPlan();
          if (p.tx) copy(p.tx.map((x) => `${x.amt} SOL  ${labelOf(x.from)} (${x.from}) -> ${labelOf(x.to)} (${x.to})`).join('\n'), 'transfer plan');
          return;
        }
      }
    }
    function onChange(e) {
      const d = e.target.dataset;
      if (d.f && ui.fund) { ui.fund[d.f] = e.target.value; return render(); }
      if (!d.s) return;
      const p = P(), v = e.target.value;
      if (d.s === 'buy' || d.s === 'sell' || d.s === 'sup') {
        const arr = v.split(/[,\s]+/).map(Number).filter((x) => isFinite(x) && x >= 0).slice(0, 8);
        while (arr.length < 8) arr.push(0);
        p[d.s] = arr;
      } else if (d.s === 'mev') p.mev = v;
      else if (d.s === 'confirmAbove') st.confirmAbove = Number(v) || 0;
      else if (d.s === 'qb') st.qb = Math.max(0, Number(v) || 0);
      else if (d.s === 'cards') { st.cards = e.target.checked; save(); scanCards(); return render(); }
      else if (d.s === 'jitter') st.jitter = Math.min(50, Math.max(0, Number(v) || 0));
      else if (d.s === 'stagger') st.stagger = Math.min(10000, Math.max(0, Number(v) || 0));
      else if (d.s === 'reserve') st.reserve = Math.max(0, Number(v) || 0);
      else if (d.s === 'migPct') st.migPct = Math.min(100, Math.max(1, Number(v) || 100));
      else if (d.s === 'protPct') st.protect.pct = Math.min(100, Math.max(1, Number(v) || 100));
      else if (d.s === 'protArm') st.protect.arm = Number(v);
      else if (d.s === 'protFloor') st.protect.floor = Number(v);
      else if (isFinite(Number(v))) p[d.s] = Number(v);
      save(); e.target.blur(); render();
    }

    function mountW() {
      if (document.getElementById('agtw')) return;
      const s = document.createElement('style'); s.textContent = CSS; document.head.appendChild(s);
      el = document.createElement('div'); el.id = 'agtw';
      el.style.left = (pos0.x ?? 20) + 'px';
      el.style.top = (pos0.y ?? Math.max(60, window.innerHeight - 470)) + 'px';
      document.body.appendChild(el);
      el.addEventListener('click', onClick);
      el.addEventListener('change', onChange);
      el.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.dataset.a === 'camt') (st.buyUnit === 'pct' ? buyPct : buy)(e.target.value); e.stopPropagation(); });
      el.addEventListener('mousedown', (e) => {
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
        if (m !== lastMint) { lastMint = m; pos = null; trades = null; ui.autoSel = null; autoPending = !!m; sym = m ? getSymbol(m) || '' : ''; render(); if (m) loadPos(); }
        else if (m && !sym) { sym = getSymbol(m) || ''; if (sym) render(); }
      }, 700);
      // position refresh: 5s, stretched up to 30s while the backtester API is slow; never overlaps
      const posTick = async () => {
        if (!ui.collapsed && !document.hidden && getMint() && !ui.busy) await loadPos();
        setTimeout(posTick, 5000 * (env === 'ag' ? bus.slow() : 1));
      };
      setTimeout(posTick, 5000);
      // balances for split buys / planner: refresh every 30s while LIVE (wallets-list is cached 30s on the bus anyway)
      setInterval(() => { if (st.mode === 'live' && !document.hidden && !ui.busy) loadWallets(); }, 30000);
      if (env === 'ag') setInterval(watch, 2500); else startCards();
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
