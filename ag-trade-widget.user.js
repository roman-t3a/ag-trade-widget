// ==UserScript==
// @name         AG Trade Widget
// @namespace    milerius.ag.trade
// @version      3.10.0
// @description  Floating quick buy/sell panel (GMGN / Axiom style) that trades through your Alpha Gardeners wallets. Buy in SOL / USD / % of supply, sell in % or SOL, wallet groups, split buys (jitter / stagger), consolidate / split planner, edit-in-place presets, auto exits, USD PnL, paper or LIVE. Works on the AG backtester, GMGN, Trojan and Axiom.
// @match        https://backtester.alphagardeners.xyz/*
// @match        https://gmgn.ai/*
// @match        https://*.gmgn.ai/*
// @match        https://trojan.com/*
// @match        https://axiom.trade/*
// @homepageURL  https://github.com/roman-t3a/ag-trade-widget
// @supportURL   https://github.com/roman-t3a/ag-trade-widget/issues
// @updateURL    https://raw.githubusercontent.com/roman-t3a/ag-trade-widget/main/ag-trade-widget.user.js
// @downloadURL  https://raw.githubusercontent.com/roman-t3a/ag-trade-widget/main/ag-trade-widget.user.js
// @run-at       document-idle
// @noframes
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addValueChangeListener
// @grant        GM_openInTab
// @grant        unsafeWindow
// @connect      backtester.alphagardeners.xyz
// @require      https://cdn.jsdelivr.net/npm/socket.io-client@4.7.5/dist/socket.io.min.js#sha256=c+uha8iV/fpFTifsuA3vMe3o2GH5nhdf+TsRDqvsBE8=
// ==/UserScript==

(function () {
  'use strict';

  // ============================================================ core
  // Pure helpers: no DOM, no GM_*, no widget state. The widget below uses them, and the unit tests load this
  // same file in Node (see the export right after this block). Keep everything in here side-effect free.
  const Core = (() => {
    const num = (...v) => { for (const x of v) if (x != null && x !== '' && !isNaN(Number(x))) return Number(x); return null; };
    const escH = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const tail = (a) => (a ? a.slice(0, 4) + '…' + a.slice(-4) : '');
    const sol = (v) => (v == null || isNaN(v) ? '--' : (Math.abs(v) >= 100 ? v.toFixed(1) : Math.abs(v) >= 1 ? v.toFixed(2) : v.toFixed(3)));
    const kfmt = (v) => (v == null || isNaN(v) ? '--' : Math.abs(v) >= 1e9 ? (v / 1e9).toFixed(2) + 'B' : Math.abs(v) >= 1e6 ? (v / 1e6).toFixed(2) + 'M'
      : Math.abs(v) >= 1e3 ? (v / 1e3).toFixed(Math.abs(v) >= 1e5 ? 0 : 1) + 'K' : v.toFixed(Math.abs(v) >= 10 ? 0 : 2));
    const usdV = (v) => (v == null || isNaN(v) ? '' : (v < 0 ? '-' : '') + '$' + (Math.abs(v) >= 1e6 ? (Math.abs(v) / 1e6).toFixed(2) + 'M'
      : Math.abs(v) >= 1e4 ? (Math.abs(v) / 1e3).toFixed(1) + 'K' : Math.abs(v).toFixed(2)));
    const unitLab = (a, unit) => (unit === 'pct' ? a + '%' : unit === 'usd' ? '$' + (a >= 1000 ? a / 1000 + 'K' : a) : String(a));
    const fmtM = (v, u) => (v == null ? '--' : u === '%' ? (Math.abs(v) >= 10 ? v.toFixed(0) : v.toFixed(1)) + '%' : u === '$' ? '$' + kfmt(v) : Math.abs(v) >= 1000 ? kfmt(v) : String(Math.round(v * 100) / 100));
    const agoS = (ms) => (ms == null || ms < 0 ? '--' : ms < 1000 ? '<1s' : ms < 60000 ? (ms / 1000).toFixed(ms < 10000 ? 1 : 0) + 's' : ms < 3600e3 ? Math.round(ms / 60000) + 'm' : Math.round(ms / 3600e3) + 'h');
    const msS = (ms) => (ms == null ? '--' : Math.round(ms) + 'ms');
    // "$6.97K" / "PUMPKART ↑ $76.62K | GMGN.AI" → 6970 / 76620
    const parseUsd = (t) => { const m = String(t || '').match(/\$\s?([\d.,]+)\s?([KMB])?/i); if (!m) return null; const v = parseFloat(m[1].replace(/,/g, '')); return v * ({ K: 1e3, M: 1e6, B: 1e9 }[(m[2] || '').toUpperCase()] || 1); };
    // user input "12.5k" / "$1.2M" / "800" → number (NaN when not a market cap)
    const parseMc = (s) => { const m = String(s || '').replace(/[$,\s]/g, '').match(/^(\d*\.?\d+)([kmb])?$/i); return m ? Number(m[1]) * ({ k: 1e3, m: 1e6, b: 1e9 }[(m[2] || '').toLowerCase()] || 1) : NaN; };
    // CSS px → px × --k (the widget's size factor); negative values included
    const scalePx = (css) => css.replace(/(-?\d*\.?\d+)px/g, (_m, n) => `calc(${n} * var(--k))`);

    // ---- pump.fun bonding curve: virtual reserves 30 SOL × 1.073B tokens, constant product, ~1.25% fee
    const PUMP = { K: 30 * 1.073e9, SUPPLY: 1e9, CURVE_END_MCAP_SOL: 400, FEE: 1.0125 };
    const isPump = (mint) => /pump$/i.test(mint || '');
    // SOL needed to buy pct% of the supply at market cap mcapUsd (USD), SOL at solUsd. Migrated / other coins:
    // mcap × % (no pool depth known → the real cost is a bit higher).
    function supplyCost(pct, mint, mcapUsd, solUsd) {
      if (!(mcapUsd > 0) || !(solUsd > 0) || !(pct > 0)) return null;
      const mSol = mcapUsd / solUsd, dy = (pct / 100) * PUMP.SUPPLY, p = mSol / PUMP.SUPPLY;
      if (isPump(mint) && mSol < PUMP.CURVE_END_MCAP_SOL) {
        const x = Math.sqrt(PUMP.K * p), y = Math.sqrt(PUMP.K / p);
        if (dy < y * 0.98) return { sol: ((x * dy) / (y - dy)) * PUMP.FEE, curve: true, mSol, mu: mcapUsd };
      }
      return { sol: (mSol * pct) / 100, curve: false, mSol, mu: mcapUsd };
    }
    // price impact (%) of a buy of totalSol on the curve, and the average fill market cap (USD)
    function buyImpact(totalSol, mint, mcapUsd, solUsd) {
      if (!(totalSol > 0) || !(mcapUsd > 0) || !(solUsd > 0) || !isPump(mint)) return null;
      const mSol = mcapUsd / solUsd;
      if (mSol >= PUMP.CURVE_END_MCAP_SOL) return null;
      const x = Math.sqrt((PUMP.K * mSol) / PUMP.SUPPLY), y = PUMP.K / x, dx = totalSol / PUMP.FEE, dy = y - PUMP.K / (x + dx);
      return { impact: (((x + dx) / x) ** 2 - 1) * 100, avgMc: dy > 0 ? (dx / dy) * PUMP.SUPPLY * solUsd : null };
    }
    // bonding-curve progress 0–100 (virtual SOL 30 → ~115), 100 once past the migration market cap
    function curvePct(mint, mcapUsd, solUsd) {
      if (!mint || !isPump(mint) || !(mcapUsd > 0) || !(solUsd > 0)) return null;
      const mSol = mcapUsd / solUsd;
      if (mSol >= PUMP.CURVE_END_MCAP_SOL) return 100;
      return Math.max(0, Math.min(100, ((Math.sqrt((PUMP.K * mSol) / PUMP.SUPPLY) - 30) / 85) * 100));
    }
    // AG feed values come in unknown units (USD mcap, SOL mcap, price…): the multiplier that brings v closest
    // to the reference mcap, or null if nothing lands within 3×
    function pickUnit(v, ref, solUsd) {
      if (!(v > 0) || !(ref > 0)) return null;
      let best = null, bd = Infinity;
      for (const m of [1, solUsd || 0, PUMP.SUPPLY, PUMP.SUPPLY * (solUsd || 0)]) if (m > 0) { const d = Math.abs(Math.log((v * m) / ref)); if (d < bd) { bd = d; best = m; } }
      return bd > Math.log(3) ? null : best;
    }

    // ---- multi-wallet buys (GMGN / Axiom conventions)
    //  each  → every wallet buys `amount`          split → `amount` is the total, divided across wallets
    //  jitter → ±% random size per wallet (split keeps the exact total) so the buys don't look bundled
    //  wallets whose known balance can't cover their leg + the fee reserve are skipped (split re-divides)
    function buyLegs(amount, ws, { split = false, jitterPct = 0, reserve = 0, balOf = () => null, shuffle = false, rand = Math.random } = {}) {
      const j = Math.min(0.5, Math.max(0, Number(jitterPct) || 0) / 100);
      const rsv = Math.max(0, Number(reserve) || 0);
      let elig = ws.slice();
      for (let pass = 0; pass < 4 && elig.length; pass++) {
        const base = split ? amount / elig.length : amount;
        const next = elig.filter((w) => { const b = balOf(w); return b == null || b >= base * (1 + j) + rsv; });
        if (next.length === elig.length) break;
        elig = next;
      }
      const skipped = ws.filter((w) => !elig.includes(w));
      if (!elig.length) return { legs: [], skipped };
      const base = split ? amount / elig.length : amount;
      let amts = elig.map(() => base * (1 + (rand() * 2 - 1) * j));
      if (split && j) { const s = amts.reduce((a, b) => a + b, 0); amts = amts.map((a) => (a * amount) / s); }
      amts = amts.map((a) => Math.max(0.0001, Math.floor(a * 1e4) / 1e4));
      const legs = elig.map((w, i) => ({ w, amt: amts[i] }));
      if (shuffle) legs.sort(() => rand() - 0.5); // random order when staggering
      return { legs, skipped };
    }
    const scaleLegs = (legs, total) => { const s = legs.reduce((a, x) => a + x.amt, 0); return s > 0 ? legs.map((x) => ({ w: x.w, amt: Math.max(0.0001, Math.floor(((x.amt * total) / s) * 1e4) / 1e4) })) : legs; };
    // seeded PRNG (Park–Miller) for reproducible split plans
    function rng(seed) { let x = (seed % 2147483646) + 1; return () => ((x = (x * 16807) % 2147483647) / 2147483647); }
    // transfers that move balances from `have` to `want`: greedy, biggest donor → biggest receiver, nothing below MIN
    function matchFlows(ws, have, want, MIN) {
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

    // ---- AG holdings rows: {worthSol, pnlSol, …}; cost of what is still held = worth − pnl
    const bagCost = (h) => { const w = num(h.worthSol), p = num(h.pnlSol); return w != null && p != null ? w - p : null; };
    const costOf = (h) => num(h.costSol, h.boughtSol) ?? bagCost(h);
    const soldOf = (h) => num(h.proceedsSol, h.soldSol);
    // cost-weighted average entry market cap of holding rows (useWorth: fall back to the current worth as weight)
    function avgEntry(rows, useWorth) {
      let eW = 0, eS = 0;
      for (const h of rows) { const m = num(h.avgEntryMcap), c = costOf(h) || (useWorth ? num(h.worthSol) : 0) || 0; if (m > 0 && c > 0) { eW += m * c; eS += c; } }
      return eS ? eW / eS : null;
    }

    // ---- AG filter: coins in your filtered AG Live Terminal ("matches"), published by the backtester tab and used
    // by the terminal tabs to badge / hide / dim the other coins in their lists.
    // Risk 0-100 (higher = riskier) from AG's metrics object (same schema in /profile.metrics and a terminal row's
    // .criteria). extra: { ch: creator-holdings figures, rug: RugCheck summary } (AG Intel's panel uses both).
    function riskScore(m, extra) {
      const flags = [];
      let s = 0;
      const add = (pts, cond, msg) => { if (cond) { s += pts; flags.push([pts, msg]); } };
      if (!m) return { score: null, flags };
      const b = num(m.bundledPct), top = num(m.topHoldersPct), dr = num(m.drainedPct), liq = num(m.liquidityPct), cr = num(m.creatorHoldingPct), bv = num(m.buyVolumePct);
      add(25, b > 60, `Bundled ${b}% (>60)`);
      add(15, b > 40 && b <= 60, `Bundled ${b}% (>40)`);
      add(8, b > 25 && b <= 40, `Bundled ${b}% (>25)`);
      add(15, top > 50, `Top10 ${top != null ? top.toFixed(1) : ''}% (>50)`);
      add(8, top > 35 && top <= 50, `Top10 ${top != null ? top.toFixed(1) : ''}% (>35)`);
      add(10, dr > 0, `Drained ${dr}% (${m.drainedCount} wallets)`);
      add(10, cr > 5, `Creator holds ${cr != null ? cr.toFixed(1) : ''}%`);
      add(5, m.freshDeployer === true, 'Fresh deployer');
      add(5, m.isMayhemMode === true, 'Mayhem mode');
      add(6, liq != null && liq < 10, `Low liquidity ${liq != null ? liq.toFixed(1) : ''}%`);
      add(5, bv != null && bv < 45, `Buy vol only ${bv != null ? bv.toFixed(1) : ''}%`);
      const ch = extra && extra.ch, rug = extra && extra.rug;
      if (ch) {
        const coh = num(ch.cohortHoldingPct);
        add(15, coh > 30, `Bundle cohort still holds ${coh}%`);
        add(8, coh > 15 && coh <= 30, `Bundle cohort still holds ${coh}%`);
      }
      if (rug && Array.isArray(rug.risks)) {
        let rp = 0;
        for (const r of rug.risks) { const p = r.level === 'danger' ? 12 : r.level === 'warn' ? 4 : 0; if (p) { rp += p; flags.push([p, 'RugCheck: ' + r.name]); } }
        s += Math.min(rp, 25);
      }
      return { score: Math.max(0, Math.min(100, Math.round(s))), flags };
    }
    // One match per Live Terminal row: s symbol · r risk · w win-pred % · x mcap / signal mcap · t last seen
    const matchOf = (row, liveMcap, now) => {
      const mc = num(liveMcap, row.currentMcap), sig = num(row.signalMcap);
      return { s: row.symbol || row.token || '', r: riskScore(row.criteria).score, w: row.winPredPercent != null ? Math.round(row.winPredPercent) : null,
        x: mc && sig ? +(mc / sig).toFixed(2) : null, t: now };
    };
    // merge rows into the store (in place); entries not seen for `ttl` ms expire
    function mergeMatches(store, rows, now, ttl) {
      for (const { row, liveMcap } of rows) if (row && row.tokenAddress) store[row.tokenAddress] = matchOf(row, liveMcap, now);
      for (const [k, v] of Object.entries(store)) if (!v || now - v.t > ttl) delete store[k];
      return store;
    }
    // the list is usable when a backtester tab answered in the last 90s AND its Live Terminal was on screen in the
    // last 15 min (otherwise "not a match" means nothing: the filter falls back to badges only)
    const matchesLive = (pack, now) => !!(pack && pack.at && now - pack.at < 90000 && now - (pack.cardsAt || 0) < 15 * 60000);
    // smart = hide what AG doesn't match, reversibly (a coin is back the moment AG matches it) · dim · badge · off
    const FILTER_MODES = ['smart', 'dim', 'badge', 'off'];
    const filterAction = (mode, live, isMatch, isCurrent) =>
      (isMatch || isCurrent || !live || mode === 'badge' || mode === 'off' || !FILTER_MODES.includes(mode) ? 'show' : mode === 'dim' ? 'dim' : 'hide');
    // The terminal's own "Hide token" (stays hidden in your account there, we can't undo it): opt-in, smart mode only,
    // live data only, and only for a coin still unmatched `after` minutes after we first saw it.
    const nativeDue = (f, live, isMatch, seenAt, now) => !!(f && f.native && f.mode === 'smart' && live && !isMatch && seenAt && now - seenAt >= Math.max(0, Number(f.after) || 0) * 60000);

    // ---- Trojan bundles. Rows = Trojan's /v1/tokens/bundled-positions entries (top holders of one coin: balances,
    // buys / sells / transfers, sniped / bundled / dev-received amounts, each wallet's first funder).
    // A bundle ("cluster") = 2+ wallets with the same first funder. Balances are in token units; `supply` (default
    // 1B, pump.fun) turns them into % of supply; `px` (SOL per token, optional) values what is still held.
    const BUNDLE_MAX = 15; // more wallets than this from one funder looks like an exchange / bot hot wallet, not a bundle
    function clusterize(rows, supply, px) {
      const sup = num(supply) > 0 ? num(supply) : 1e9, by = {};
      for (const r of rows || []) {
        const f = r && r.fundingInfo && r.fundingInfo.firstNativeFunderAddress;
        if (!f || !r.walletAddress) continue;
        (by[f] = by[f] || []).push(r);
      }
      const out = [];
      for (const [id, ws] of Object.entries(by)) {
        if (ws.length < 2) continue;
        const sum = (k) => ws.reduce((a, w) => a + (num(w[k]) || 0), 0);
        const bal = sum('currentTokenBalance'), inflow = sum('amountTokensBought') + sum('amountTokensReceived') + sum('amountTokensMinted');
        const spent = sum('amountNativeSpent'), earned = sum('amountNativeEarned'), value = num(px) > 0 ? bal * px : null;
        const amts = ws.map((w) => num(w.fundingInfo.firstNativeFundingAmount)).filter((x) => x > 0);
        const sameAmt = amts.length >= 2 && Math.max(...amts) - Math.min(...amts) <= Math.max(...amts) * 0.02;
        out.push({
          id, n: ws.length, bal, inflow, pct: (bal / sup) * 100, left: inflow > 0 ? Math.min(1, bal / inflow) : (bal > 0 ? 1 : 0),
          spent, earned, value, pnl: earned - spent + (value || 0), sells: sum('numSells'), buys: sum('numBuys'), sent: sum('numTransfersOut'),
          sniper: ws.some((w) => num(w.amountSniped) > 0), bundled: ws.some((w) => num(w.amountBundled) > 0),
          dev: ws.some((w) => num(w.amountReceivedFromDev) > 0 || num(w.amountReceivedFromInsider) > 0),
          sameAmt, fundAmt: amts.length ? amts[0] : null, hot: ws.length > BUNDLE_MAX,
          lastSell: Math.max(0, ...ws.map((w) => num(w.lastSellTimestamp) || 0)), lastBuy: Math.max(0, ...ws.map((w) => num(w.lastBuyTimestamp) || 0)),
          wallets: ws.map((w) => ({ addr: w.walletAddress, bal: num(w.currentTokenBalance) || 0, bought: num(w.amountTokensBought) || 0, sold: num(w.amountTokensSold) || 0,
            spent: num(w.amountNativeSpent) || 0, earned: num(w.amountNativeEarned) || 0, fund: num(w.fundingInfo.firstNativeFundingAmount), lastBuy: num(w.lastBuyTimestamp), lastSell: num(w.lastSellTimestamp) }))
            .sort((a, b) => b.bal - a.bal),
        });
      }
      return out.sort((a, b) => b.bal - a.bal);
    }
    // whole-coin view: what the bundles still hold + a 0-100 risk (held share, dev links, snipers, sell pressure)
    function bundleSummary(cl, rows, supply) {
      const sup = num(supply) > 0 ? num(supply) : 1e9, real = (cl || []).filter((c) => !c.hot);
      const held = real.reduce((a, c) => a + c.pct, 0), peak = real.reduce((a, c) => a + (c.inflow / sup) * 100, 0);
      const snipers = (rows || []).filter((r) => num(r.amountSniped) > 0), dev = (rows || []).filter((r) => num(r.amountReceivedFromDev) > 0);
      const sold = real.length ? real.reduce((a, c) => a + (1 - c.left) * c.inflow, 0) / Math.max(1, real.reduce((a, c) => a + c.inflow, 0)) : 0;
      const risk = Math.max(0, Math.min(100, Math.round(held * 1.6 + (dev.length ? 12 : 0) + Math.min(15, snipers.length * 1.5) + sold * 20)));
      return { clusters: real.length, wallets: real.reduce((a, c) => a + c.n, 0), held, peak, snipers: snipers.length,
        snipersOut: snipers.filter((r) => (num(r.currentTokenBalance) || 0) <= 0).length, dev: dev.length, risk, level: risk >= 60 ? 'high' : risk >= 30 ? 'mid' : 'low' };
    }
    // history: one compact point per snapshot { at, total, c: { id: [bal, inflow, spent, sent, pct] } }, kept `keepMs`
    function bundlePoint(cl, now) {
      const c = {};
      for (const x of cl) c[x.id] = [x.bal, x.inflow, x.spent, x.sent, x.pct];
      return { at: now, total: cl.filter((x) => !x.hot).reduce((a, x) => a + x.pct, 0), c };
    }
    function pushPoint(hist, pt, keepMs) {
      const h = (hist || []).filter((p) => pt.at - p.at <= keepMs);
      h.push(pt);
      return h.length > 400 ? h.slice(-400) : h;
    }
    // Bundle rules: { who: any|top3|min|dev|snipers|funder, minPct, funder, when, pct, sol, windowSec, scope, then, … }
    //   when: sell (drops ≥ pct % of its bag within the window) · exit (has sold ≥ pct % of everything it got, crossing)
    //         acc (spent ≥ sol ◎ more within the window) · send (sent tokens out within the window) · new (a cluster
    //         that wasn't there appears, holding ≥ pct %) · allout (all bundles together fall to ≤ pct % of supply)
    //         · funder (a watched funder's cluster is on the coin)
    const BUNDLE_WHEN = ['sell', 'exit', 'acc', 'send', 'new', 'allout', 'funder'];
    function whoOk(rule, c, rank, watch) {
      if (c.hot && rule.who !== 'funder') return false;
      switch (rule.who) {
        case 'top3': return rank < 3;
        case 'min': return c.pct >= (num(rule.minPct) || 0);
        case 'dev': return c.dev;
        case 'snipers': return c.sniper;
        case 'funder': return (watch || []).includes(c.id) || c.id === rule.funder;
        default: return true;
      }
    }
    // → [{ id, kind, pct, sol, n, text }] for the newest point of `hist` (cl = the newest clusters)
    function bundleMatches(rule, hist, cl, now, watch) {
      if (!hist || !hist.length || !cl) return [];
      const last = hist[hist.length - 1], win = Math.max(5, num(rule.windowSec) || 60) * 1000;
      const base = hist.find((p) => now - p.at <= win) || last; // oldest point inside the window
      const first = hist[0], pct = num(rule.pct) || 0, out = [];
      if (rule.when === 'allout') {
        const was = hist.some((p) => p.total > pct + 0.5);
        if (was && last.total <= pct) out.push({ id: '*', kind: 'allout', pct: last.total, n: 0, text: `bundles are out: they hold ${last.total.toFixed(1)}% of supply now` });
        return out;
      }
      cl.forEach((c, rank) => {
        if (!whoOk(rule, c, rank, watch)) return;
        const b = base.c[c.id], tag = `${c.id.slice(0, 4)}…${c.id.slice(-4)}`;
        if (rule.when === 'sell' && b && b[0] > 0) {
          const drop = ((b[0] - c.bal) / b[0]) * 100;
          if (drop >= pct) out.push({ id: c.id, kind: 'sell', pct: drop, n: c.n, text: `${tag} sold ${drop.toFixed(0)}% of its bag in ${Math.round((now - base.at) / 1000)}s` });
        } else if (rule.when === 'exit') {
          const soldNow = (1 - c.left) * 100, before = hist.slice(0, -1).some((p) => p.c[c.id] && p.c[c.id][1] > 0 && (1 - p.c[c.id][0] / p.c[c.id][1]) * 100 < pct);
          if (soldNow >= pct && before) out.push({ id: c.id, kind: 'exit', pct: soldNow, n: c.n, text: `${tag} is out: sold ${soldNow.toFixed(0)}% of what it got` });
        } else if (rule.when === 'acc' && b) {
          const more = c.spent - b[2];
          if (more >= (num(rule.sol) || 0.5)) out.push({ id: c.id, kind: 'acc', sol: more, n: c.n, text: `${tag} bought ◎ ${more.toFixed(2)} more (${c.n} wallets)` });
        } else if (rule.when === 'send' && b && c.sent > b[3]) {
          out.push({ id: c.id, kind: 'send', n: c.sent - b[3], text: `${tag} sent tokens out ${c.sent - b[3]}× (new wallets?)` });
        } else if (rule.when === 'new' && !first.c[c.id] && last.at - first.at >= 20000 && c.pct >= pct) {
          out.push({ id: c.id, kind: 'new', pct: c.pct, n: c.n, text: `new bundle ${tag}: ${c.n} wallets hold ${c.pct.toFixed(1)}%` });
        } else if (rule.when === 'funder') {
          out.push({ id: c.id, kind: 'funder', pct: c.pct, n: c.n, text: `watched funder ${tag} is here: ${c.n} wallets hold ${c.pct.toFixed(1)}%` });
        }
      });
      return out;
    }
    const BUNDLE_WHO = { any: 'any bundle', top3: 'a top-3 bundle', min: 'a bundle holding ≥ {minPct}%', dev: 'a dev-linked bundle', snipers: 'a sniper bundle', funder: 'a watched funder' };
    const BUNDLE_THEN = { alert: 'alert me', sell: 'sell {sellPct}% of my bag', init: 'sell my initials', hide: 'hide the coin', buy: 'buy ◎ {buySol} ({mode})' };
    function ruleText(r) {
      const f = (s) => s.replace(/\{(\w+)\}/g, (_m, k) => (r[k] != null ? r[k] : ''));
      const win = `within ${r.windowSec || 60}s`;
      const when = { sell: `sells ≥ ${r.pct}% of its bag ${win}`, exit: `has sold ≥ ${r.pct}% of what it got`, acc: `buys ≥ ◎ ${r.sol} more ${win}`,
        send: `sends tokens to other wallets ${win}`, new: `appears holding ≥ ${r.pct}%`, funder: 'shows up on the coin' }[r.when];
      const scope = { this: 'on this coin', held: 'on a coin I hold', any: 'on any coin I open' }[r.scope] || '';
      const head = r.when === 'allout' ? `When all bundles together hold ≤ ${r.pct}% of supply` : `When ${f(BUNDLE_WHO[r.who] || BUNDLE_WHO.any)} ${when}`;
      return `${head} ${scope}, ${f(BUNDLE_THEN[r.then] || r.then)}`;
    }

    // ---- AG intel
    const metric = (o, k) => { if (!o) return null; const v = o[k]; return v == null || v === '' ? null : typeof v === 'object' ? num(v.value, v.v, v.now) : num(v); };
    const metricsOf = (p) => (p && (p.metrics || p.currentMetrics)) || {};
    const firstOf = (p) => (p && (p.firstMetrics || p.signalMetrics)) || {};
    // def = [key, label, unit, direction (+1 higher is worse, -1 higher is better, 0 neutral), watch, risk]
    function riskLevel(def, v) {
      const [, , , dir, w, r] = def;
      if (v == null || !dir) return 'n';
      if (dir > 0) return v >= r ? 'bad' : v >= w ? 'mid' : 'ok';
      return v > w ? 'ok' : 'mid';
    }
    // last 5 minutes of swaps → 1-minute buy / sell bins, smart-money counts, fresh buyers, net SOL
    function flowOf(swaps, nowSec) {
      const now = nowSec ?? Date.now() / 1000, bins = [0, 1, 2, 3, 4].map(() => ({ b: 0, s: 0 }));
      let smB = 0, smS = 0, fresh = 0, net = 0;
      for (const s of swaps || []) {
        const t = num(s.blockTime, s.timestamp), v = num(s.solAmount, s.amountSol) || 0;
        if (!t || now - t > 300 || now - t < -30) continue;
        const i = Math.min(4, Math.max(0, 4 - Math.floor((now - t) / 60))), buy = s.side === 'buy';
        bins[i][buy ? 'b' : 's'] += v; net += buy ? v : -v;
        if (s.isSmartMoney || s.walletType === 2) { if (buy) smB++; else smS++; }
        if (buy && s.walletType === 1 && !s.isSmartMoney) fresh++;
      }
      return { bins, smB, smS, fresh, net };
    }
    const PROFILE_KEYS = [[/fresh/i, 'Fresh'], [/dev.*hold|creator.*hold/i, 'Dev hold'], [/bundl/i, 'Bundled'], [/top.?10|top.*holder/i, 'Top-10'], [/smart/i, 'Smart money'], [/win.?pred/i, 'Win pred'], [/sniper/i, 'Snipers'], [/insider/i, 'Insiders']];
    // any AG profile payload → up to 8 chips {k, v} (searched 3 levels deep, first match per label wins)
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
    // AG my-trades / swaps payloads → [{side, sol, mc, w, t (ms)}] oldest first
    function tradeRows(j) {
      const arr = j && (j.trades || j.swaps || j.items || j.history || j.fills);
      if (!Array.isArray(arr)) return null;
      return arr.map((t) => {
        const ts = num(t.blockTime, t.timestamp, t.time, t.ts) || (t.at || t.createdAt ? new Date(t.at || t.createdAt).getTime() / 1000 : null);
        return { side: String(t.side || t.type || '').toLowerCase().includes('sell') ? 'SELL' : 'BUY', sol: num(t.solAmount, t.amountSol, t.sol, t.amount), mc: num(t.mcap, t.mcapUsd, t.marketCap, t.mcapAtTrade),
          w: t.walletAddress || t.wallet || t.walletKey || '', t: ts ? ts * (ts < 1e12 ? 1000 : 1) : null };
      }).sort((a, b) => (a.t || 0) - (b.t || 0));
    }
    // signal time in ms from any of AG's field names (seconds or ms, number or ISO string)
    const sigTime = (x) => { const v = num(x && (x.signalAt ?? x.createdAt ?? x.blockTime ?? x.time ?? x.timestamp ?? x.ts)); return v == null ? (typeof (x && x.createdAt) === 'string' ? Date.parse(x.createdAt) || null : null) : v < 1e12 ? v * 1000 : v; };
    // Did AG signal a hidden coin after it was hidden? meta = { t: hidden at (ms), n: untimed signals known }.
    // Timed signals decide on their own; untimed ones by count. The first look sets the baseline (meta.n).
    function newSignal(meta, sigs, prof) {
      const after = (t) => t != null && meta.t && t > meta.t + 1000;
      if (sigs.some((x) => after(sigTime(x)))) return { hit: true };
      if (prof && after(sigTime({ signalAt: prof.signalAt }))) return { hit: true };
      const untimed = sigs.filter((x) => sigTime(x) == null).length;
      if (meta.n == null) { meta.n = untimed; return { hit: false, baseline: true }; }
      return { hit: untimed > meta.n };
    }

    // ---- relay (GMGN tab ⇄ backtester tab)
    // Only these AG endpoints may be called, through the relay or directly.
    function agPathAllowed(method, path) {
      return /^(GET|POST)$/.test(method) &&
        /^\/api\/(tokens\/[1-9A-HJ-NP-Za-km-z]{32,44}\/(buy|sell|profile|my-trades|annotations|tpsl|creator-holdings|recent-swaps)|swaps\/by-token\/[1-9A-HJ-NP-Za-km-z]{32,44}|performance\/(wallets-list|holdings|positions|wallets\/tx-settings-all))(\?[\w=&.-]*)?$/.test(path);
    }
    // v2 = a 3.5+ relay owner is alive · legacy = only the old heartbeat · down = no backtester tab
    function relayMode(owner, beatAt, now) {
      if (owner && now - owner.at < 30000) return { mode: 'v2', o: owner, age: now - owner.at };
      if (beatAt && now - beatAt < 30000) return { mode: 'legacy', age: now - beatAt };
      return { mode: 'down', age: beatAt ? now - beatAt : null, o: owner };
    }
    // the session counts as expired only on a fresh (< 2 min) 401 / 403 from AG
    const authExpired = (a, now) => !!a && !a.ok && (a.status === 401 || a.status === 403) && now - a.at < 120000;
    const healthLevel = (items, action) => (items.some((x) => x.c === 'r') ? 'r' : items.some((x) => x.c === 'y') || (action && action.a === 'reload') ? 'y' : 'g');

    // ---- shared request bus for read-only AG GETs: one in-flight request + a short cache per path, shared
    // between scripts on the page through W.__agBus. maxAge per call; failures are cached ≤ 3s.
    function agBus(W, fetchFn) {
      try { const b = W.__agBus; if (b && b.v === 1 && typeof b.get === 'function') return b; } catch (_) { /* cross-origin window */ }
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
      try { W.__agBus = bus; } catch (_) { /* frozen window */ }
      return bus;
    }

    // ---- trading terminals (site adapters). Everything site-specific lives here; the widget itself is the same on
    // every terminal. Pure: they take a location-like { pathname, search } / a title / an attribute value; only a site
    // with domMint reads the page, through the `doc` it is handed (unit tests pass a fake one).
    //   mint(loc, doc) → mint of the token page you're on, or null (any other page: bar + positions still work)
    //   symbol(title)  → ticker from the tab title
    //   cards          → selector for coin cards / rows in lists (badges, quick buy, hide)
    //   cardAttr       → attribute holding the coin (default href), cardMint(value) → mint
    //   cardRow        → selector a click inside a card climbs to; cardMinH skips smaller matches (ticker chips)
    //   tokenUrl(mint) → where "open coin" goes
    //   nativeHide(card) → the terminal's own "Hide token" button inside a card (AG filter, opt-in), if it has one
    const B58 = '[1-9A-HJ-NP-Za-km-z]{32,44}';
    const GMGN_TOKEN = new RegExp(`/sol/token/(?:[A-Za-z0-9]+_)?(${B58})`);
    const TROJAN_TOKEN = new RegExp(`[?&]token=(${B58})(?:&|$)`);
    const AXIOM_LINK = new RegExp(`(?:solscan\\.io/token/|pump\\.fun/coin/)(${B58})`);
    const ONLY_B58 = new RegExp(`^${B58}$`);
    const SITES = [
      {
        id: 'gmgn', name: 'GMGN', host: /(^|\.)gmgn\.ai$/,
        mint: (loc) => (String(loc.pathname || '').match(GMGN_TOKEN) || [])[1] || null,
        symbol: (t) => { // "PUMPKART ↑ $76.62K | GMGN.AI …"
          const m = String(t || '').match(/^\s*\$?([^\s↑↓|$]{1,20})\s*[↑↓]/) || String(t || '').match(/^\s*\$?([A-Za-z0-9._-]{1,20})\s/);
          return m && !/^gmgn/i.test(m[1]) ? m[1] : '';
        },
        cards: 'div[href*="/sol/token/"], tr a[href*="/sol/token/"]',
        cardRow: 'div[href*="/sol/token/"], tr',
        cardMinH: 0,
        cardMint: (href) => (String(href || '').match(GMGN_TOKEN) || [])[1] || null,
        tokenUrl: (m) => '/sol/token/' + m,
        nativeHide: (card) => { const s = card.querySelector('svg.hide-token-icon'); return s ? s.parentElement : null; },
      },
      {
        id: 'trojan', name: 'Trojan', host: /(^|\.)trojan\.com$/,
        // token page: /terminal?token=<mint>&…
        mint: (loc) => (/^\/terminal\/?$/.test(loc.pathname || '') && (String(loc.search || '').match(TROJAN_TOKEN) || [])[1]) || null,
        symbol: (t) => { // "Datacenter $7.73K | Trojan"
          const m = String(t || '').match(/^\s*\$?(.+?)\s+[↑↓]?\s*\$[\d.,]+\s*[KMB]?\s*\|\s*Trojan/i);
          return m ? m[1].trim().slice(0, 20) : '';
        },
        // Trenches / lists: every card is one <a href="/terminal?token=<mint>&…">; the ticker strip at the top uses the
        // same link but is ~28px high, so anything under 80px is skipped
        cards: 'a[href*="/terminal?"][href*="token="]',
        cardRow: 'a[href*="/terminal?"][href*="token="]',
        cardMinH: 80,
        cardMint: (href) => (String(href || '').match(TROJAN_TOKEN) || [])[1] || null,
        tokenUrl: (m) => '/terminal?token=' + m,
      },
      {
        id: 'axiom', name: 'Axiom', host: /(^|\.)axiom\.trade$/,
        // token page: /meme/<PAIR address>. The mint is not in the URL, so it comes from the page's own Solscan /
        // pump.fun link (there is exactly one, for the coin on screen)
        domMint: true,
        mint: (loc, doc) => {
          if (!/^\/meme\/[1-9A-HJ-NP-Za-km-z]{32,44}/.test(loc.pathname || '') || !doc) return null;
          const a = doc.querySelector('a[href*="solscan.io/token/"], a[href*="pump.fun/coin/"]');
          return (a && (String(a.getAttribute('href') || '').match(AXIOM_LINK) || [])[1]) || null;
        },
        symbol: (t) => { // "SIQ ↓ $3.44K | Axiom SOL"
          const m = String(t || '').match(/^\s*\$?(.+?)\s+[↑↓]?\s*\$[\d.,]+\s*[KMB]?\s*\|\s*Axiom/i);
          return m ? m[1].trim().slice(0, 20) : '';
        },
        // Pulse: every card is <div data-pulse-token-address="<mint>"> (its own buy buttons sit mid-right, so our
        // overlay fits bottom-right)
        cards: 'div[data-pulse-token-address]',
        cardAttr: 'data-pulse-token-address',
        cardRow: 'div[data-pulse-token-address]',
        cardMinH: 0,
        cardMint: (v) => (ONLY_B58.test(String(v || '')) ? v : null),
        tokenUrl: (m) => '/meme/' + m, // Axiom redirects /meme/<mint> to the coin's pair page
        nativeHide: (card) => card.querySelector('button[aria-label="Hide token"]'),
      },
    ];
    const siteFor = (hostname) => SITES.find((x) => x.host.test(String(hostname || ''))) || null;
    // tick source → label ('ag' or a site id)
    const srcName = (src) => (src === 'ag' ? 'AG' : (SITES.find((x) => x.id === src) || { name: String(src || '?') }).name);

    return { num, escH, tail, sol, kfmt, usdV, unitLab, fmtM, agoS, msS, parseUsd, parseMc, scalePx, PUMP, isPump, supplyCost, buyImpact, curvePct, pickUnit,
      buyLegs, scaleLegs, rng, matchFlows, bagCost, costOf, soldOf, avgEntry, metric, metricsOf, firstOf, riskLevel, flowOf, PROFILE_KEYS, profileChips, tradeRows,
      sigTime, newSignal, agPathAllowed, relayMode, authExpired, healthLevel, agBus, SITES, siteFor, srcName,
      riskScore, matchOf, mergeMatches, matchesLive, FILTER_MODES, filterAction, nativeDue,
      clusterize, bundleSummary, bundlePoint, pushPoint, bundleMatches, BUNDLE_WHEN, BUNDLE_MAX, ruleText };
  })();
  // Node (unit tests) gets the core and stops here. In Tampermonkey there is no `module`.
  if (typeof module === 'object' && module && module.exports && typeof window === 'undefined') { module.exports = Core; return; }
  // top window only: terminals embed same-origin iframes (Trojan's TradingView chart is /terminal?token=… too),
  // and the script must never run twice on one page (@noframes, plus this guard for managers that ignore it)
  try { if (window.top !== window.self) return; } catch (_) { return; }
  const { agBus, agPathAllowed } = Core;
  const VER = (typeof GM_info !== 'undefined' && GM_info && GM_info.script && GM_info.script.version) || '0.0.0';
  const RELAY_LEASE = 9000;   // the backtester tab that owns the relay renews every 3s; a standby tab takes over after 9s
  const RELAY_MAX_AGE = 700;  // the relay only runs calls younger than this: the GMGN tab goes direct after 1.5s without an ack
  // Connection health shared inside a tab (the backtester tab fills it, the GMGN tab reads it via agPong / agHealth)
  const HL = { sock: { ok: false, since: 0, last: 0, ping: 0, re: 0, subs: 0 }, sess: null, reconnect: null, log: [] };
  const hlog = (m, lvl) => { HL.log.unshift({ t: Date.now(), m, lvl: lvl || 'i' }); HL.log.length = Math.min(HL.log.length, 30); };

  const SITE = Core.siteFor(location.hostname);
  if (SITE) {
    // ---------------------------------------------------------------- trading terminal (GMGN, Trojan…)
    // Token = the terminal's token page you're on. Orders are relayed through your open backtester tab.
    // A site that reads the mint from the page (domMint): right after an in-app navigation the old coin's link can
    // still be in the DOM for a moment, so the previous mint is ignored for 2.5s after the path changes.
    let navPath = location.pathname, navOld = null, navAt = 0, lastM = null;
    const siteMint = () => {
      if (!SITE.domMint) return SITE.mint(location, document);
      if (location.pathname !== navPath) { navOld = lastM; navPath = location.pathname; navAt = Date.now(); }
      let m = SITE.mint(location, document);
      if (m && m === navOld && Date.now() - navAt < 2500) m = null;
      lastM = m || lastM;
      return m;
    };
    tradeWidget(SITE.id, siteMint, () => SITE.symbol(document.title), null, SITE);
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

  // ---- relay: calls from the GMGN widget run here (whitelisted AG endpoints only).
  // Exactly one backtester tab owns the relay (lease in agRelayOwner); other backtester tabs stand by, so a call
  // is never executed twice. Protocol: agRpc → agRpcAck (immediately) → agRpcRes. A call older than RELAY_MAX_AGE
  // is dropped: the sender has already gone direct.
  const relayMe = Math.random().toString(36).slice(2, 10);
  const ownerNow = () => { const l = GM_getValue('agRelayOwner', null); return l && Date.now() - l.at < RELAY_LEASE ? l : null; };
  const iOwn = () => { const l = ownerNow(); return !!l && l.id === relayMe; };
  let wasOwner = false;
  function claimRelay() {
    const l = ownerNow(), now = Date.now();
    if (!l || l.id === relayMe) {
      GM_setValue('agRelayOwner', { id: relayMe, at: now, v: VER, vis: !document.hidden });
      if (!wasOwner) { wasOwner = true; hlog(l ? 'this tab owns the relay' : 'this tab took over the relay'); }
    } else if (wasOwner) { wasOwner = false; hlog('another backtester tab owns the relay · this one stands by'); }
  }
  const seenRpc = new Set();
  function sessNote(results, ms) {
    const bad = results.find((r) => r && (r.status === 401 || r.status === 403));
    const ok = results.some((r) => r && r.ok);
    if (bad || ok) setSess({ ok: !bad, status: bad ? bad.status : 200, ms, at: Date.now() });
  }
  function setSess(x) {
    const was = HL.sess;
    HL.sess = x;
    if (was && was.ok !== x.ok) hlog(x.ok ? 'AG session OK again' : `AG answered ${x.status}: logged out?`, x.ok ? 'i' : 'bad');
  }
  GM_addValueChangeListener('agRpc', async (_k, _o, v, remote) => {
    if (!remote || !v || !Array.isArray(v.calls) || seenRpc.has(v.id)) return;
    if (!iOwn()) return;                                        // standby tab
    const age = Date.now() - v.at;
    if (age > (v.ackMs ? RELAY_MAX_AGE : 15000)) { hlog(`dropped a ${Math.round(age / 100) / 10}s old call (the GMGN tab went direct)`, 'warn'); return; }
    seenRpc.add(v.id); if (seenRpc.size > 300) seenRpc.delete(seenRpc.values().next().value);
    GM_setValue('agRpcAck', { id: v.id, at: Date.now() });
    const t0 = Date.now();
    const results = await Promise.all(v.calls.map((c) => agPathAllowed(c.method, c.path)
      ? agLocalCall(c.method, c.path, c.body) : { status: 0, ok: false, j: { error: 'blocked path' } }));
    sessNote(results, Date.now() - t0);
    GM_setValue('agRpcRes', { id: v.id, results });
  });
  // health snapshot for the GMGN footbar: answered on agPing, also published on the heartbeat
  const leaderFresh = () => { const l = GM_getValue('twLeader', null); return !!l && Date.now() - l.at < 10000; };
  const snap = () => ({ v: VER, at: Date.now(), vis: !document.hidden, sess: HL.sess, sock: HL.sock, leader: leaderFresh(), log: HL.log.slice(0, 8) });
  GM_addValueChangeListener('agPing', (_k, _o, v, remote) => { if (remote && v && iOwn()) GM_setValue('agPong', { id: v.id, h: snap() }); });
  GM_addValueChangeListener('agCmd', (_k, _o, v, remote) => {
    if (!remote || !v || Date.now() - v.at > 10000 || !iOwn()) return;
    if (v.cmd === 'reconnect') { hlog('reconnect asked from the GMGN tab'); if (HL.reconnect) HL.reconnect(); checkSession(); }
    if (v.cmd === 'reload') { hlog('reload asked from the GMGN tab'); setTimeout(() => location.reload(), 300); }
    if (v.cmd === 'wake') checkSession();
  });
  // Heartbeat that survives Chrome's background-tab throttling (worker timer) and freezing (Web Lock).
  const beat = () => { GM_setValue('agRelayAt', Date.now()); claimRelay(); if (iOwn()) GM_setValue('agHealth', snap()); };
  beat();
  setInterval(beat, 3000);
  try {
    const wk = new Worker(URL.createObjectURL(new Blob(['setInterval(()=>postMessage(0),3000)'], { type: 'text/javascript' })));
    wk.onmessage = () => { if (document.hidden) beat(); };
  } catch (_) {}
  try { if (navigator.locks) navigator.locks.request('ag-trade-keepalive', () => new Promise(() => {})); } catch (_) {}
  GM_addValueChangeListener('twPing', (_k, _o, _v, remote) => { if (remote) beat(); });
  document.addEventListener('visibilitychange', beat);
  // AG session: one cheap authenticated GET a minute (by the relay owner only)
  async function checkSession() {
    if (!iOwn()) return;
    const t0 = Date.now();
    try {
      const r = await W.fetch('/api/performance/wallets-list?source=live', { credentials: 'same-origin' });
      setSess({ ok: r.ok, status: r.status, ms: Date.now() - t0, at: Date.now() });
    } catch (e) { setSess({ ok: false, status: 0, ms: Date.now() - t0, at: Date.now() }); }
  }
  setTimeout(checkSession, 1500);
  setInterval(checkSession, 60000);

  // Token selected in the backtester: #token/<mint> in the URL, else the active Live Terminal card.
  const cardRow = (el) => {
    const fk = Object.keys(el).find((k) => k.startsWith('__reactFiber'));
    let f = fk && el[fk];
    for (let i = 0; i < 4 && f; i++, f = f.return) { const p = f.memoizedProps; if (p && p.s && p.s.tokenAddress) return p; }
    return null;
  };
  // ---- AG matches → terminal tabs: the coins of your filtered Live Terminal (shared Tampermonkey storage).
  // Every backtester tab merges its own cards into the shared list; written when it changes, else every 15s (heartbeat).
  const LT_CARDS = 'div[role="button"].shrink-0.rounded-lg.cursor-pointer';
  const MATCH_TTL = 60 * 60000;
  let matchSig = '', matchAt = 0;
  function publishMatches(force) {
    const now = Date.now(), rows = [];
    for (const el of document.querySelectorAll(LT_CARDS)) { const p = cardRow(el); if (p) rows.push({ row: p.s, liveMcap: p.liveMcap }); }
    const sig = rows.map((r) => r.row.tokenAddress + ':' + Math.round((num(r.liveMcap) || 0) / 1000)).join('|');
    if (!force && sig === matchSig && now - matchAt < 15000) return;
    matchSig = sig; matchAt = now;
    const cur = GM_getValue('agMatches', null) || {};
    const m = Core.mergeMatches(cur.m && typeof cur.m === 'object' ? cur.m : {}, rows, now, MATCH_TTL);
    GM_setValue('agMatches', { at: now, cardsAt: rows.length ? now : cur.cardsAt || 0, m, v: VER });
  }
  const { num } = Core;
  let lastCardEl = null;
  function activeCard() {
    // fast path: the card that was active last time is usually still the active one
    if (lastCardEl && lastCardEl.isConnected) { const p = cardRow(lastCardEl); if (p && p.active) return p.s; }
    for (const el of document.querySelectorAll(LT_CARDS)) {
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
  tradeWidget('ag', agMint, agSymbol, agLocalCall, null);
  { const pub = () => { try { publishMatches(); } catch (_) {} }; pub(); setInterval(() => { if (!document.hidden) pub(); }, 3000); document.addEventListener('visibilitychange', pub);
    try { const wk2 = new Worker(URL.createObjectURL(new Blob(['setInterval(()=>postMessage(0),3000)'], { type: 'text/javascript' }))); wk2.onmessage = () => { if (document.hidden) pub(); }; } catch (_) {} }


  function tradeWidget(env, getMint, getSymbol, localCall, site) {
    const SN = site ? site.name : 'AG'; // terminal name for the UI
    const AG = 'https://backtester.alphagardeners.xyz';
    const { num, escH, tail, sol, kfmt, usdV, unitLab, fmtM, agoS, msS, parseUsd, parseMc, scalePx, PUMP, bagCost, costOf, soldOf, avgEntry, rng, matchFlows, scaleLegs,
      metric, metricsOf, firstOf, riskLevel, profileChips, tradeRows, sigTime, srcName } = Core;
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
      bund: { open: true, view: 'list', rules: [], watch: [], bg: true }, // Trojan bundles panel, rules, watched funders
      intel: { on: false, open: true }, // AG Intel panel docked to the widget on coin pages (off by default; ⚙ → AG Intel)
      bar: true,         // holdings bar at the top of the page
      w: 380,            // widget width at 100% size: ≥ 600 switches to the wide (2-column) layout
      barOneClick: false,
      barOnAg: false,
      barBox: null,      // holdings bar position / size {x, y, w, h} (null = centred at the top)
      barHide: {},       // mint → true: positions hidden from the bar (until that position is closed)
      barSort: 'value',  // bar order: value | pnl | pct
      cardIntel: true,   // AG risk pill + hover peek on terminal cards
      filter: { mode: 'smart', native: false, after: 10 }, // AG filter on terminal lists (see Core.filterAction / nativeDue)
      hiddenCoins: [],
      hiddenMeta: {},    // mint → { t: hidden at (ms), n: AG signals known at that time }
      unhideOnSignal: true, // a hidden coin comes back when AG fires a new signal on it
      autoReopen: true,  // GMGN: re-open the backtester tab in the background when it is gone for 30s
      alerts: {},
      scale: 1,          // widget size (drag the corner grip; double-click resets)
      autoFit: true,     // shrink to fit the screen height when needed
    }, GM_getValue('tw', {}));
    st.wallets = Object.assign({ live: [], paper: [] }, st.wallets || {});
    st.protect = Object.assign({ arm: 70, floor: 15, pct: 100 }, st.protect || {});
    if (!Array.isArray(st.groups)) st.groups = [];
    if (!Array.isArray(st.strats)) st.strats = [];
    st.intel = Object.assign({ on: false, open: true }, st.intel || {});
    if (!st.v32) { st.v32 = 1; st.intel.on = false; } // 3.2: the side panel is opt-in now
    if (!Array.isArray(st.hiddenCoins)) st.hiddenCoins = [];
    if (!st.hiddenMeta || typeof st.hiddenMeta !== 'object') st.hiddenMeta = {};
    for (const m of st.hiddenCoins) if (!st.hiddenMeta[m]) st.hiddenMeta[m] = { t: Date.now(), n: null }; // hidden before 3.4: watch from now on
    st.safety = Object.assign({ maxPerCoin: 0, dailyLoss: 0, impactWarn: 10, dupSec: 3 }, st.safety || {});
    st.filter = Object.assign({ mode: 'smart', native: false, after: 10 }, st.filter || {});
    st.bund = Object.assign({ open: true, view: 'list', rules: [], watch: [], bg: true }, st.bund || {});
    if (!Array.isArray(st.bund.rules)) st.bund.rules = [];
    if (!Array.isArray(st.bund.watch)) st.bund.watch = [];
    if (!st.barHide || typeof st.barHide !== 'object') st.barHide = {};
    if (!['value', 'pnl', 'pct'].includes(st.barSort)) st.barSort = 'value';
    if (!Core.FILTER_MODES.includes(st.filter.mode)) st.filter.mode = 'smart';
    { const A = st.alerts || {};
      st.alerts = { dev: Object.assign({ on: true, pct: 1, auto: false }, A.dev), whale: Object.assign({ on: true, sol: 5 }, A.whale), move: Object.assign({ on: false, pct: 30 }, A.move),
        fills: A.fills !== false, sound: A.sound !== false, desktop: !!A.desktop }; }
    const pos0 = GM_getValue('twPos_' + env, {});
    const ui = { collapsed: !!pos0.collapsed, panel: null, busy: '', edit: false, draft: {}, plan: null, filt: { sol: false, tok: false }, modal: null, stratEdit: null, posSort: 'pnl', shareHide: false,
      alertsSeen: {}, alertsGone: {}, tf: { tab: 'dip', target: '', amount: '0.5', pct: '50', trail: '25', total: '1', slices: '5', every: '30', expiry: '60', attach: true } };
    const save = () => GM_setValue('tw', st);
    const savePos = () => GM_setValue('twPos_' + env, { x: el.offsetLeft, y: el.offsetTop, collapsed: ui.collapsed });
    const id = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
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
    // GMGN side of the relay. One backtester tab owns it (agRelayOwner lease). Each call is acked within ms;
    // no ack in H.ackMs → the call never ran there, so it goes direct (orders included). Acked but no result
    // → an order is NOT resent (it may have executed), reads go direct.
    const H = { ackMs: 1500, lostMs: 20000, pingMs: 5000, reopenAfter: 30000, reopenEvery: 60000, skipAfterMiss: 15000 };
    const hs = { rtt: null, pingId: null, pingAt: 0, pongAt: 0, h: null, dstat: null, auth: null, log: [], st: '', reopenAt: 0 };
    const hl = (m, lvl) => { const l0 = hs.log[0]; if (l0 && l0.m === m && Date.now() - l0.t < 5000) return; hs.log.unshift({ t: Date.now(), m, lvl: lvl || 'i' }); hs.log.length = Math.min(hs.log.length, 30); };
    const pending = new Map(), acks = new Map();
    if (env !== 'ag') {
      GM_addValueChangeListener('agRpcRes', (_k, _o, v) => { const f = v && pending.get(v.id); if (f) { pending.delete(v.id); acks.delete(v.id); f({ r: v.results }); } });
      GM_addValueChangeListener('agRpcAck', (_k, _o, v) => { const f = v && acks.get(v.id); if (f) { acks.delete(v.id); f(); } });
      GM_addValueChangeListener('agPong', (_k, _o, v) => {
        if (!v || v.id !== hs.pingId) return;
        hs.rtt = Date.now() - hs.pingAt; hs.pongAt = Date.now(); hs.h = v.h; relayDownAt = 0; healthTick();
      });
      GM_addValueChangeListener('agHealth', (_k, _o, v, remote) => { if (remote && v) hs.h = v; });
    }
    const relayInfo = () => Core.relayMode(GM_getValue('agRelayOwner', null), GM_getValue('agRelayAt', 0) || 0, Date.now());
    function relay(calls, legacy) {
      return new Promise((res) => {
        const rid = id();
        let acked = !!legacy;
        pending.set(rid, res);
        acks.set(rid, () => { acked = true; });
        GM_setValue('agRpc', { id: rid, at: Date.now(), ackMs: legacy ? undefined : H.ackMs, calls });
        if (!legacy) setTimeout(() => { if (!acked && pending.has(rid)) { pending.delete(rid); acks.delete(rid); res({ noAck: true }); } }, H.ackMs);
        setTimeout(() => { if (pending.has(rid)) { pending.delete(rid); acks.delete(rid); res({ lost: true }); } }, H.lostMs);
      });
    }
    function noteAuth(results, ms, via) {
      const bad = results.find((r) => r && (r.status === 401 || r.status === 403));
      if (bad || results.some((r) => r && r.ok)) {
        const was = hs.auth;
        hs.auth = { ok: !bad, status: bad ? bad.status : 200, ms, at: Date.now(), via };
        if (was && was.ok !== hs.auth.ok) hl(hs.auth.ok ? 'AG session OK again' : `AG answered ${hs.auth.status}: log in on the backtester`, hs.auth.ok ? 'i' : 'bad');
      }
    }
    // isOrder: never re-send an order through a second path after it was acked (avoid double buys)
    let relayDownAt = 0;
    async function call(calls, isOrder) {
      if (env === 'ag') return Promise.all(calls.map((c) => localCall(c.method, c.path, c.body)));
      const ri = relayInfo(), t0 = Date.now();
      if (ri.mode === 'legacy') {
        const r = await relay(calls, true);
        if (r.r) { noteAuth(r.r, Date.now() - t0, 'relay'); return r.r; }
        if (isOrder) return calls.map(() => ({ status: 0, ok: false, j: { error: 'no answer from the backtester tab – check Positions before retrying' } }));
      } else if (ri.mode === 'v2' && Date.now() - relayDownAt > H.skipAfterMiss) {
        const r = await relay(calls);
        if (r.r) { noteAuth(r.r, Date.now() - t0, 'relay'); return r.r; }
        if (r.noAck) { relayDownAt = Date.now(); hl(`backtester tab did not answer in ${H.ackMs / 1000}s → sent direct`, 'warn'); GM_setValue('twPing', Date.now()); }
        else if (isOrder) { hl('order acked by the backtester tab but no result in 20s', 'bad'); return calls.map(() => ({ status: 0, ok: false, j: { error: 'the backtester tab took the order but did not answer – check Positions before retrying' } })); }
      }
      const t1 = Date.now(), out = await Promise.all(calls.map(direct));
      noteAuth(out, Date.now() - t1, 'direct');
      hs.dstat = { at: Date.now(), ms: Date.now() - t1, ok: out.some((r) => r.ok) };
      return out;
    }
    // A buy / sell is refused up front when AG just told us the session is gone (instead of failing per wallet).
    function authBlock() {
      const a = env === 'ag' ? HL.sess : (hs.h && hs.h.sess && (!hs.auth || hs.h.sess.at > hs.auth.at) ? hs.h.sess : hs.auth);
      return Core.authExpired(a, Date.now()) ? `AG session expired (${a.status}): log in on the backtester, then retry` : '';
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
      // terminal tabs go through the backtester tab's request cache (30s for this list): a fresh read gets its own key
      const [r] = await call([{ method: 'GET', path: `/api/performance/wallets-list?source=${st.mode}${fresh && env !== 'ag' ? '&t=' + Date.now() : ''}` }]);
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
    function mcapUsd(mint) {
      if (env === 'ag' && lastRow && lastRow.tokenAddress === mint) { const v = num(lastRow.currentMcap, lastRow.mcap, lastRow.signalMcap); if (v > 0) return v; }
      return env === 'ag' ? null : parseUsd(document.title);
    }
    const supplyCost = (pct, mint) => Core.supplyCost(pct, mint, mcapNow(mint), usdRate);
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
      if (!c) return toast(usdRate ? `No market cap for this token yet (${env === 'ag' ? 'AG card' : SN + ' title'}) – use SOL mode` : 'No SOL price yet – open the wallet list once', true);
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
          const best = Core.pickUnit(v, ref, usdRate); // waits for a reference before trusting an unknown unit
          if (best == null) continue;
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
      GM_addValueChangeListener('twPosPing', (_k, _o, _v, remote) => { if (remote) { loadPos(); if (env !== 'ag') loadHeld(); if (st.mode === 'live') loadWallets(true); } });
      if (env !== 'ag') {
        const rd = () => { const m = getMint(), v = parseUsd(document.title); if (m && v) putTick(m, v, env, true); };
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
      const S = HL.sock;
      sock.on('connect', () => {
        const back = S.since > 0; stream.ok = true; S.ok = true;
        if (back) { S.re++; hlog(`AG socket reconnected${S.down ? ' after ' + ((Date.now() - S.down) / 1000).toFixed(1) + ' s' : ''} · resubscribing`); }
        S.since = Date.now(); S.down = 0; subs.clear(); sync(); render();
      });
      sock.on('disconnect', (why) => { stream.ok = false; S.ok = false; S.down = Date.now(); hlog('AG socket disconnected' + (why ? ' (' + why + ')' : ''), 'warn'); render(); });
      try { if (sock.io && typeof sock.io.on === 'function') sock.io.on('ping', () => { S.ping = Date.now(); }); } catch (_) {}
      const reconnect = () => { try { if (typeof sock.disconnect === 'function') sock.disconnect(); setTimeout(() => { try { sock.connect(); } catch (_) {} }, 400); } catch (_) {} };
      HL.reconnect = reconnect;
      // watchdog: "connected" but silent (no server ping, no event) for 75s → reconnect; socket.io handles the backoff
      setInterval(() => {
        S.subs = subs.size;
        if (!sock.connected || !S.since) return;
        const lastSign = Math.max(S.since, S.last, S.ping);
        if (Date.now() - lastSign > 75000) { hlog('AG socket silent for 75 s → reconnecting', 'warn'); S.since = Date.now(); reconnect(); }
      }, 15000);
      setInterval(sync, 2000);
      const onData = (ev) => (d) => {
        S.last = Date.now();
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
      return ok;
    }
    function buyLegs(amount, ws, split, jitterPct) { // rules: Core.buyLegs
      const r = Core.buyLegs(amount, ws, { split, jitterPct, reserve: st.reserve, balOf, shuffle: Number(st.stagger) > 0 });
      return { legs: r.legs, skipped: r.skipped.map((w) => `${labelOf(w)} (${sol(balOf(w))}◎)`) };
    }

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
    const buyImpact = (totalSol, mint) => Core.buyImpact(totalSol, mint, mcapNow(mint), usdRate);
    const lastBuyAt = (mint) => (GM_getValue('twLastBuy', {}) || {})[mint] || 0;
    function markBuy(mint) { const m = GM_getValue('twLastBuy', {}) || {}; m[mint] = Date.now(); for (const k of Object.keys(m)) if (Date.now() - m[k] > 600e3) delete m[k]; GM_setValue('twLastBuy', m); }

    // One buy engine for buttons, hotkeys, cards and trigger orders.
    //  interactive: LIVE confirm / rail warnings go through the in-widget dialog (override possible)
    //  non-interactive (orders): rails are enforced – trimmed to the per-coin room or skipped
    async function execBuy({ mint, symb, wallets: ws, amount, split, mode, note, interactive, strat, jitter }) {
      mode = mode || st.mode;
      const live = mode === 'live', S = SF();
      { const ab = authBlock(); if (ab) { if (interactive !== false) toast(ab, true); return { ok: 0, err: ab }; } }
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
      if (okN) {
        if (live) legs.forEach((x, i) => { if (res[i] && res[i].ok) spendLocal(x.w, x.amt); }); // balances drop right away
        pendingBuy[mint] = { sym: name, sol: legs.reduce((a, x, i) => a + (res[i] && res[i].ok ? x.amt : 0), 0), mode, until: Date.now() + 30000 };
      }
      settle(mint, mode);
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
      { const ab = authBlock(); if (ab) { if (interactive !== false) toast(ab, true); return { ok: 0, err: ab }; } }
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
      if (okN && okN === res.length && pct >= 100 && !only) { pendingGone[mint] = Date.now() + 120000; delete pendingBuy[mint]; renderBar(); render(); } // fully sold: gone from the bar now
      settle(mint, mode);
      return { ok: okN };
    }
    async function sell(pct) {
      const mint = getMint();
      if (!mint) return toast('Open a token first', true);
      if (!(Number(pct) > 0) || ui.busy) return;
      return execSell({ mint, pct, wallets: st.mode === 'paper' && !selected().length ? null : selected(), interactive: true });
    }
    // Sell initials: per wallet, sell just enough to take out what you put in (cost − already sold).
    async function sellInit(mintArg, auto) { // auto: run by a rule, no confirm
      const mint = mintArg || getMint();
      if (!mint) return toast('Open a token first', true);
      if (ui.busy && !auto) return;
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
      if (st.mode === 'live' && !auto) {
        const v = await ask({ tone: 'live', title: 'Sell initials', sub: `${name} · take your entry out, ride the rest`,
          lines: plan.map((x) => `${labelOf(x.w)} · sell ${x.pct}% ≈ ${sol(x.need)} ◎`), warn: skipped.length ? ['Skipped: ' + skipped.join('; ')] : [],
          actions: [{ label: 'Cancel', v: null, kind: 'ghost' }, { label: `Sell initials (${plan.length})`, v: 'go', kind: 'pri' }] });
        if (!v) return;
      }
      ui.busy = 'sell init'; render();
      const res = await call(plan.map((x) => ({ method: 'POST', path: `/api/tokens/${mint}/sell`, body: { percent: x.pct, source: st.mode, idempotencyKey: id(), walletAddress: x.w } })), true);
      ui.busy = ''; render();
      report('Sell initials', res, plan.length > 1 ? `×${plan.length}` : `${plan[0].pct}%`);
      settle(mint, st.mode);
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
            if (okN) { settle(o.mint, o.mode); GM_setValue('twPosPing', Date.now()); } // other tabs refresh too
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
    const usdS = (solV) => (solV == null || !usdRate ? '' : usdV(solV * usdRate));
    // token amount ≈ value / price, price = mcap / 1B (pump.fun-style supply); shown with "≈"
    function tokEst(worthSol) {
      const mint = getMint(), mu = mint && mcapNow(mint);
      if (!(mu > 0) || !(usdRate > 0) || worthSol == null) return null;
      return worthSol / (mu / usdRate / PUMP.SUPPLY);
    }
    const tokFmt = (w) => { const t = tokEst(w); return t == null ? sol(w) + ' ◎' : '≈' + kfmt(t); };
    const curvePct = (mint) => Core.curvePct(mint, mcapNow(mint), usdRate);
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
      chev: sv('<path d="M15 6l-6 6 6 6"/>', 14),
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
    #agtw .agm{font-size:10px;font-weight:700;color:#15180F;background:var(--acc);border-radius:5px;padding:0 6px;white-space:nowrap}#agtw .agm.y{background:#fbbf24}#agtw .agm.r{background:#f87171}
    #agtw .agn{font-size:10px;color:var(--sell);border:1px solid var(--sellB);border-radius:5px;padding:0 6px;white-space:nowrap}
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
    #agtw{display:flex;align-items:stretch;width:auto!important}
    #agtw .in{width:calc(var(--w) * var(--k));flex:none}
    #agtw.col .in{width:auto}
    #agtw .rw{position:absolute;top:14px;bottom:22px;right:-3px;width:7px;cursor:ew-resize;z-index:4;border-radius:4px}
    #agtw .rw:hover,#agtw .rw.on{background:#B8F04A55}
    #agtw.col .rw{display:none}
    #agtw.wide .bd{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);column-gap:18px;align-items:start}
    #agtw.wide .bd>.tk{grid-column:1/-1}
    #agtw.wide .bd>.sbuy{grid-column:1;grid-row:2 / span 3}
    #agtw.wide .bd>.ssell{grid-column:2;grid-row:2;padding-top:10px}
    #agtw.wide .bd>.ax{grid-column:2;grid-row:3;margin-top:4px}
    #agtw.wide .bd>.sep{display:none}
    #agtw.wide .ft{display:grid;grid-template-columns:minmax(0,1.25fr) minmax(0,1fr);column-gap:18px;align-items:center}
    #agtw.wide .ft>.dl{grid-column:1/-1}
    #agtw.wide .als{display:grid;grid-template-columns:repeat(2,minmax(0,1fr))}
    #agtw.wide .pnl{max-height:360px}
    #agtw .intel{position:relative;width:300px;flex:none;border-left:1px solid #34401F;background:#15171B;border-radius:0 14px 14px 0}
    #agtw .intel .ii{position:absolute;inset:0;overflow:auto;scrollbar-width:thin;padding:10px;display:flex;flex-direction:column;gap:10px}
    #agtw .intel.tab{width:30px;display:flex;flex-direction:column;align-items:center;gap:8px;padding:12px 0;background:#1A2012;color:var(--acc);font-size:10px}
    #agtw .intel.tab .v{writing-mode:vertical-rl;transform:rotate(180deg)}
    #agtw .intel.tab b{writing-mode:vertical-rl;transform:rotate(180deg);font-size:11px}
    #agtw .intel.bund{width:340px;border-left-color:#5A4A1C}
    #agtw .bhero{display:flex;gap:10px;align-items:center;border-radius:12px;padding:9px 10px;border:1px solid var(--ln);background:#1C1F25}
    #agtw .bhero.bad{background:#2A1418;border-color:#5C2A33}#agtw .bhero.mid{background:#2A2412;border-color:#5A4A1C}#agtw .bhero.ok{background:#13261C;border-color:#24563C}
    #agtw .bring{width:46px;height:46px;border-radius:46px;border:4px solid var(--mut2);display:flex;align-items:center;justify-content:center;font-size:15px;font-weight:700;flex:none;box-sizing:border-box}
    #agtw .bhero.bad .bring{border-color:#B9505F;color:#FFC2C2}#agtw .bhero.mid .bring{border-color:#F2B84B;color:#FFE08A}#agtw .bhero.ok .bring{border-color:#4FAF7D;color:#CFF7E1}
    #agtw .bhero.bad .ih b{color:var(--sell)}#agtw .bhero.mid .ih b{color:#FFE08A}#agtw .bhero.ok .ih b{color:var(--buy)}
    #agtw .g4b{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:5px}#agtw .g4b .itile{padding:5px 6px}#agtw .g4b .itile span{font-size:9px}
    #agtw .bsup{display:flex;flex-direction:column;gap:4px}
    #agtw .bbar{display:flex;height:8px;border-radius:6px;overflow:hidden;background:var(--ln2)}#agtw .bbar i{display:block;height:8px}
    #agtw .bth{display:flex;gap:6px;font-size:9.5px;color:var(--mut2);letter-spacing:.06em;padding:0 2px}
    #agtw .bc1{width:44px;text-align:right;flex:none}#agtw .bc2{width:70px;text-align:right;flex:none}#agtw .bc3{width:52px;text-align:right;flex:none}
    #agtw .blist{display:flex;flex-direction:column}
    #agtw .brow{display:flex;flex-wrap:wrap;align-items:center;gap:6px;padding:7px 2px;border-top:1px solid var(--ln2);text-align:left;width:100%}
    #agtw .brow:hover{background:#1A1D22}
    #agtw .bdot{width:8px;height:8px;border-radius:3px;flex:none;display:inline-block}
    #agtw .bn2{display:flex;flex-direction:column;flex:1;min-width:0}#agtw .bn2 .sm{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    #agtw .bwn{background:var(--ln2);border-radius:5px;padding:0 4px;font-size:10px;color:#C9CDD4;white-space:nowrap}
    #agtw .bund .g2 .btn{justify-content:center;white-space:normal;text-align:center;line-height:1.2;min-height:32px}
    #agtw .bleft{flex-basis:100%;height:3px;border-radius:3px;background:var(--ln2);overflow:hidden;margin-left:14px}#agtw .bleft i{display:block;height:3px}
    #agtw .mvp{font-size:9px;font-weight:700;letter-spacing:.04em;border-radius:5px;padding:1px 5px;background:var(--ln2);color:#C9CDD4;white-space:nowrap}
    #agtw .mvp.dump{background:#5C1414;color:#FFC2C2}#agtw .mvp.acc{background:#163126;color:#8FE6B4}#agtw .mvp.watch{background:#221A3A;color:#D2C5FF}#agtw .mvp.exit{background:#1A1C21;color:var(--mut)}
    #agtw .bfund{display:flex;align-items:center}
    #agtw .bfn{display:flex;flex-direction:column;gap:2px;background:#221A3A;border:1px solid #5B47A8;border-radius:9px;padding:6px 8px;color:#D2C5FF;flex:none;max-width:120px}
    #agtw .bln{flex:1;height:1px;background:#5B47A8;min-width:12px}
    #agtw .bws{display:flex;flex-direction:column;gap:4px;width:150px;flex:none}
    #agtw .bw{display:flex;gap:6px;background:var(--bg2);border:1px solid var(--ln);border-radius:7px;padding:3px 6px;font-size:11px}
    #agtw .bchip{font-size:10.5px;border-radius:999px;padding:1px 8px;border:1px solid var(--ln);color:#C9CDD4}
    #agtw .bchip.dn{background:#2A1418;border-color:#5C2A33;color:var(--sell)}#agtw .bchip.y{background:#2A2412;border-color:#5A4A1C;color:#FFE08A}#agtw .bchip.vi{background:#221A3A;border-color:#5B47A8;color:#D2C5FF}
    #agtw .btl{display:flex;flex-direction:column;gap:5px}
    #agtw .bev{display:flex;align-items:flex-start;gap:6px;font-size:11px}#agtw .bev>.n{width:30px;flex:none;font-size:10px}#agtw .bev .mvp{flex:none;width:44px;text-align:center}
    #agtw .bform{display:flex;flex-direction:column;gap:7px;background:#1C1F25;border:1px solid var(--ln);border-radius:10px;padding:9px}
    #agtw .bform select{width:100%}
    #agtw .bsent{background:var(--bg3);border:1px solid var(--ln2);border-radius:8px;padding:7px 8px;color:#C9CDD4;line-height:1.4}
    #agtw .intel.tab.bund{background:#2A2412;color:#FFE08A}
    #agtw .ihd{position:sticky;top:-10px;background:#15171B;margin:-10px -10px 0;padding:8px 10px;z-index:1;border-bottom:1px solid var(--ln2)}
    #agtw .ihero{display:flex;gap:10px;align-items:center;background:#1A2012;border:1px solid #4E6420;border-radius:12px;padding:10px}
    #agtw .iring{position:relative;width:56px;height:56px;flex:none}
    #agtw .iring .ic{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;line-height:1}
    #agtw .iring .ic span{font-size:8px;color:#A9C38A;letter-spacing:.06em}#agtw .iring .ic b{font-size:17px;color:var(--acc)}
    #agtw .ih{display:flex;flex-direction:column;gap:3px;min-width:0}
    #agtw .itg{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px}
    #agtw .itile{background:#1C1F25;border:1px solid var(--ln);border-radius:9px;padding:6px 8px;display:flex;flex-direction:column;gap:1px}
    #agtw .itile span{font-size:10px;color:var(--mut)}#agtw .itile b{font-size:13px}#agtw .itile small{font-size:9.5px;color:var(--mut)}
    #agtw .itile.ok{border-color:#24563C}#agtw .itile.mid{border-color:#5A4A1C}#agtw .itile.bad{border-color:#5C2A33;background:#22161A}
    #agtw .ibox{background:#1C1F25;border:1px solid var(--ln);border-radius:10px;padding:8px 9px;display:flex;flex-direction:column;gap:6px;min-width:0}
    #agtw .ifl{display:flex;align-items:flex-end;gap:5px;height:48px}
    #agtw .ifl>div{flex:1;display:flex;flex-direction:column;justify-content:flex-end;height:48px;gap:1px}
    #agtw .ifl .fb{display:block;background:#4FAF7D;border-radius:3px 3px 0 0}#agtw .ifl .fs{display:block;background:#B9505F;border-radius:0 0 3px 3px}
    #agtw .g2{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px}
    #agtw .tier{font-size:9.5px;font-weight:700;color:#15180F;background:var(--buy);border-radius:4px;padding:0 5px}
    #agtw .lk3{width:100%;color:var(--tx)}
    #agtw .imt{display:grid;grid-template-columns:1fr auto auto;gap:3px 10px;font-size:11px}
    #agtw .iyou{display:flex;align-items:center;gap:8px;background:#13261C;border:1px solid #24563C;border-radius:10px;padding:7px 9px}
    #agtw .iact .btn{justify-content:center;height:32px;text-decoration:none;color:var(--tx)}
    #agtw .iact .btn.ok{color:var(--buy)}
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
    #agtw .hf{display:flex;align-items:stretch;height:24px;padding-right:14px;border-top:1px solid var(--ln2);background:#111316;font:500 10px/24px 'IBM Plex Mono',ui-monospace,Menlo,monospace;color:var(--mut2);border-radius:0 0 13px 13px}
    #agtw .hf.y{background:#1E1A10;border-top-color:#5A4A1C}#agtw .hf.r{background:#231316;border-top-color:#5C2A33}
    #agtw .hfi{flex:1;min-width:0;display:flex;align-items:center;background:none;border:0;padding:0 4px;cursor:pointer;color:inherit;font:inherit;overflow:hidden;text-align:left}
    #agtw .hfi>span{display:flex;align-items:center;gap:4px;padding:0 5px;white-space:nowrap;border-right:1px solid #1F2228;line-height:14px;min-width:0}
    #agtw .hfi>span:last-child{border-right:0}
    #agtw .hf .k{color:#6E7480}#agtw .hf .v{color:#C9CDD4}#agtw .hf .v.y{color:#FFE08A}#agtw .hf .v.r{color:#F59AA6}
    #agtw i.hdt{width:6px;height:6px;border-radius:6px;display:inline-block;flex:none;background:#4B5160}
    #agtw i.hdt.g{background:#3DDC97}#agtw i.hdt.y{background:#F2B84B}#agtw i.hdt.r{background:#F05252}
    #agtw .hfa{background:none;border:0;font:600 10px 'IBM Plex Sans',Inter,system-ui,sans-serif;padding:0 6px;cursor:pointer;color:var(--mut2);white-space:nowrap;flex:none}
    #agtw .hf.y .hfi>span.g .k,#agtw .hf.r .hfi>span.g .k,#agtw .hf.y .hfi>span.n .k,#agtw .hf.r .hfi>span.n .k{display:none}#agtw.wide .hf .hfi>span .k{display:inline}
    #agtw .hf.y .hfa{color:#FFE08A}#agtw .hf.r .hfa{color:#F59AA6}
    #agtw .hhr{display:flex;align-items:center;gap:8px}
    #agtw .hhr .hn{display:flex;flex-direction:column;min-width:0;flex:1}#agtw .hhr .hn b{font-weight:600;font-size:11.5px}
    #agtw .hhr .hn span{font-size:10.5px;color:var(--mut2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    #agtw .hhr .hv{width:54px;text-align:right;color:#C9CDD4;font-size:11px}
    #agtw .hlg{border-top:1px solid var(--ln2);padding-top:6px;display:flex;flex-direction:column;gap:2px;font-size:10.5px}
    #agtw .hlg .warn{color:#FFE08A}#agtw .hlg .bad{color:#F59AA6}
    #agtw .hbadge{font-size:9.5px;font-weight:700;letter-spacing:.04em;color:#15180F;border-radius:4px;padding:0 6px}
    #agtw .dot.ok{background:#3DDC97}#agtw .dot.warn{background:var(--warn)}#agtw .dot.bad{background:#F05252}
    #agtw .keys{display:flex;flex-wrap:wrap;gap:4px 10px}
    #agtw kbd{font:600 10px 'IBM Plex Mono',monospace;background:#24272E;border:1px solid #3A3F48;border-bottom-width:2px;border-radius:5px;padding:1px 5px;color:#E6E8EC}
    #agtw .als{display:flex;flex-direction:column;gap:6px;padding:8px 12px 0}
    #agtw .al{border-radius:10px;padding:8px 10px;display:flex;flex-direction:column;gap:6px;background:#1C1F25;border:1px solid #5A4A1C}
    #agtw .al.dev,#agtw .al.bundle{background:#2A1418;border-color:#B9505F}
    #agtw .al .g3 .btn{justify-content:center}
    #agtw .atag{font-size:9.5px;font-weight:700;letter-spacing:.08em;border-radius:5px;padding:1px 6px;background:#2A2412;color:#FFE08A;flex:none}
    #agtw .al.dev .atag,#agtw .al.bundle .atag{background:#B9505F;color:#FFF0F2}
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

    // ---------------------------------------------------------- AG Intel (docked panel on coin pages + card insight)
    // Sources (AG's own endpoints, same ones its token page uses):
    //  /api/tokens/<mint>/profile          → signalAt, firstSignalMcap, signalMcap, currentMcap, athMcap, winPredPercent,
    //                                         metrics{…} (now) and firstMetrics{…} (at the first signal)
    //  /api/tokens/<mint>/creator-holdings → creator / cohort share of supply, launch → now
    //  /api/tokens/<mint>/recent-swaps     → live trades: side, solAmount, isSmartMoney, walletType (1 = fresh), blockTime
    //  /api/swaps/by-token/<mint>          → the AG signals (preset matches) for this coin
    const IM = [ // metric key, label, unit, "risk" direction (+1 = higher is worse, -1 = higher is better), watch / risk levels
      ['creatorHoldingPct', 'Dev hold', '%', 1, 5, 10], ['bundledPct', 'Bundled', '%', 1, 10, 20], ['topHoldersPct', 'Top holders', '%', 1, 30, 45],
      ['drainedPct', 'Drained', '%', 1, 15, 30], ['smCount', 'Smart money', '', -1, 1, 0], ['holdersCount', 'Holders', '', 0],
    ];
    const IM_MORE = [['agScore', 'AG score', ''], ['liquidityPct', 'Liquidity', '%'], ['volMcapPct', 'Vol / MCap', '%'], ['buyVolumePct', 'Buy vol', '%'], ['uniqueCount', 'Unique wallets', ''],
      ['convincedWalletsCount', 'Convinced', ''], ['kycCount', 'KYC wallets', ''], ['dormantCount', 'Dormant', ''], ['drainedCount', 'Drained wallets', ''], ['fer', 'FER', ''], ['ttc', 'TTC', ''],
      ['deployerAge', 'Deployer age', ''], ['deployerBalance', 'Deployer ◎', ''], ['marketDepth', 'Market depth', ''], ['liquidity', 'Liquidity $', '$']];
    const intelCache = {}; // mint → { prof, creator, swaps, sigs, at, hist:[{t, holders}] }
    const intelBusy = {};
    async function loadIntel(mint, force) {
      if (!mint || intelBusy[mint]) return;
      const c = intelCache[mint] || (intelCache[mint] = { hist: [] });
      if (!force && c.at && Date.now() - c.at < 15000) return;
      intelBusy[mint] = 1;
      try {
        const [p, cr, sw, sg] = await call([
          { method: 'GET', path: `/api/tokens/${mint}/profile` }, { method: 'GET', path: `/api/tokens/${mint}/creator-holdings` },
          { method: 'GET', path: `/api/tokens/${mint}/recent-swaps?limit=100` }, { method: 'GET', path: `/api/swaps/by-token/${mint}` }]);
        if (p && p.ok && p.j && p.j.found !== false) c.prof = p.j.profile || p.j;
        if (cr && cr.ok && cr.j && cr.j.available !== false) c.creator = cr.j.figures || null;
        if (sw && sw.ok && Array.isArray(sw.j.swaps)) c.swaps = sw.j.swaps;
        if (sg && sg.ok && Array.isArray(sg.j.swaps)) c.sigs = sg.j.swaps;
        c.at = Date.now();
        const h = metric(metricsOf(c.prof), 'holdersCount');
        if (h != null) { c.hist.push({ t: c.at, v: h }); c.hist = c.hist.slice(-40); }
        if (DEBUG) console.log('[AG widget] intel', mint, c);
      } finally { delete intelBusy[mint]; }
      if (mint === getMint()) render();
    }
    function intelFacts(mint) {
      const c = intelCache[mint];
      if (!c || !c.prof) return null;
      const p = c.prof, M = metricsOf(p), F = firstOf(p);
      const first = num(p.firstSignalMcap, p.signalMcap), now = mcapNow(mint) || num(p.currentMcap), ath = Math.max(num(p.athMcap) || 0, now || 0) || null;
      return { p, M, F, first, now, ath, mult: first && now ? now / first : null, athMult: first && ath ? ath / first : null, signalAt: num(p.signalAt), win: num(p.winPredPercent, M.winPredPercent), score: metric(M, 'agScore') };
    }
    const flowOf = (swaps) => Core.flowOf(swaps);
    const lvC = { ok: '#8FE6B4', mid: '#FFE08A', bad: '#F59AA6', n: '#E6E8EC' }; // hex: also used on GMGN cards, outside the widget's CSS vars
    function intelHtml() {
      const mint = getMint();
      if (!mint || !st.intel.on || ui.edit) return '';
      const c = intelCache[mint], f = intelFacts(mint);
      if (!st.intel.open) {
        const worst = f ? IM.map((d) => riskLevel(d, metric(f.M, d[0]))).sort((a, b) => ['bad', 'mid', 'ok', 'n'].indexOf(a) - ['bad', 'mid', 'ok', 'n'].indexOf(b))[0] : 'n';
        return `<button class="intel tab" data-a="intel" title="Show AG Intel"><span class="agt v">AG</span>${f && f.mult ? `<b class="n">${f.mult.toFixed(2)}×</b>` : ''}<i class="dot" style="background:${lvC[worst]}"></i></button>`;
      }
      let body;
      if (!c || (!c.prof && !c.at)) body = '<div class="mut sm">Loading AG data…</div>';
      else if (!f) body = '<div class="mut sm">AG has no profile for this coin yet (no signal, or not indexed).</div>';
      else {
        const sigs = c.sigs || [], presets = [...new Set(sigs.map((s) => s.presetName || s.preset || s.presetLabel).filter(Boolean))];
        const ago = f.signalAt ? Math.max(0, Math.round((Date.now() / 1000 - f.signalAt) / 60)) : null;
        const ring = f.score != null ? Math.max(0, Math.min(100, f.score)) : null;
        const hero = `<div class="ihero"><div class="iring">${ring != null ? `<svg viewBox="0 0 64 64" width="56" height="56"><circle cx="32" cy="32" r="27" fill="none" stroke="#2C3A18" stroke-width="7"/><circle cx="32" cy="32" r="27" fill="none" stroke="#B8F04A" stroke-width="7" stroke-linecap="round" stroke-dasharray="${(ring / 100) * 169.6} 170" transform="rotate(-90 32 32)"/></svg>` : ''}<div class="ic"><span>${ring != null ? 'SCORE' : 'AG'}</span><b class="n">${ring != null ? Math.round(f.score) : sigs.length || '—'}</b></div></div>
          <div class="ih"><b>${sigs.length ? `${sigs.length} signal${sigs.length > 1 ? 's' : ''}` : 'No signal'}${presets.length ? ' · ' + escH(presets.slice(0, 2).join(', ')) + (presets.length > 2 ? ` +${presets.length - 2}` : '') : ''}</b>
          ${f.first ? `<span class="n sm">signal ${mc$(f.first)}${ago != null ? ` · ${ago >= 60 ? Math.round(ago / 60) + 'h' : ago + 'm'} ago` : ''} → <b class="${f.mult >= 1 ? 'up' : 'dn'}">${f.now ? mc$(f.now) : '--'}${f.mult ? ' · ' + f.mult.toFixed(2) + '×' : ''}</b></span>` : ''}
          <span class="n sm mut">${f.athMult ? `ATH ${f.athMult.toFixed(2)}× (${mc$(f.ath)})` : ''}${f.win != null ? ` · win pred ${f.win.toFixed(0)}%` : ''}</span></div></div>`;
        const tiles = IM.map((d) => { const v = metric(f.M, d[0]), v0 = metric(f.F, d[0]), lv = riskLevel(d, v);
          return `<div class="itile ${lv}" title="${escH(d[1])}${d[3] ? ` · watch ≥ ${d[4]}${d[2]}, risk ≥ ${d[5]}${d[2]} (rule of thumb)` : ''}"><span>${d[1]}</span><b class="n" style="color:${lvC[lv]}">${fmtM(v, d[2])}</b><small class="n">${v0 != null ? fmtM(v0, d[2]) + ' → ' + fmtM(v, d[2]) : 'at signal: --'}</small></div>`; }).join('');
        const fl = flowOf(c.swaps), mx = Math.max(0.01, ...fl.bins.map((b) => b.b + b.s));
        const flow = c.swaps ? `<div class="ibox"><div class="sh"><b class="sm2">Flow · last 5 min</b><span class="sp"></span><span class="n ${fl.net >= 0 ? 'up' : 'dn'}">net ${fl.net >= 0 ? '+' : '−'}◎ ${sol(Math.abs(fl.net))}</span></div>
          <div class="ifl">${fl.bins.map((b) => `<div><i class="fb" style="height:${((b.b / mx) * 46).toFixed(1)}px"></i><i class="fs" style="height:${((b.s / mx) * 46).toFixed(1)}px"></i></div>`).join('')}</div>
          <div class="pl n"><span>−5m</span><span>now</span></div>
          <div class="g3s three"><div class="sb"><span class="lb">SMART MONEY</span><span class="n" title="smart-money buys / sells"><span class="up">${fl.smB}↑</span> <span class="dn">${fl.smS}↓</span></span></div><div class="sb"><span class="lb">FRESH BUYERS</span><span class="n">${fl.fresh}</span></div><div class="sb"><span class="lb">TRADES</span><span class="n">${(c.swaps || []).filter((s) => Date.now() / 1000 - num(s.blockTime, s.timestamp) < 300).length}</span></div></div></div>` : '';
        const hs = c.hist, h0 = metric(f.F, 'holdersCount'), hn = metric(f.M, 'holdersCount');
        let spark = '';
        if (hs.length > 1) { const lo = Math.min(...hs.map((x) => x.v)), hi = Math.max(...hs.map((x) => x.v)); const pts = hs.map((x, i) => `${((i / (hs.length - 1)) * 150).toFixed(1)},${(30 - ((x.v - lo) / Math.max(1, hi - lo)) * 26).toFixed(1)}`).join(' '); spark = `<svg viewBox="0 0 150 32" width="100%" height="32" preserveAspectRatio="none"><polyline points="${pts}" fill="none" stroke="#8FE6B4" stroke-width="2"/></svg>`; }
        const cr = c.creator && c.creator.creator, co = c.creator && c.creator.cohort, tier = f.p.creatorTier || f.M.creatorTier;
        const two = `<div class="g2"><div class="ibox"><div class="sh"><span class="lb">HOLDERS</span><span class="sp"></span><b class="n">${hn != null ? kfmt(hn) : '--'}</b></div>${spark}${h0 != null && hn != null ? `<span class="n sm ${hn >= h0 ? 'up' : 'dn'}">${hn >= h0 ? '+' : ''}${Math.round(hn - h0)} since signal</span>` : ''}</div>
          <div class="ibox"><div class="sh"><span class="lb">CREATOR</span><span class="sp"></span>${tier ? `<span class="tier">TIER ${escH(String(tier))}</span>` : ''}</div>
          ${cr ? `<span class="n sm">dev ${escH(String(cr.launch))} → <b>${escH(String(cr.now))}</b></span>` : '<span class="mut sm">no creator data</span>'}${co ? `<span class="n sm">cohort ${escH(String(co.launch))} → ${escH(String(co.now))}</span>` : ''}
          ${metric(f.M, 'deployerAge') != null ? `<span class="n sm mut">deployer age ${fmtM(metric(f.M, 'deployerAge'), '')}</span>` : ''}</div></div>`;
        const more = IM_MORE.map(([k, l, u]) => [l, metric(f.F, k), metric(f.M, k), u]).filter((x) => x[1] != null || x[2] != null);
        const moreHtml = more.length ? `<div class="ibox"><button class="sh lk3" data-a="imore"><span class="lb">ALL AG METRICS · ${more.length}</span><span class="sp"></span>${ui.imore ? '−' : '+'}</button>${ui.imore ? `<div class="imt">${more.map(([l, a, b, u]) => `<span>${l}</span><span class="n mut">${fmtM(a, u)}</span><span class="n">${fmtM(b, u)}</span>`).join('')}</div>` : ''}</div>` : '';
        const sm = mint === getMint() ? summary() : null;
        const ex = (GM_getValue('twExits', {}) || {})[st.mode + ':' + mint];
        const you = sm && sm.bal > 0 ? `<div class="iyou"><span class="lb">YOU</span><b class="n ${sm.pnlSol >= 0 ? 'up' : 'dn'}">${sm.pnlSol >= 0 ? '+' : '−'}◎ ${sol(Math.abs(sm.pnlSol || 0))}${sm.pnl != null ? ' · ' + (sm.pnl >= 0 ? '+' : '') + sm.pnl.toFixed(0) + '%' : ''}</b><span class="sp"></span>${ex ? `<span class="ptag srv">${escH(ex.name)} on AG</span>` : ''}</div>` : '';
        body = hero + `<div class="lb">RISK · AT SIGNAL → NOW</div><div class="itg">${tiles}</div>` + flow + two + moreHtml + you;
      }
      const p = P(), first = (st.buyUnit === 'pct' ? p.sup : st.buyUnit === 'usd' ? p.usd : p.buy).find((a) => a > 0);
      return `<div class="intel"><div class="ii"><div class="sh ihd"><span class="agt">AG INTEL</span><b>${escH(sym || tail(mint))}</b><span class="sp"></span><button class="ib" data-a="intelr" title="Refresh">${ICON.refresh}</button><button class="ib" data-a="intel" title="Collapse">${ICON.chev}</button></div>
        ${body}
        <div class="g3 iact"><button class="btn ok" data-bu="${first || ''}" ${first ? '' : 'disabled'}>Buy ${first ? unitLab(first, st.buyUnit) : ''}</button><button class="btn" data-a="idip">Dip −30%</button><a class="btn" href="https://backtester.alphagardeners.xyz/#token/${mint}" target="_blank" rel="noopener">Open on AG</a></div></div></div>`;
    }


    // ---------------------------------------------------------- hidden coins come back on a new AG signal
    // Hiding is often done before AG's signal lands. While a hidden coin is still listed on the page we poll its
    // AG signals (/api/swaps/by-token, = matches of your presets) every 20s; a signal newer than the hide → unhide.
    function hideCoin(mint) {
      const c = intelCache[mint];
      st.hiddenCoins = [...new Set((st.hiddenCoins || []).concat(mint))].slice(-300);
      st.hiddenMeta[mint] = { t: Date.now(), n: c && Array.isArray(c.sigs) ? c.sigs.filter((x) => sigTime(x) == null).length : null };
      for (const k of Object.keys(st.hiddenMeta)) if (!st.hiddenCoins.includes(k)) delete st.hiddenMeta[k];
      save();
      toast(st.unhideOnSignal ? 'Coin hidden · it comes back if AG signals it' : `Coin hidden from ${SN} lists · unhide in ⚙`);
    }
    function unhideCoin(mint) {
      st.hiddenCoins = (st.hiddenCoins || []).filter((m) => m !== mint); delete st.hiddenMeta[mint]; save();
    }
    const hidChk = {}; let hidBusy = 0;
    function newSignal(mint, sigs, prof) { // rules: Core.newSignal
      const m = st.hiddenMeta[mint] || (st.hiddenMeta[mint] = { t: 0, n: null }); // hidden before 3.4: no timestamp
      const r = Core.newSignal(m, sigs, prof);
      if (r.baseline) save();
      return r.hit;
    }
    function watchHidden(mint) {
      if (!st.unhideOnSignal || env === 'ag' || hidBusy >= 2) return;
      if (Date.now() - (hidChk[mint] || 0) < 20000) return;
      hidChk[mint] = Date.now(); hidBusy++;
      (async () => {
        try {
          const [sg, p] = await call([{ method: 'GET', path: `/api/swaps/by-token/${mint}` }, { method: 'GET', path: `/api/tokens/${mint}/profile` }]);
          const sigs = sg && sg.ok && sg.j && Array.isArray(sg.j.swaps) ? sg.j.swaps : null;
          const prof = p && p.ok && p.j && p.j.found !== false ? p.j.profile || p.j : null;
          if (!sigs || !(st.hiddenCoins || []).includes(mint)) return;
          const c = intelCache[mint] || (intelCache[mint] = { hist: [] });
          c.sigs = sigs; if (prof) c.prof = prof;
          if (!newSignal(mint, sigs, prof)) return;
          unhideCoin(mint);
          ui.sigNew = Object.assign(ui.sigNew || {}, { [mint]: Date.now() });
          const last = sigs.slice().sort((a, b) => (sigTime(b) || 0) - (sigTime(a) || 0))[0] || {};
          const sym = (prof && prof.symbol) || mint.slice(0, 4) + '…';
          const pre = last.presetName || last.preset || last.presetLabel || '';
          toast(`AG signal on ${sym}${pre ? ' · ' + pre : ''} → back in your list`);
          notify(`AG signal · ${sym}`, `${pre || 'New signal'} on a coin you had hidden: it is back in your ${SN} list`, 'alert', mint);
          if (DEBUG) console.log('[AG widget] unhidden on signal', mint, last);
          scanCards();
        } catch (_) {} finally { hidBusy--; }
      })();
    }

    // ---------------------------------------------------------- AG insight on GMGN cards (visible cards only, cached)
    const cardQ = new Set();
    let cardBusy = 0;
    function wantCardIntel(mint) {
      if (!st.cardIntel || env === 'ag') return;
      const c = intelCache[mint];
      if (c && c.at && Date.now() - c.at < 90000) return;
      cardQ.add(mint); pumpCards();
    }
    async function pumpCards() {
      while (cardBusy < 3 && cardQ.size) {
        const m = cardQ.values().next().value; cardQ.delete(m); cardBusy++;
        (async () => {
          try {
            const c = intelCache[m] || (intelCache[m] = { hist: [] });
            const [p] = await call([{ method: 'GET', path: `/api/tokens/${m}/profile` }]);
            if (p && p.ok && p.j && p.j.found !== false) c.prof = p.j.profile || p.j;
            c.at = c.at || Date.now(); c.cardAt = Date.now();
          } finally { cardBusy--; scanCards(); pumpCards(); }
        })();
      }
    }
    function cardPill(mint) {
      const f = intelFacts(mint);
      if (!f) return '';
      const seg = [['creatorHoldingPct', 'D'], ['bundledPct', 'B'], ['topHoldersPct', 'T'], ['smCount', 'SM']].map(([k, l]) => { const d = IM.find((x) => x[0] === k), v = metric(f.M, k); return v == null ? '' : `<span style="color:${lvC[riskLevel(d, v)]}">${l} ${fmtM(v, d[2])}</span>`; }).filter(Boolean);
      if (!seg.length && !f.mult) return '';
      return `<span class="ip" data-peek="${mint}">${seg.join('<i>·</i>')}</span>`;
    }
    function peekHtml(mint) {
      const f = intelFacts(mint);
      if (!f) return '';
      const tiles = IM.slice(0, 5).map((d) => { const v = metric(f.M, d[0]), lv = riskLevel(d, v); return `<div><span>${d[1]}</span><b class="n" style="color:${lvC[lv]}">${fmtM(v, d[2])}</b></div>`; }).join('');
      return `<div class="sh"><span class="agt">AG</span><b>${escH(f.p.symbol || (heldAll[mint] || {}).sym || tail(mint))}</b>${f.mult ? `<span class="n ${f.mult >= 1 ? 'up' : 'dn'}">${f.mult.toFixed(2)}× signal</span>` : ''}<span class="sp"></span>${f.win != null ? `<span class="n mut">win ${f.win.toFixed(0)}%</span>` : ''}</div>
        <div class="pg">${tiles}<div><span>ATH</span><b class="n up">${f.athMult ? f.athMult.toFixed(2) + '×' : '--'}</b></div></div>
        <div class="g3"><button class="qbp" data-pbuy="${mint}">Buy ${st.qb} ◎</button><button class="qbp" data-popen="${mint}">Open</button><button class="qbp" data-phide="${mint}">Hide coin</button></div>`;
    }

    // ---------------------------------------------------------- GMGN card overlay
    // On every GMGN token card / table row: your position (all wallets in the current mode) with PnL,
    // plus a ⚡ quick-buy button (amount in ⚙, uses the current mode, buy mode and your default wallet selection).
    let held = {};
    let heldBusy = null;
    // ---- after a trade: show it right away, then re-read AG quickly until it shows it too.
    //  pendingBuy[mint]  = a buy AG hasn't listed yet (bar chip "pending")
    //  pendingGone[mint] = a full sell: hidden from the bar / cards until AG drops the position (2 min max)
    const pendingBuy = {}, pendingGone = {};
    function spendLocal(w, amt) { const x = wallets.find((v) => v.address === w); if (x && num(x.balanceSol) != null) x.balanceSol = Math.max(0, num(x.balanceSol) - amt); }
    const holdSig = (mint) => { const h = heldAll[mint]; return h ? h.worth.toFixed(4) + ':' + h.n : '-'; };
    const balSig = () => wallets.map((w) => w.address + ':' + w.balanceSol).join('|');
    function settle(mint, mode) {
      const steps = [600, 1500, 3000, 5000, 8000, 12000, 18000, 26000], h0 = holdSig(mint), b0 = balSig();
      let i = 0, seenH = false, seenB = mode !== 'live';
      const tick = async () => {
        if (st.mode !== mode) return;
        await Promise.all([loadHeld(true), mint === getMint() ? loadPos() : null, mode === 'live' ? loadWallets(true) : null]);
        seenH = seenH || holdSig(mint) !== h0; seenB = seenB || balSig() !== b0;
        if (++i < steps.length && !(seenH && seenB)) setTimeout(tick, steps[i] - steps[i - 1]);
        else if (seenH && seenB && i < steps.length) setTimeout(() => { loadHeld(true); if (mode === 'live') loadWallets(true); }, 2500); // one confirming read
      };
      setTimeout(tick, steps[0]);
    }
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
      const now = Date.now();
      for (const k of Object.keys(pendingGone)) if (!m[k] || now > pendingGone[k]) delete pendingGone[k]; // AG caught up on a full sell (or 2 min passed)
      for (const k of Object.keys(pendingBuy)) if (m[k] || now > pendingBuy[k].until || pendingBuy[k].mode !== st.mode) delete pendingBuy[k];
      let pruned = false; // a hidden position that was closed: forget it (a new buy shows again)
      for (const k of Object.keys(st.barHide)) if (!m[k] && !pendingGone[k]) { delete st.barHide[k]; pruned = true; }
      if (pruned) save();
      heldAll = m; held = m;
      if (env !== 'ag') scanCards();
      if (ui.panel === 'pos') render();
      renderBar();
    }
    const positioned = new WeakSet();
    // ---- AG filter (terminal tabs): the match list published by the backtester tab
    let agPack = env === 'ag' ? null : GM_getValue('agMatches', null) || {};
    const agMatch = (m) => (agPack && agPack.m && agPack.m[m]) || null;
    const agLive = () => Core.matchesLive(agPack, Date.now());
    const firstSeen = new Map(), nativeDone = new Set(env === 'ag' ? [] : GM_getValue('twNativeHidden', []) || []), nativeQ = [];
    let nativeBusy = false, nativeTimes = [];
    if (env !== 'ag') GM_addValueChangeListener('agMatches', (_k, _o, v) => { agPack = v || {}; scanCards(); render(); });
    const agCls = (r) => (r == null ? '' : r >= 60 ? 'r' : r > 33 ? 'y' : '');
    const agChip = (mint, m) => `<button class="am ${agCls(m.r)}" data-agopen="${mint}" title="${escH(m.s)}: in your AG Live Terminal · risk ${m.r ?? '—'} · win ${m.w ?? '—'}% · ${m.x ?? '—'}× from signal · click: open on AG">AG ${m.r ?? ''}${m.x ? ' · ' + m.x + '×' : ''}</button>`;
    function agTokChip(mint) {
      if (env === 'ag' || st.filter.mode === 'off' || !agPack || !agPack.at) return '';
      const m = agMatch(mint);
      if (m) return `<span class="agm ${agCls(m.r)}" title="In your filtered AG Live Terminal · risk ${m.r ?? '—'} · win ${m.w ?? '—'}%">AG ✓${m.x ? ' ' + m.x + '×' : ''}</span>`;
      return agLive() ? '<span class="agn" title="Not in your filtered AG Live Terminal">not in AG</span>' : '';
    }
    // hide a list row. Virtual lists (each row alone in an absolutely positioned wrapper) would break if the row left the
    // layout, so there the wrapper is made invisible instead.
    function setHidden(row, on) {
      if ((row.dataset.agtwH === '1') === on) return;
      if (on) {
        const p = row.parentElement;
        row.__agtwW = p && p.children.length <= 2 && getComputedStyle(p).position === 'absolute' ? p : null;
        row.dataset.agtwH = '1';
        if (row.__agtwW) row.__agtwW.style.visibility = 'hidden'; else row.style.display = 'none';
      } else {
        delete row.dataset.agtwH;
        if (row.__agtwW) row.__agtwW.style.visibility = '';
        row.style.display = '';
      }
    }
    function queueNative(mint) {
      if (nativeDone.has(mint) || nativeQ.includes(mint)) return;
      nativeQ.push(mint); pumpNative();
    }
    async function pumpNative() { // the terminal's own Hide token, at most 30 a minute
      if (nativeBusy) return;
      nativeBusy = true;
      try {
        while (nativeQ.length) {
          const now = Date.now();
          nativeTimes = nativeTimes.filter((t) => now - t < 60000);
          if (nativeTimes.length >= 30) { await sleep(5000); continue; }
          const mint = nativeQ.shift();
          if (!st.filter.native || st.filter.mode !== 'smart' || !agLive() || agMatch(mint) || mint === getMint()) continue;
          const card = [...document.querySelectorAll(site.cards)].find((x) => site.cardMint(x.getAttribute(site.cardAttr || 'href')) === mint);
          const btn = card && site.nativeHide && site.nativeHide(card);
          if (!btn) continue;
          btn.click();
          nativeDone.add(mint); nativeTimes.push(now);
          GM_setValue('twNativeHidden', [...nativeDone].slice(-3000));
          await sleep(250);
        }
      } finally { nativeBusy = false; }
    }
    function scanCards() {
      if (env === 'ag' || document.hidden) return;
      const seen = new Set(), hidden = new Set(st.hiddenCoins || []), vh = window.innerHeight, now = Date.now(), live = agLive(), F = st.filter;
      let nM = 0, nH = 0;
      const devAl = new Set(loadAlerts().filter((a) => a.kind === 'dev' && !ui.alertsGone[a.id]).map((a) => a.mint));
      for (const el of document.querySelectorAll(site.cards)) {
        if (el.closest('#agtw')) continue;
        if (site.cardMinH && el.getBoundingClientRect().height < site.cardMinH) continue;
        const row = (el.tagName === 'A' && el.closest('tr')) || el;
        const hostEl = row && (row.tagName === 'TR' ? row.cells[0] : row);
        if (!hostEl || seen.has(hostEl)) continue;
        seen.add(hostEl);
        const mint = site.cardMint(el.getAttribute(site.cardAttr || 'href'));
        if (!mint) continue;
        const cur = mint === getMint(), m = agMatch(mint), manual = hidden.has(mint) && !cur;
        if (!firstSeen.has(mint)) firstSeen.set(mint, now);
        const act = Core.filterAction(F.mode, live, !!m, cur);
        setHidden(row, manual || act === 'hide');
        if (row.classList.contains('agtw-dim') !== (act === 'dim')) row.classList.toggle('agtw-dim', act === 'dim');
        if (m) nM++; else if (act !== 'show') nH++;
        if (site.nativeHide && Core.nativeDue(F, live, !!m, firstSeen.get(mint), now)) queueNative(mint);
        if (manual) { watchHidden(mint); continue; }
        if (act === 'hide') continue;
        const ag = (m && F.mode !== 'off' ? agChip(mint, m) : '') + tbBadge(mint) + tbCardChip(mint);
        if (!st.cards) { // overlay off: only the AG badge (if any)
          const c0 = hostEl.querySelector(':scope > .agtw-c');
          hostEl.classList.remove('agtw-held', 'agtw-dev', 'agtw-sig');
          if (!ag) { if (c0) c0.remove(); continue; }
          if (c0 && c0.dataset.k === ag) continue;
          const c1 = c0 || hostEl.appendChild(Object.assign(document.createElement('div'), { className: 'agtw-c' }));
          if (!positioned.has(hostEl)) { positioned.add(hostEl); if (getComputedStyle(hostEl).position === 'static') hostEl.style.position = 'relative'; }
          c1.dataset.k = ag; c1.innerHTML = ag;
          continue;
        }
        if (st.cardIntel) { const r = hostEl.getBoundingClientRect(); if (r.bottom > -200 && r.top < vh + 200) wantCardIntel(mint); }
        const h = pendingGone[mint] ? null : held[mint], pill = st.cardIntel ? cardPill(mint) : '', dev = devAl.has(mint), sn = ui.sigNew && Date.now() - (ui.sigNew[mint] || 0) < 120000;
        const key = `${mint}|${h ? h.worth.toFixed(4) + ':' + h.pnl.toFixed(4) : '-'}|${st.qb}|${st.mode}|${st.buyMode}|${usdRate ? 1 : 0}|${pill}|${dev}|${sn ? 1 : 0}|${ag}`;
        let c = hostEl.querySelector(':scope > .agtw-c');
        if (hostEl.classList.contains('agtw-held') !== !!h) hostEl.classList.toggle('agtw-held', !!h);
        if (hostEl.classList.contains('agtw-dev') !== dev) hostEl.classList.toggle('agtw-dev', dev);
        if (hostEl.classList.contains('agtw-sig') !== !!sn) hostEl.classList.toggle('agtw-sig', !!sn);
        if (c && c.dataset.k === key) continue;
        if (!c) {
          c = document.createElement('div'); c.className = 'agtw-c';
          if (!positioned.has(hostEl)) { positioned.add(hostEl); if (getComputedStyle(hostEl).position === 'static') hostEl.style.position = 'relative'; }
          hostEl.appendChild(c);
        }
        c.dataset.k = key;
        const cost = h ? h.worth - h.pnl : 0, pct = h && cost > 0 ? (h.pnl / cost) * 100 : null;
        const nW = (st.wallets.live || []).length;
        c.innerHTML = ag + (sn ? '<span class="sg" title="You had hidden this coin; AG just signalled it">AG SIGNAL</span>' : '') + (dev ? '<span class="dv" title="The creator just sold (AG alert)">DEV SELL</span>' : '') + pill +
          (h ? `<span class="hp ${pct == null ? '' : pct >= 0 ? 'up' : 'dn'}" title="You hold this in ${h.n} ${st.mode} wallet${h.n > 1 ? 's' : ''}">◎ ${sol(h.worth)}${usd(h.worth) ? ' · ' + usd(h.worth) : ''}${pct == null ? '' : ` · ${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`}</span>` : '') +
          (st.qb > 0 ? `<button class="qb ${st.mode === 'live' ? 'live' : ''}" data-qb="${mint}" title="Quick buy ${st.qb} SOL ${st.mode === 'live' && nW > 1 ? (st.buyMode === 'split' ? 'split across ' : '× ') + nW + ' wallets ' : ''}(${st.mode.toUpperCase()})">⚡ ${st.qb}${st.mode === 'live' && nW > 1 ? (st.buyMode === 'split' ? ' ÷' : ' ×') + nW : ''}</button>` : '');
      }
      const was = ui.flt;
      ui.flt = { m: nM, h: nH, live };
      if (!was || was.m !== nM || was.h !== nH || was.live !== live) render();
    }
    let peekEl = null, peekT = 0;
    function showPeek(pill) {
      const mint = pill.dataset.peek, html = peekHtml(mint);
      if (!html) return;
      if (!peekEl) { peekEl = document.createElement('div'); peekEl.className = 'agtw-c agtw-peek'; document.body.appendChild(peekEl);
        peekEl.addEventListener('mouseenter', () => clearTimeout(peekT)); peekEl.addEventListener('mouseleave', hidePeek); }
      clearTimeout(peekT);
      peekEl.innerHTML = html; peekEl.dataset.mint = mint; peekEl.style.display = 'flex';
      const r = pill.getBoundingClientRect(), w = 280, hgt = peekEl.offsetHeight || 170;
      peekEl.style.left = Math.max(6, Math.min(window.innerWidth - w - 6, r.right - w)) + 'px';
      peekEl.style.top = (r.top - hgt - 8 > 6 ? r.top - hgt - 8 : r.bottom + 8) + 'px';
    }
    function hidePeek() { clearTimeout(peekT); peekT = setTimeout(() => { if (peekEl) peekEl.style.display = 'none'; }, 180); }
    function startCards() {
      const css = document.createElement('style');
      css.textContent = `
        .agtw-c{position:absolute;right:6px;bottom:6px;z-index:6;display:flex;gap:4px;align-items:center;font:600 10.5px/1.5 Inter,system-ui,sans-serif}
        .agtw-c .hp{background:#0d1117eb;border:1px solid #2b3240;border-radius:5px;padding:0 5px;color:#e5e7eb;white-space:nowrap}
        .agtw-c .hp.up{color:#86efac;border-color:#22c55e88}.agtw-c .hp.dn{color:#fca5a5;border-color:#ef444488}
        .agtw-c .qb{background:#14532d;border:1px solid #22c55e;color:#dcfce7;border-radius:5px;padding:0 6px;cursor:pointer;font:inherit}
        .agtw-c .qb:hover{background:#166534}
        .agtw-c .qb.live{background:#7f1d1d;border-color:#ef4444;color:#fee2e2}
        .agtw-c .ip{background:#0d1117eb;border:1px solid #2b3240;border-radius:5px;padding:0 6px;white-space:nowrap;font-family:'IBM Plex Mono',ui-monospace,Menlo,monospace;font-weight:500;font-size:10px;cursor:help}
        .agtw-c .ip:hover{border-color:#B8F04A}
        .agtw-c .ip i{font-style:normal;color:#4b5563;margin:0 3px}
        .agtw-c .dv{background:#7f1d1d;border:1px solid #ef4444;color:#fee2e2;border-radius:5px;padding:0 5px;font-weight:700;letter-spacing:.04em}
        .agtw-held{box-shadow:inset 3px 0 0 #a3e635}
        .agtw-dev{box-shadow:inset 3px 0 0 #ef4444}
        .agtw-sig{box-shadow:inset 3px 0 0 #B8F04A;background:#B8F04A12!important}
        .agtw-c .am{background:#a3e635;border:1px solid #a3e635;color:#0d1117;border-radius:5px;padding:0 5px;font:700 10px/1.5 system-ui,sans-serif;cursor:pointer;white-space:nowrap}
        .agtw-c .am.y{background:#fbbf24;border-color:#fbbf24}.agtw-c .am.r{background:#f87171;border-color:#f87171}
        .agtw-dim{opacity:.22;filter:grayscale(1);transition:opacity .15s}.agtw-dim:hover{opacity:.8}
        .agtw-c .sg{background:#B8F04A;border:1px solid #B8F04A;color:#15180F;border-radius:5px;padding:0 5px;font-weight:700;letter-spacing:.04em}
        .agtw-peek{position:fixed;right:auto;bottom:auto;z-index:100003;width:280px;box-sizing:border-box;flex-direction:column;align-items:stretch;gap:8px;background:#1C1F25;border:1px solid #4E6420;border-radius:12px;padding:10px;color:#E6E8EC;box-shadow:0 18px 44px #000c;display:none;font:500 11.5px/1.35 'IBM Plex Sans',Inter,system-ui,sans-serif}
        .agtw-peek .sh{display:flex;align-items:center;gap:6px}.agtw-peek .sp{flex:1}
        .agtw-peek .agt{font-size:9.5px;font-weight:700;letter-spacing:.08em;color:#15180F;background:#B8F04A;border-radius:4px;padding:1px 5px}
        .agtw-peek .n{font-family:'IBM Plex Mono',ui-monospace,Menlo,monospace}.agtw-peek .up{color:#8FE6B4}.agtw-peek .dn{color:#F59AA6}.agtw-peek .mut{color:#8B919C}
        .agtw-peek .pg{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:5px}
        .agtw-peek .pg>div{background:#17191E;border-radius:7px;padding:4px 6px;display:flex;flex-direction:column}.agtw-peek .pg span{font-size:9.5px;color:#8B919C}
        .agtw-peek .g3{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:5px}
        .agtw-peek .qbp{height:28px;border-radius:7px;border:1px solid #2C3038;background:#24272E;color:#E6E8EC;font:600 11px Inter,system-ui,sans-serif;cursor:pointer}
        .agtw-peek .qbp[data-pbuy]{border-color:#4FAF7D;background:none;color:#8FE6B4}`;
      document.head.appendChild(css);
      // capture phase on window: runs before GMGN's own card click (which would open the token)
      const stop = (e) => { if (e.target.closest && e.target.closest('.agtw-c')) { e.preventDefault(); e.stopImmediatePropagation(); return true; } return false; };
      window.addEventListener('click', (e) => {
        if (!stop(e)) return;
        const ago = e.target.closest('[data-agopen]');
        if (ago) { window.open(AG + '/#token/' + ago.dataset.agopen, '_blank', 'noopener'); return; }
        const pb = e.target.closest('[data-pbuy],[data-popen],[data-phide]');
        if (pb) {
          const d = pb.dataset;
          if (d.pbuy) buy(st.qb, d.pbuy, (intelFacts(d.pbuy) || { p: {} }).p.symbol || '');
          if (d.popen) openCoin(d.popen);
          if (d.phide) { hideCoin(d.phide); scanCards(); }
          if (peekEl) peekEl.style.display = 'none';
          return;
        }
        const b = e.target.closest('.qb');
        if (!b) return;
        const card = b.closest(site.cardRow);
        const alt = card && [...card.querySelectorAll('img[alt]')].map((i) => i.alt.trim()).filter(Boolean).pop(); // Trojan / Axiom cards: the name is the logo's alt (Axiom: after the launchpad's)
        const symG = env === 'trojan' || env === 'axiom' ? (alt || '').slice(0, 15) : card ? (card.innerText || '').trim().split(/\s+/)[0].slice(0, 15) : '';
        buy(st.qb, b.dataset.qb, symG);
      }, true);
      ['mousedown', 'mouseup', 'pointerdown', 'pointerup'].forEach((t) => window.addEventListener(t, stop, true));
      window.addEventListener('mouseover', (e) => { const p = e.target.closest && e.target.closest('.ip[data-peek]'); if (p) showPeek(p); }, true);
      window.addEventListener('mouseout', (e) => { const p = e.target.closest && e.target.closest('.ip[data-peek]'); if (p) hidePeek(); }, true);
      let tm = null;
      const mine = (n) => n.nodeType === 1 && !!(n.matches('.agtw-c,.agtw-toast,#agtw') || n.closest('.agtw-c,#agtw'));
      new MutationObserver((muts) => {
        if (tm || document.hidden) return;
        // ignore mutations we caused ourselves (badge updates), otherwise every scan re-triggers a scan
        if (muts.every((m) => { const ns = [...m.addedNodes, ...m.removedNodes]; return mine(m.target) || (ns.length && ns.every(mine)); })) return;
        tm = setTimeout(() => { tm = null; scanCards(); }, 400);
      }).observe(document.body, { childList: true, subtree: true });
      let st8 = null;
      window.addEventListener('scroll', () => { clearTimeout(st8); st8 = setTimeout(scanCards, 250); }, true);
      document.addEventListener('visibilitychange', () => { if (!document.hidden) { scanCards(); loadHeld(); } });
      setInterval(() => { if ((st.hiddenCoins || []).length && st.unhideOnSignal) scanCards(); }, 10000); // hidden coins: signal check even on a quiet page
      loadHeld();
    }

    // ---------------------------------------------------------- Trojan bundles (Trojan tabs only)
    // Data: Trojan's own POST /v1/tokens/bundled-positions (top holders of a coin, with funders). The widget reads the
    // answers Trojan's page already gets (fetch / XHR hook), and replays that same request (same headers) for the coin
    // on screen when the page didn't ask, and — one Trojan tab at a time (lease) — for the coins you hold, every 15s.
    // Each answer → clusters (Core.clusterize) → a history point → built-in events (feed, badges) + your rules.
    const TB = env === 'trojan', BP_PATH = '/v1/tokens/bundled-positions', TB_KEEP = 10 * 60e3;
    const bsnap = {}; // mint → { at, rows, cl, sum, hist }
    let bpTpl = null, bpFetch = null, tbBusy = false;
    const tbMe = id();
    const FEED_DEF = [ // built-in detectors for the feed, badges and the "last move" column (not actions)
      { id: 'f-sell', who: 'any', when: 'sell', pct: 20, windowSec: 60 }, { id: 'f-exit', who: 'any', when: 'exit', pct: 90 },
      { id: 'f-acc', who: 'any', when: 'acc', sol: 1, windowSec: 300 }, { id: 'f-send', who: 'any', when: 'send', windowSec: 60 },
      { id: 'f-new', who: 'any', when: 'new', pct: 2 }, { id: 'f-out', who: 'any', when: 'allout', pct: 2 },
    ];
    const FEED_TAG = { sell: ['DUMP', 'dump'], exit: ['EXIT', 'exit'], acc: ['ACCUM', 'acc'], send: ['SPLIT', 'watch'], new: ['NEW', 'watch'], allout: ['ALL OUT', 'acc'], funder: ['FUNDER', 'watch'] };
    const loadFeed = () => (GM_getValue('tbFeed', []) || []).filter((f) => Date.now() - f.at < 6 * 3600e3);
    const shortA = (a) => (a ? a.slice(0, 4) + '…' + a.slice(-4) : '');
    const bundlePx = (mint) => { const mc = mcapNow(mint); return mc > 0 && usdRate > 0 ? mc / usdRate / 1e9 : null; };
    function hdrObj(h) {
      const o = {};
      try { if (!h) return o; if (typeof h.forEach === 'function' && !Array.isArray(h)) h.forEach((v, k) => { o[k] = v; }); else if (Array.isArray(h)) h.forEach(([k, v]) => { o[k] = v; }); else Object.assign(o, h); } catch (_) {}
      return o;
    }
    function bpIngest(url, body, hdr, j, src) {
      let mint = null;
      try { mint = JSON.parse(body).tokenAddress; } catch (_) {}
      if (!mint || !j || !Array.isArray(j.data)) return;
      if (src === 'page') bpTpl = { url: new URL(url, location.href).href, hdr, body, at: Date.now() };
      tbIngest(mint, j.data);
    }
    function tbIngest(mint, rows, now) {
      now = now || Date.now();
      const cl = Core.clusterize(rows, 1e9, bundlePx(mint)), s = bsnap[mint] || (bsnap[mint] = { hist: [] });
      Object.assign(s, { at: now, rows, cl, sum: Core.bundleSummary(cl, rows), hist: Core.pushPoint(s.hist, Core.bundlePoint(cl, now), TB_KEEP) });
      tbFeedScan(mint, s, now);
      tbRules(mint, s, now);
      if (mint === getMint() || st.bund.view === 'rules') render();
      scanCardsSoon();
    }
    let scT = null;
    const scanCardsSoon = () => { if (!scT) scT = setTimeout(() => { scT = null; scanCards(); renderBar(); }, 300); };
    if (TB) {
      const PW = unsafeWindow, of = PW.fetch;
      bpFetch = (u, o) => of.call(PW, u, o);
      PW.fetch = function (input, init) {
        const p = of.apply(this, arguments);
        try {
          const url = typeof input === 'string' ? input : input && input.url;
          if (url && String(url).includes(BP_PATH)) {
            const body = init && typeof init.body === 'string' ? init.body : null, hdr = hdrObj((init && init.headers) || (input && input.headers));
            p.then((r) => r.clone().json()).then((j) => bpIngest(url, body, hdr, j, 'page')).catch(() => {});
          }
        } catch (_) {}
        return p;
      };
      const XP = PW.XMLHttpRequest && PW.XMLHttpRequest.prototype;
      if (XP) {
        const oo = XP.open, os = XP.send, oh = XP.setRequestHeader;
        XP.open = function (m, u) { this.__agtwBp = String(u || '').includes(BP_PATH) ? { u, h: {} } : null; return oo.apply(this, arguments); };
        XP.setRequestHeader = function (k, v) { if (this.__agtwBp) this.__agtwBp.h[k] = v; return oh.apply(this, arguments); };
        XP.send = function (b) {
          const x = this, c = x.__agtwBp;
          if (c) x.addEventListener('load', () => { try { bpIngest(c.u, typeof b === 'string' ? b : null, c.h, JSON.parse(x.responseText), 'page'); } catch (_) {} });
          return os.apply(this, arguments);
        };
      }
    }
    async function bpGet(mint) { // replay Trojan's request for another coin
      if (!bpTpl || !bpFetch) return false;
      let body;
      try { body = JSON.stringify(Object.assign(JSON.parse(bpTpl.body), { tokenAddress: mint })); } catch (_) { return false; }
      try {
        const r = await bpFetch(bpTpl.url, { method: 'POST', headers: bpTpl.hdr, body, credentials: 'include' });
        if (!r.ok) return false;
        bpIngest(bpTpl.url, body, bpTpl.hdr, await r.json(), 'poll');
        return true;
      } catch (_) { return false; }
    }
    function tbLeader() {
      const l = GM_getValue('tbLead', null), now = Date.now();
      if (!l || now - l.at > 9000 || l.id === tbMe) { GM_setValue('tbLead', { id: tbMe, at: now }); return true; }
      return false;
    }
    async function tbTick() {
      if (!TB || tbBusy) return;
      tbBusy = true;
      try {
        const cur = getMint(), now = Date.now();
        // the coin on screen: Trojan normally asks itself; if it hasn't for 8s, ask for it
        if (cur && !document.hidden && (!bsnap[cur] || now - bsnap[cur].at > 8000)) await bpGet(cur);
        if (!st.bund.bg || !tbLeader()) return;
        for (const m of Object.keys(heldAll).filter((x) => x !== cur && !pendingGone[x]).slice(0, 8)) {
          if (bsnap[m] && Date.now() - bsnap[m].at < 12000) continue;
          await bpGet(m);
          await sleep(500);
        }
      } finally { tbBusy = false; }
    }
    // ---- feed (shared by every tab)
    const feedSeen = {};
    function tbFeedScan(mint, s, now) {
      const sym0 = (heldAll[mint] || {}).sym || (mint === getMint() ? sym : '') || shortA(mint);
      const add = [];
      for (const d of FEED_DEF.concat(st.bund.watch.length ? [{ id: 'f-fund', who: 'funder', when: 'funder' }] : [])) {
        for (const m of Core.bundleMatches(d, s.hist, s.cl, now, st.bund.watch)) {
          const key = `${mint}:${m.id}:${m.kind}`;
          if (now - (feedSeen[key] || 0) < (m.kind === 'funder' ? 30 * 60e3 : 180e3)) continue;
          feedSeen[key] = now;
          add.push({ at: now, mint, sym: sym0, id: m.id, kind: m.kind, text: m.text, pct: m.pct });
        }
      }
      if (!add.length) return;
      const f = loadFeed();
      for (const a of add) if (!f.some((x) => x.mint === a.mint && x.id === a.id && x.kind === a.kind && a.at - x.at < 180e3)) f.push(a);
      GM_setValue('tbFeed', f.slice(-40));
    }
    const lastMove = (mint, cid) => loadFeed().filter((f) => f.mint === mint && f.id === cid && Date.now() - f.at < 15 * 60e3).pop();
    const coinMove = (mint) => loadFeed().filter((f) => f.mint === mint && Date.now() - f.at < 5 * 60e3 && (f.kind === 'sell' || f.kind === 'exit' || f.kind === 'allout')).pop();
    // ---- rules: { id, on, who, minPct, funder, when, pct, sol, windowSec, scope, then, sellPct, buySol, mode, cooldownMin, once, fired, lastAt }
    const RULE_DEF = () => ({ who: 'any', minPct: 5, funder: '', when: 'sell', pct: 30, sol: 1, windowSec: 60, scope: 'held', then: 'sell', sellPct: 100, buySol: 0.1, cooldownMin: 5, once: true });
    function tbClaim(key, coolMs) { // cross-tab: one firing per key per cooldown
      const f = GM_getValue('tbFired', {}) || {}, now = Date.now();
      if (f[key] && now - f[key].at < coolMs) return false;
      f[key] = { at: now, by: tbMe };
      for (const k of Object.keys(f)) if (now - f[k].at > 86400e3) delete f[k];
      GM_setValue('tbFired', f);
      return true;
    }
    function tbRules(mint, s, now) {
      for (const r of st.bund.rules) {
        if (!r.on) continue;
        if (r.scope === 'this' && mint !== getMint()) continue;
        if (r.scope === 'held' && (!heldAll[mint] || pendingGone[mint])) continue;
        const ms = Core.bundleMatches(r, s.hist, s.cl, now, st.bund.watch);
        if (!ms.length) continue;
        const m = ms[0], key = r.once ? `${r.id}:${mint}` : `${r.id}:${mint}:${m.id}`;
        if (!tbClaim(key, r.once ? 86400e3 : Math.max(1, Number(r.cooldownMin) || 5) * 60e3)) continue;
        tbAct(r, mint, m).catch((e) => console.warn('[AG widget] bundle rule', e));
      }
    }
    async function tbAct(r, mint, m) {
      const name = (heldAll[mint] || {}).sym || (mint === getMint() ? sym : '') || shortA(mint);
      let did = '', ok = true;
      if (r.then === 'sell' || r.then === 'init') {
        if (!heldAll[mint]) { did = 'no position: nothing to sell'; ok = false; }
        else if (r.mode !== st.mode) { did = `rule is ${r.mode.toUpperCase()}, widget is ${st.mode.toUpperCase()}: skipped`; ok = false; }
        else if (r.then === 'sell') { const x = await execSell({ mint, symb: name, pct: Number(r.sellPct) || 100, mode: r.mode, interactive: false, label: 'bundle rule' }); ok = x.ok > 0; did = ok ? `sold ${r.sellPct}% on ${x.ok} wallet(s)` : `sell failed${x.err ? ': ' + x.err : ''}`; }
        else { await sellInit(mint, true); did = 'sold initials'; }
      } else if (r.then === 'buy') {
        const ws = r.mode === 'live' ? (st.wallets.live || []).slice() : [null];
        const x = await execBuy({ mint, symb: name, wallets: ws, amount: Number(r.buySol) || 0.1, split: st.buyMode === 'split', mode: r.mode, interactive: false, note: 'bundle rule', jitter: st.jitter });
        ok = x.ok > 0; did = ok ? `bought ◎ ${sol(x.total)} (${r.mode})` : `buy skipped: ${x.err || 'failed'}`;
      } else if (r.then === 'hide') { hideCoin(mint); scanCards(); did = 'coin hidden from lists'; }
      r.fired = (r.fired || 0) + 1; r.lastAt = Date.now(); save();
      pushAlert({ kind: 'bundle', key: `b:${r.id}:${mint}:${Math.round(Date.now() / 1000)}`, mint, sym: name,
        title: `${FEED_TAG[m.kind] ? FEED_TAG[m.kind][0] : 'BUNDLE'} · ${name} · ${m.text}`, body: r.then === 'alert' ? Core.ruleText(r) : `Rule: ${did}`, ok });
    }
    function armRule(dr) {
      const r = Object.assign(RULE_DEF(), dr, { id: id(), on: true, mode: dr.then === 'buy' && !dr.mode ? 'paper' : dr.mode || st.mode, fired: 0, created: Date.now() });
      if (r.who === 'funder' && !r.funder && !st.bund.watch.length) return toast('Watch a funder first (open a bundle → Watch funder)', true);
      return (async () => {
        if (r.mode === 'live' && (r.then === 'sell' || r.then === 'buy' || r.then === 'init') && !(await ask({ tone: 'live', title: 'Arm LIVE bundle rule', sub: Core.ruleText(r),
          note: 'Runs in your Trojan tab(s) with your AG wallets. Safety rails apply.', actions: [{ label: 'Cancel', v: null, kind: 'ghost' }, { label: 'Arm LIVE', v: 'go', kind: 'danger' }] }))) return;
        st.bund.rules.push(r); save(); toast('Bundle rule armed'); render();
      })();
    }

    // ---- views
    function moveOf(mint, c) {
      const f = lastMove(mint, c.id);
      if (f) { const t = FEED_TAG[f.kind] || ['MOVE', 'hold']; return [f.kind === 'sell' ? `SOLD ${Math.round(f.pct || 0)}%` : t[0], t[1]]; }
      if (c.left <= 0.1) return ['EXITED', 'exit'];
      if (c.left < 0.98) return [`SOLD ${Math.round((1 - c.left) * 100)}%`, 'dump'];
      return ['HOLDING', 'hold'];
    }
    const CL_COL = ['#F59AA6', '#D2C5FF', '#FFE08A', '#8FE6B4', '#7CB7FF', '#C9CDD4', '#F2B84B', '#86E1E8'];
    function bundListHtml(mint, s) {
      const S = s.sum, h = heldAll[mint], lv = { high: ['bad', 'high'], mid: ['mid', 'medium'], low: ['ok', 'low'] }[S.level];
      const top = s.cl.find((c) => !c.hot), tm = top && lastMove(mint, top.id);
      const rows = s.cl.filter((c) => !c.hot).slice(0, 12);
      return `<div class="bhero ${lv[0]}"><div class="bring n">${S.risk}</div><div class="ih"><b>Bundle risk · ${lv[1]}</b>
          <span>${S.clusters} bundle${S.clusters === 1 ? '' : 's'} still hold <b class="n">${S.held.toFixed(1)}%</b> of supply</span>
          <span class="mut sm">${tm ? escH(tm.text) + ' · ' + agoS(Date.now() - tm.at) + ' ago' : `peak ${S.peak.toFixed(1)}%`}</span></div></div>
        <div class="g4b">${[['BUNDLES', S.clusters, `${S.wallets} wallets`], ['STILL HOLD', S.held.toFixed(1) + '%', `peak ${S.peak.toFixed(1)}%`, S.held >= 15 ? 'dn' : ''],
          ['SNIPERS', S.snipers, `${S.snipersOut} exited`], ['DEV-LINKED', S.dev, 'got dev tokens', S.dev ? 'y' : '']].map(([k, v, u, c]) => `<div class="itile"><span>${k}</span><b class="n ${c || ''}">${v}</b><small>${u}</small></div>`).join('')}</div>
        <div class="bsup"><div class="pl n"><span>SUPPLY HELD BY BUNDLES</span><span>${S.held.toFixed(1)}%</span></div>
          <div class="bbar">${rows.map((c, i) => `<i style="width:${Math.min(100, c.pct).toFixed(2)}%;background:${CL_COL[i % CL_COL.length]}"></i>`).join('')}</div></div>
        ${rows.length ? `<div class="bth"><span class="sp">BUNDLE (FUNDER)</span><span class="bc1">HOLDS</span><span class="bc2">LAST MOVE</span><span class="bc3">PNL ◎</span></div>
        <div class="blist">${rows.map((c, i) => { const [mv, k] = moveOf(mint, c); return `<button class="brow" data-bsel="${c.id}" title="Open this bundle">
          <span class="bdot" style="background:${CL_COL[i % CL_COL.length]}"></span><span class="bn2"><span><b class="n">${shortA(c.id)}</b> <span class="bwn n">${c.n} wallets</span></span>
          <span class="mut sm">${escH([c.bundled ? 'bundled' : '', c.sniper ? 'snipers' : '', c.dev ? 'dev-linked' : '', c.sameAmt ? `same funding ${c.fundAmt} ◎` : ''].filter(Boolean).join(' · ') || 'same funder')}</span></span>
          <span class="bc1 n">${c.pct.toFixed(1)}%</span><span class="bc2"><span class="mvp ${k}">${escH(mv)}</span></span><span class="bc3 n ${c.pnl >= 0 ? 'up' : 'dn'}">${c.pnl >= 0 ? '+' : '−'}${sol(Math.abs(c.pnl))}</span>
          <span class="bleft"><i style="width:${(c.left * 100).toFixed(0)}%;background:${CL_COL[i % CL_COL.length]}"></i></span></button>`; }).join('')}</div>` : '<div class="mut sm">No bundle among the top holders (no 2+ wallets with the same funder).</div>'}
        ${h ? `<div class="iyou"><span class="lb">YOU</span><b class="n ${h.pnl >= 0 ? 'up' : 'dn'}">◎ ${sol(h.worth)} · ${h.pnl >= 0 ? '+' : '−'}${sol(Math.abs(h.pnl))}</b><span class="sp"></span>${st.bund.rules.some((r) => r.on && r.then === 'sell' && r.scope !== 'any') ? '<span class="ptag">armed: sell if they dump</span>' : ''}</div>` : ''}
        <div class="g3 iact"><button class="btn" data-bq="dump" title="Rule: any bundle sells ≥ 30% within 60s on a coin I hold → sell 100%">Sell if they dump</button><button class="btn" data-bq="alert" title="Rule: any bundle sells ≥ 20% within 60s on a coin I hold → alert">Alert on moves</button><button class="btn" data-a="bview">Rules ›</button></div>`;
    }
    const tsMs = (t) => (t > 0 ? (t < 1e12 ? t * 1000 : t) : null);
    function bundClusterHtml(mint, s, c) {
      const i = s.cl.indexOf(c), col = CL_COL[i % CL_COL.length], [mv, k] = moveOf(mint, c), watched = st.bund.watch.includes(c.id);
      const evs = loadFeed().filter((f) => f.mint === mint && f.id === c.id).map((f) => ({ t: f.at, kind: (FEED_TAG[f.kind] || ['MOVE'])[0], text: f.text }));
      for (const w of c.wallets) {
        if (tsMs(w.lastSell)) evs.push({ t: tsMs(w.lastSell), kind: 'SELL', text: `${shortA(w.addr)} last sell · has sold ${kfmt(w.sold)}` });
        if (tsMs(w.lastBuy)) evs.push({ t: tsMs(w.lastBuy), kind: 'BUY', text: `${shortA(w.addr)} last buy · ◎ ${sol(w.spent)} in` });
      }
      evs.sort((a, b) => b.t - a.t);
      return `<div class="sh"><button class="lk" data-bsel="">‹ Bundles</button><span class="bdot" style="background:${col}"></span><b class="n">${shortA(c.id)}</b><span class="bwn n">${c.n} wallets</span><span class="sp"></span><span class="mvp ${k}">${escH(mv)}</span></div>
        <div class="g3s three"><div class="sb"><span class="lb">BOUGHT</span><span class="n v up">◎ ${sol(c.spent)}</span><span class="n u">${kfmt(c.inflow)} tokens</span></div>
          <div class="sb"><span class="lb">SOLD</span><span class="n v dn">◎ ${sol(c.earned)}</span><span class="n u">${c.sells} sells</span></div>
          <div class="sb"><span class="lb">PNL</span><span class="n v ${c.pnl >= 0 ? 'up' : 'dn'}">${c.pnl >= 0 ? '+' : '−'}${sol(Math.abs(c.pnl))} ◎</span><span class="n u">${c.value != null ? 'incl. ◎ ' + sol(c.value) + ' held' : 'realized'}</span></div></div>
        <div class="bsup"><div class="pl n"><span>HOLDS ${c.pct.toFixed(1)}% OF SUPPLY</span><span>${(c.left * 100).toFixed(0)}% of its bag left</span></div><div class="bbar"><i style="width:${(c.left * 100).toFixed(0)}%;background:${col}"></i></div></div>
        <span class="lb">FUNDING</span>
        <div class="bfund"><div class="bfn"><b class="n">${shortA(c.id)}</b><span class="sm">funder${c.fundAmt ? ` · sent ${c.fundAmt} ◎ each` : ''}</span></div><i class="bln"></i>
          <div class="bws">${c.wallets.slice(0, 8).map((w) => `<div class="bw"><span class="n">${shortA(w.addr)}</span><span class="sp"></span><span class="n ${w.bal > 0 ? '' : 'mut'}">${c.bal > 0 ? ((w.bal / c.bal) * 100).toFixed(0) + '%' : 'out'}</span></div>`).join('')}${c.wallets.length > 8 ? `<span class="mut sm">+${c.wallets.length - 8} more</span>` : ''}</div></div>
        <div class="chips">${[c.bundled && ['bundled at launch', 'dn'], c.sameAmt && [`same funding amount (${c.fundAmt} ◎)`, 'dn'], c.sniper && ['snipers', 'y'], c.dev && ['got tokens from the dev / insiders', 'y'], watched && ['watched funder', 'vi']].filter(Boolean).map(([t, cc]) => `<span class="bchip ${cc}">${escH(t)}</span>`).join('')}</div>
        <span class="lb">WHAT IT DID</span>
        <div class="btl">${evs.slice(0, 8).map((e) => `<div class="bev"><span class="n mut">${agoS(Date.now() - e.t)}</span><span class="mvp ${e.kind === 'BUY' || e.kind === 'ACCUM' ? 'acc' : e.kind === 'SELL' || e.kind === 'DUMP' ? 'dump' : 'watch'}">${escH(e.kind)}</span><span>${escH(e.text)}</span></div>`).join('') || '<span class="mut sm">Nothing yet.</span>'}</div>
        <div class="g2"><button class="btn danger" data-bsell="${mint}" ${heldAll[mint] ? '' : 'disabled'}>Sell my bag · 100%</button><button class="btn" data-brule="${c.id}">⚡ Rule for this bundle</button>
          <button class="btn" data-bwatch="${c.id}">${watched ? 'Unwatch funder' : 'Watch funder everywhere'}</button><button class="btn" data-cp="${c.id}">Copy funder</button></div>`;
    }
    function bundRulesHtml(mint) {
      const d = ui.bdraft || (ui.bdraft = RULE_DEF()), opt = (k, list) => `<select data-bf="${k}" aria-label="${k}">${list.map(([v, l]) => `<option value="${v}" ${String(d[k]) === String(v) ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
      const n = (k, label, step) => `<label>${label}<input class="n" type="number" step="${step || 'any'}" data-bf="${k}" value="${escH(d[k])}"></label>`;
      const needs = { sell: ['pct', 'windowSec'], exit: ['pct'], acc: ['sol', 'windowSec'], send: ['windowSec'], new: ['pct'], allout: ['pct'], funder: [] }[d.when] || [];
      const preview = Object.assign({}, d, { mode: d.then === 'buy' ? (d.mode || 'paper') : st.mode });
      const feed = loadFeed().slice(-8).reverse();
      return `<div class="sh"><button class="lk" data-a="bview">‹ Bundles</button><b>Rules</b><span class="sp"></span><span class="mut sm">run in this Trojan tab</span></div>
        <div class="bform"><div class="eg two"><label>When${opt('who', [['any', 'any bundle'], ['top3', 'a top-3 bundle'], ['min', 'a bundle holding ≥ X%'], ['dev', 'a dev-linked bundle'], ['snipers', 'a sniper bundle'], ['funder', 'a watched funder']])}</label>
          <label>does${opt('when', [['sell', 'sells part of its bag'], ['exit', 'is out (sold most of it)'], ['acc', 'accumulates (buys more)'], ['send', 'sends tokens to wallets'], ['new', 'appears (new bundle)'], ['allout', 'ALL bundles are out'], ['funder', 'shows up on a coin']])}</label></div>
          <div class="eg">${d.who === 'min' ? n('minPct', 'holding ≥ %', 0.5) : ''}${needs.includes('pct') ? n('pct', d.when === 'sell' ? 'sold ≥ % of bag' : d.when === 'exit' ? 'sold ≥ % overall' : d.when === 'allout' ? 'all hold ≤ % supply' : 'holds ≥ %', 1) : ''}${needs.includes('sol') ? n('sol', 'bought ≥ ◎', 0.1) : ''}${needs.includes('windowSec') ? n('windowSec', 'within (s)', 5) : ''}</div>
          <div class="eg two"><label>On${opt('scope', [['this', 'this coin'], ['held', 'coins I hold'], ['any', 'any coin I open']])}</label>
          <label>Then${opt('then', [['alert', 'alert me'], ['sell', 'sell X% of my bag'], ['init', 'sell my initials'], ['hide', 'hide the coin'], ['buy', 'buy ◎ (reverse)']])}</label></div>
          <div class="eg">${d.then === 'sell' ? n('sellPct', 'sell %', 5) : ''}${d.then === 'buy' ? n('buySol', 'buy ◎', 0.05) + `<label>Mode${opt('mode', [['paper', 'paper'], ['live', 'LIVE']])}</label>` : ''}${n('cooldownMin', 'cooldown (min)', 1)}<label class="ck"><input type="checkbox" data-bf="once" ${d.once ? 'checked' : ''}>once per coin</label></div>
          <div class="bsent">${escH(Core.ruleText(preview))}${d.when === 'sell' && d.scope === 'any' && d.then === 'sell' ? ' <span class="mut">(only where you hold it)</span>' : ''}</div>
          <button class="btn arm ${d.then === 'sell' || d.then === 'init' ? 'sellc' : ''}" data-a="barm">Arm rule${(d.then === 'buy' ? preview.mode : st.mode) === 'live' && d.then !== 'alert' && d.then !== 'hide' ? ' · LIVE' : ''}</button></div>
        <div class="sh"><b class="sm2">Armed</b><span class="sp"></span><span class="mut sm">${st.bund.rules.length} rule${st.bund.rules.length === 1 ? '' : 's'}</span></div>
        ${st.bund.rules.map((r) => `<div class="trw"><div class="orr"><span class="otag ${r.then === 'sell' || r.then === 'init' ? 'tpmc' : r.then === 'buy' ? 'dip' : 'trail'}">${{ sell: 'SELL', init: 'INIT', buy: 'BUY', hide: 'HIDE', alert: 'ALERT' }[r.then]}</span><span class="ol" title="${escH(Core.ruleText(r))}">${escH(Core.ruleText(r))}</span><span class="sp"></span>
          <label class="ck" title="On / off"><input type="checkbox" data-btog="${r.id}" ${r.on ? 'checked' : ''}></label><button class="xx" data-bdel="${r.id}" aria-label="Delete rule">×</button></div>
          <div class="pl n"><span>${r.mode.toUpperCase()} · fired ${r.fired || 0}×${r.lastAt ? ' · last ' + agoS(Date.now() - r.lastAt) + ' ago' : ''}</span><span>${r.once ? 'once per coin' : 'cooldown ' + r.cooldownMin + ' min'}</span></div></div>`).join('') || '<div class="mut sm">No rule yet.</div>'}
        <div class="sh"><b class="sm2">Feed</b><span class="sp"></span><span class="mut sm">${st.bund.bg ? (bpTpl ? 'watching coins you hold' : 'open any coin once to watch the coins you hold') : 'background watch off'}</span></div>
        ${feed.map((f) => `<div class="bev"><span class="n mut">${agoS(Date.now() - f.at)}</span><span class="mvp ${(FEED_TAG[f.kind] || ['', 'watch'])[1]}">${(FEED_TAG[f.kind] || ['MOVE'])[0]}</span><button class="lk2" data-open="${f.mint}">${escH(f.sym || shortA(f.mint))}</button><span>${escH(f.text)}</span></div>`).join('') || '<span class="mut sm">No bundle move seen yet.</span>'}
        <label class="ck"><input type="checkbox" data-s="bund.bg" ${st.bund.bg ? 'checked' : ''}>Also watch the coins I hold in the background (every 15s, one Trojan tab)</label>`;
    }
    function bundHtml() {
      if (!TB || ui.edit) return '';
      const mint = getMint(), s = mint && bsnap[mint], B = st.bund, on = B.rules.filter((r) => r.on).length;
      if (!B.open) return `<button class="intel tab bund" data-a="bund" title="Show bundles"><span class="agt v">BUNDLES</span>${s ? `<b class="n">${s.sum.held.toFixed(0)}%</b><i class="dot" style="background:${s.sum.level === 'high' ? '#F59AA6' : s.sum.level === 'mid' ? '#FFE08A' : '#8FE6B4'}"></i>` : ''}</button>`;
      const c = s && ui.bundSel ? s.cl.find((x) => x.id === ui.bundSel) : null;
      const body = B.view === 'rules' ? bundRulesHtml(mint)
        : !mint ? `<div class="mut sm">Open a coin: bundles come from Trojan's holders list.</div>${loadFeed().length ? '<button class="btn" data-a="bview">Rules & feed ›</button>' : ''}`
        : !s ? `<div class="mut sm">Waiting for Trojan's holders data…${bpTpl ? '' : ' If nothing comes, open the Holders tab of this coin once.'}</div>`
        : c ? bundClusterHtml(mint, s, c) : bundListHtml(mint, s);
      return `<div class="intel bund"><div class="ii"><div class="sh ihd"><span class="agt">BUNDLES</span><b>${escH(mint ? sym || tail(mint) : '')}</b><span class="sp"></span>${s ? `<span class="lvd"></span><span class="mut n sm">${agoS(Date.now() - s.at)}</span>` : ''}
        <button class="ib ord ${on ? 'has' : ''} ${B.view === 'rules' ? 'on' : ''}" data-a="bview" title="Bundle rules">${ICON.bolt}<span class="n">${on || ''}</span></button><button class="ib" data-a="bund" title="Collapse">${ICON.chev}</button></div>${body}</div></div>`;
    }
    function tbBadge(mint) { // holdings bar / cards: a bundle just dumped on this coin
      if (!TB) return '';
      const f = coinMove(mint);
      return f ? `<span class="tbd" title="${escH(f.text)}">BUNDLE ${f.kind === 'sell' ? '−' + Math.round(f.pct || 0) + '%' : f.kind === 'allout' ? 'OUT' : 'EXIT'}</span>` : '';
    }
    function tbCardChip(mint) {
      const s = TB && bsnap[mint];
      if (!s || Date.now() - s.at > 10 * 60e3 || !s.sum.clusters) return '';
      return `<span class="tbc ${s.sum.level}" title="${s.sum.clusters} bundles hold ${s.sum.held.toFixed(1)}% · risk ${s.sum.risk}">BUNDLES ${s.sum.held.toFixed(0)}%</span>`;
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
    const wideOn = () => (Number(st.w) || 380) >= 600;
    function setW(w) { st.w = Math.round(Math.min(1000, Math.max(340, w))); if (el) { el.style.setProperty('--w', String(st.w)); el.classList.toggle('wide', !ui.collapsed && !ui.edit && wideOn()); } }
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

    // ---------------------------------------------------------- holdings bar (top of the page, GMGN style)
    // One chip per open position in the current mode: coin · PnL ◎ (%) · ⚡ 100% sell. Click the coin to open it.
    // The sell button arms on the first click and sells on the second (within 2.5s) unless "one-click" is on.
    let barEl = null, barArm = { mint: null, at: 0 }, barShowHidden = false;
    const BAR_CSS = `
      #agtwBar{position:fixed;top:6px;left:50%;transform:translateX(-50%);z-index:100000;max-width:min(62vw,900px);display:flex;align-items:center;gap:6px;box-sizing:border-box;
        background:#17191Ef2;border:1px solid #2C3038;border-radius:10px;padding:3px 10px 3px 2px;box-shadow:0 8px 24px #0009;font:500 12px/1 'IBM Plex Sans',Inter,system-ui,sans-serif;color:#E6E8EC}
      #agtwBar.free{transform:none;max-width:none;align-items:flex-start}
      #agtwBar .bg{align-self:stretch;width:10px;flex:none;cursor:move;border-radius:4px;background:radial-gradient(circle,#4B5160 1px,transparent 1.5px) 0 0/5px 5px;opacity:.7}
      #agtwBar .bg:hover{opacity:1;background-color:#24272E}
      #agtwBar .brz{position:absolute;right:0;bottom:0;width:12px;height:12px;cursor:nwse-resize;opacity:.5;border-radius:0 0 9px 0;
        background:linear-gradient(135deg,transparent 0 55%,#8B919C 55% 62%,transparent 62% 72%,#8B919C 72% 79%,transparent 79%)}
      #agtwBar .brz:hover{opacity:1}
      #agtwBar.wrap .bs{flex-wrap:wrap;overflow-x:hidden;overflow-y:auto;scrollbar-width:thin;align-content:flex-start}
      #agtwBar .bv{font-family:'IBM Plex Mono',ui-monospace,Menlo,monospace;font-size:11px;color:#8B919C;white-space:nowrap}
      #agtwBar .bh{background:none;border:0;color:#6E7480;cursor:pointer;font:600 12px/1 system-ui,sans-serif;padding:2px 3px;border-radius:5px}
      #agtwBar .bh:hover{color:#E6E8EC;background:#2C3038}
      #agtwBar .bc.pend{border-style:dashed;opacity:.75}#agtwBar .bc.hid{opacity:.45}
      #agtwBar .bmore{background:none;border:1px dashed #3A3F48;color:#8B919C;border-radius:7px;padding:3px 7px;font:600 10.5px/1 Inter,system-ui,sans-serif;cursor:pointer;flex:none;white-space:nowrap}
      #agtwBar .bsum{cursor:pointer}
      #agtwBar .bt{font-size:9.5px;font-weight:700;letter-spacing:.08em;color:#15180F;background:#B8F04A;border-radius:4px;padding:2px 5px;cursor:pointer;flex:none;border:0}
      #agtwBar .bt.paper{background:#3B82F6;color:#fff}
      #agtwBar .bs{display:flex;gap:6px;overflow-x:auto;scrollbar-width:none;min-width:0}
      #agtwBar .bc{display:flex;align-items:center;gap:6px;background:#1F2228;border:1px solid #2C3038;border-radius:8px;padding:2px 3px 2px 4px;flex:none}
      #agtwBar .bc.cur{border-color:#4E6420}
      #agtwBar .bn{display:flex;align-items:center;gap:6px;background:none;border:0;color:inherit;font:inherit;cursor:pointer;padding:0}
      #agtwBar .bi{width:20px;height:20px;border-radius:20px;background:#2C3038;display:flex;align-items:center;justify-content:center;font-size:8.5px;font-weight:700;color:#C9CDD4;flex:none}
      #agtwBar .bsym{font-weight:600;max-width:84px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      #agtwBar .bp{font-family:'IBM Plex Mono',ui-monospace,Menlo,monospace;font-variant-numeric:tabular-nums;white-space:nowrap}
      #agtwBar .up{color:#8FE6B4}#agtwBar .dn{color:#F59AA6}
      #agtwBar .bx{background:#D9536A;border:0;color:#fff;border-radius:6px;padding:4px 7px;font:700 11.5px/1 Inter,system-ui,sans-serif;cursor:pointer;white-space:nowrap}
      #agtwBar .bx:hover{background:#E0677C}
      #agtwBar .bx.arm{background:#F2B84B;color:#2A1D05}
      #agtwBar .bx:disabled{opacity:.5;cursor:default}
      #agtwBar .bsum{font-family:'IBM Plex Mono',ui-monospace,Menlo,monospace;font-size:11px;color:#8B919C;padding:0 4px;white-space:nowrap;flex:none}
      #agtwBar .bsum.up{color:#8FE6B4}#agtwBar .bsum.dn{color:#F59AA6}`;
    const BAR_SORT = { value: (a, b) => b.worth - a.worth, pnl: (a, b) => b.pnl - a.pnl, pct: (a, b) => b.pct - a.pct };
    function barHtml() {
      const all = Object.entries(heldAll).filter(([mint]) => !pendingGone[mint]).map(([mint, h]) => {
        const live = mint === getMint() && pos, lp = live ? livePos() : null;
        const worth = live ? Object.values(lp).reduce((a, x) => a + (num(x.worthSol) || 0), 0) : h.worth;
        const pnl = live ? Object.values(lp).reduce((a, x) => a + (num(x.pnlSol) || 0), 0) : h.pnl;
        const cost = worth - pnl, mc = mcapNow(mint);
        return { mint, sym: h.sym || tail(mint), pnl, pct: cost > 0 ? (pnl / cost) * 100 : 0, worth, n: h.n, entry: h.entry, mc };
      }).sort(BAR_SORT[st.barSort] || BAR_SORT.value);
      const hidN = all.filter((r) => st.barHide[r.mint]).length;
      const rows = all.filter((r) => barShowHidden || !st.barHide[r.mint]);
      const pend = Object.entries(pendingBuy).filter(([m, p]) => !heldAll[m] && p.mode === st.mode && Date.now() < p.until);
      if (!all.length && !pend.length) return '';
      const tot = all.reduce((a, r) => a + r.pnl, 0), val = all.reduce((a, r) => a + r.worth, 0), armed = barArm.mint && Date.now() - barArm.at < 2500 ? barArm.mint : null;
      const tip = (r) => `${r.sym} · ◎ ${sol(r.worth)} held in ${r.n} wallet${r.n > 1 ? 's' : ''}${r.entry ? ` · entry $${kfmt(r.entry)}` : ''}${r.mc ? ` · now $${kfmt(r.mc)}${r.entry ? ` (${(r.mc / r.entry).toFixed(2)}×)` : ''}` : ''} · click to open`;
      return `<span class="bg" data-bar="drag" title="Drag to move · double-click to put it back at the top"></span>
        <button class="bt ${st.mode}" data-bar="toggle" title="AG positions (${st.mode}) · click to hide the bar (B)">${st.mode === 'live' ? 'AG' : 'PAPER'}</button>
        <div class="bs">${pend.map(([m, p]) => `<div class="bc pend" title="Buy sent · waiting for AG to list the position"><button class="bn" data-bar="open" data-m="${m}"><span class="bsym">${escH(p.sym || tail(m))}</span><span class="bv">◎ ${sol(p.sol)} · pending…</span></button></div>`).join('')}
        ${rows.map((r) => `<div class="bc ${r.mint === getMint() ? 'cur' : ''} ${st.barHide[r.mint] ? 'hid' : ''}"><button class="bn" data-bar="open" data-m="${r.mint}" title="${escH(tip(r))}">
          <span class="bi">${escH(r.sym.replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase() || '?')}</span><span class="bsym">${escH(r.sym)}</span>
          <span class="bv">◎ ${sol(r.worth)}</span>
          ${tbBadge(r.mint)}<span class="bp ${r.pnl >= 0 ? 'up' : 'dn'}">◎ ${r.pnl >= 0 ? '+' : '−'}${sol(Math.abs(r.pnl))} (${r.pct >= 0 ? '+' : ''}${r.pct.toFixed(1)}%)</span></button>
          <button class="bx ${armed === r.mint ? 'arm' : ''}" data-bar="sell" data-m="${r.mint}" title="${st.barOneClick ? 'Sell 100% from every wallet holding it' : 'Click twice to sell 100% from every wallet holding it'}" ${ui.busy ? 'disabled' : ''}>${armed === r.mint ? 'Sure? 100%' : '⚡ 100%'}</button>
          <button class="bh" data-bar="${st.barHide[r.mint] ? 'unhide' : 'hide'}" data-m="${r.mint}" title="${st.barHide[r.mint] ? 'Show it in the bar again' : 'Hide this position from the bar (it comes back if you buy it again after closing it)'}">${st.barHide[r.mint] ? '↺' : '×'}</button></div>`).join('')}
        ${hidN ? `<button class="bmore" data-bar="showhid" title="${barShowHidden ? 'Hide them again' : 'Show the positions you hid'}">${barShowHidden ? 'done' : '+' + hidN + ' hidden'}</button>` : ''}</div>
        ${all.length ? `<span class="bsum ${tot >= 0 ? 'up' : 'dn'}" data-bar="sort" title="${all.length} position${all.length > 1 ? 's' : ''} · ◎ ${sol(val)} held · unrealized PnL. Click to sort by ${{ value: 'PnL', pnl: '%', pct: 'value' }[st.barSort]} (now: ${st.barSort})">Σ ${tot >= 0 ? '+' : '−'}${sol(Math.abs(tot))}</span>` : ''}
        <span class="brz" data-bar="resize" title="Drag to resize (taller = several rows) · double-click to reset"></span>`;
    }
    // position / size: st.barBox {x, y, w, h}; kept on screen
    function placeBar() {
      if (!barEl) return;
      const b = st.barBox;
      barEl.classList.toggle('free', !!b);
      barEl.classList.toggle('wrap', !!(b && b.h > 40));
      if (!b) { Object.assign(barEl.style, { left: '', top: '', width: '', height: '' }); return; }
      const vw = window.innerWidth, vh = window.innerHeight, w = Math.max(200, Math.min(vw - 8, b.w || 600)), h = b.h ? Math.max(30, Math.min(vh - 8, b.h)) : null;
      const x = Math.max(4 - w + 80, Math.min(vw - 80, b.x)), y = Math.max(0, Math.min(vh - 30, b.y));
      Object.assign(barEl.style, { left: x + 'px', top: y + 'px', width: w + 'px', height: h ? h + 'px' : '' });
      const bs = barEl.querySelector('.bs');
      if (bs) bs.style.maxHeight = h ? h - 8 + 'px' : '';
    }
    function barDrag(e, kind) {
      e.preventDefault();
      const r = barEl.getBoundingClientRect(), sx = e.clientX, sy = e.clientY;
      const b0 = st.barBox || { x: r.left, y: r.top, w: r.width, h: 0 };
      const mv = (ev) => {
        const dx = ev.clientX - sx, dy = ev.clientY - sy;
        st.barBox = kind === 'drag' ? { ...b0, x: b0.x + dx, y: b0.y + dy } : { ...b0, w: Math.max(200, (b0.w || r.width) + dx), h: Math.max(0, (b0.h || r.height) + dy) };
        if (st.barBox.h && st.barBox.h < r.height + 12 && kind === 'resize') st.barBox.h = 0; // barely taller: stay one row
        placeBar();
      };
      const up = () => { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); save(); };
      document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
    }
    function renderBar() {
      if (env === 'ag' && !st.barOnAg) { if (barEl) barEl.style.display = 'none'; return; }
      if (!st.bar || st.barHidden) { if (barEl) barEl.style.display = 'none'; return; }
      if (!barEl) {
        const s = document.createElement('style'); s.textContent = BAR_CSS; document.head.appendChild(s);
        barEl = document.createElement('div'); barEl.id = 'agtwBar'; document.body.appendChild(barEl);
        barEl.addEventListener('click', onBarClick);
        ['mousedown', 'pointerdown'].forEach((t) => barEl.addEventListener(t, (e) => e.stopPropagation()));
        barEl.addEventListener('mousedown', (e) => { const h = e.target.closest('[data-bar="drag"],[data-bar="resize"]'); if (h) barDrag(e, h.dataset.bar); });
        barEl.addEventListener('dblclick', (e) => { if (e.target.closest('[data-bar="drag"],[data-bar="resize"]')) { st.barBox = null; save(); placeBar(); } });
        window.addEventListener('resize', placeBar);
      }
      const html = barHtml();
      barEl.style.display = html ? 'flex' : 'none';
      if (html !== barEl.__html) { barEl.__html = html; patch(barEl, html); }
      placeBar();
    }
    function onBarClick(e) {
      const b = e.target.closest('[data-bar]');
      if (!b) return;
      e.preventDefault(); e.stopPropagation();
      const d = b.dataset, h = heldAll[d.m] || {};
      if (d.bar === 'toggle') { st.barHidden = true; save(); renderBar(); toast('Holdings bar hidden · bring it back in ⚙ or with B'); return; }
      if (d.bar === 'open') return openCoin(d.m);
      if (d.bar === 'hide' || d.bar === 'unhide') { if (d.bar === 'hide') st.barHide[d.m] = true; else delete st.barHide[d.m]; save(); renderBar(); if (d.bar === 'hide' && !barShowHidden) toast(`${h.sym || tail(d.m)} hidden from the bar · "+ hidden" shows it`); return; }
      if (d.bar === 'showhid') { barShowHidden = !barShowHidden; renderBar(); return; }
      if (d.bar === 'sort') { st.barSort = { value: 'pnl', pnl: 'pct', pct: 'value' }[st.barSort] || 'value'; save(); renderBar(); toast(`Bar sorted by ${{ value: 'value held', pnl: 'PnL ◎', pct: 'PnL %' }[st.barSort]}`); return; }
      if (d.bar === 'sell') {
        if (!st.barOneClick && !(barArm.mint === d.m && Date.now() - barArm.at < 2500)) { barArm = { mint: d.m, at: Date.now() }; renderBar(); setTimeout(renderBar, 2600); return; }
        barArm = { mint: null, at: 0 };
        execSell({ mint: d.m, symb: h.sym, pct: 100, interactive: true });
        renderBar();
      }
    }

    function render0() {
      try { renderBar(); } catch (_) {}
      if (!el) return;
      const ae0 = document.activeElement, typing = ae0 && el.contains(ae0) && ae0.tagName === 'SELECT'; // an open <select> would close
      if (typing) return;
      const html = ui.collapsed ? collapsedHtml() : fullHtml();
      const full = `<div class="in">${html}</div>${ui.collapsed ? '' : intelHtml() + bundHtml()}${modalHtml()}<div class="rw" title="Drag to change the width · double-click to reset (wide = 2 columns)"></div><div class="rz" title="Drag to resize · double-click to reset"></div>`;
      if (full !== el.__html) { el.__html = full; patch(el, full); el.classList.toggle('col', ui.collapsed); el.classList.toggle('wide', !ui.collapsed && !ui.edit && wideOn()); fit(); }
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
        ? `<div class="tk"><b>${escH(sym || 'Token')}</b><span class="mut n sm">${tail(mint)}</span><button class="ib" data-cpm="${mint}" title="Copy mint">${ICON.copy}</button><button class="ib ${ui.panel === 'info' ? 'on' : ''}" data-a="p:info" title="Coin info: AG profile, your trades, connection">${ICON.info}</button>${agTokChip(mint)}<span class="sp"></span>
          ${ui.busy ? `<span class="busy">${escH(ui.busy)}…</span>` : ''}${lv ? `<span class="lvd" title="Live price · ${srcName(tk.src)} stream"></span>` : ''}${mu ? `<span class="n mc ${lv && tk.dir > 0 ? 'up' : lv && tk.dir < 0 ? 'dn' : ''}" title="Market cap">$${kfmt(mu)}</span>` : ''}${cp != null ? `<span class="cv" title="Bonding curve (estimated)"><i style="width:${cp.toFixed(0)}%"></i></span><span class="mut n sm">${cp >= 100 ? 'migr.' : cp.toFixed(0) + '%'}</span>` : ''}</div>`
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
      const entry = avgEntry(held.map(([, h]) => h), true);
      const sgn = (v) => (v >= 0 ? '+' : '');
      const foot = `<div class="ft"><div class="g3s">${stat('HOLDING', sm ? sm.bal : null)}${stat('BOUGHT', sm ? sm.bought : null, 'up')}${stat('SOLD', sm ? sm.sold : null, 'dn')}<div class="sb" title="Average entry market cap of the open positions (cost-weighted, from AG)"><span class="lb">AVG ENTRY</span><span class="n v">${entry ? '$' + kfmt(entry) : '--'}</span><span class="n u ${entry && mu ? (mu >= entry ? 'up' : 'dn') : ''}">${entry && mu ? (mu / entry).toFixed(2) + '× now' : ''}</span></div></div>
        <div class="pc ${pnlS == null ? '' : pnlS >= 0 ? 'pos' : 'neg'}"><div><span class="lb">PNL${pnlS != null ? (lv ? ' <span class="lvt">● LIVE</span>' : posRef ? ` <span class="syn">· synced ${Math.max(0, Math.round((Date.now() - posRef.at) / 1000))}s ago</span>` : '') : ''}</span><div class="pv">
          <span class="n big">${pnlS == null ? '--' : usdRate ? sgn(pnlS) + usdV(pnlS * usdRate) : sgn(pnlS) + sol(pnlS) + ' ◎'}</span>
          ${pnlS != null && usdRate ? `<span class="n">${pnlS >= 0 ? '+' : '−'}◎ ${sol(Math.abs(pnlS))}</span>` : ''}</div></div><span class="sp"></span>
          ${sm && sm.pnl != null ? `<span class="pill n">${sgn(sm.pnl)}${sm.pnl.toFixed(1)}%</span><button class="ib shb" data-a="p:share" title="Share this PnL as an image">${ICON.share}</button>` : ''}</div>
        <div class="dl">${realized != null && Math.abs(realized) > 1e-6 ? `<span>Realized</span><span class="n">${usdRate ? sgn(realized) + usdV(realized * usdRate) : sol(realized) + ' ◎'}</span><i>·</i>` : ''}${live && S.dailyLoss > 0 && daily && daily.sum != null ? `<span title="Positions closed today vs your daily loss limit">Today</span><span class="n ${daily.sum < 0 ? 'dn' : 'up'}">${sgn(daily.sum)}${sol(daily.sum)} / −${S.dailyLoss} ◎</span>` : ''}<span class="sp"></span>${usdRate ? `<span>SOL</span><span class="n">$${usdRate.toFixed(1)}</span>` : ''}</div></div>`;

      const panel = ed ? '' : ui.panel === 'wal' ? pickerHtml() : ui.panel === 'set' ? settingsHtml() : ui.panel === 'trig' ? trigHtml(orders) : ui.panel === 'pos' ? posHtml(orders) : ui.panel === 'info' ? infoHtml() : ui.panel === 'share' ? shareHtml() : ui.panel === 'health' ? healthHtml() : '';
      return `${groupsRow}${head}${panel}${ed ? '' : alertsHtml()}
        <div class="bd">${tokLine}
          <div class="sec sbuy">${buyHead}<div class="g4">${buyTiles}</div>${ed ? edBuy : txLine('buy')}${cu}</div>
          ${!ed && st.adv ? advHtml(mint, orders) : ''}
          <div class="sep"></div>
          <div class="sec ssell">${sellHead}<div class="g4">${sellTiles}</div>${ed ? edSell : txLine('sell')}</div></div>
        ${ed ? '<div class="eh mut sm">Tab → next value · Enter saves · Esc cancels · empty a slot to hide it. ◎ / $ / % each keep their own 8 values.</div>' : foot + footbarHtml()}`;
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
      const entry = avgEntry(heldBy().map(([, h]) => h));
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
      const rows = Object.entries(heldAll).filter(([m]) => !pendingGone[m]).map(([mint, h]) => {
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


    // ---------------------------------------------------------- connection health: footbar + panel
    hs.hist = { relay: [], ag: [] };
    const pushHist = (k, v) => { if (v == null) return; const a = hs.hist[k]; a.push(v); if (a.length > 24) a.shift(); };
    const activeOrders = () => loadOrders().filter((o) => o.status === 'active').length;
    function authNow() {
      if (env === 'ag') return HL.sess;
      const h = hs.h && hs.h.sess;
      return h && (!hs.auth || h.at > hs.auth.at) ? h : hs.auth;
    }
    function relayState() { // GMGN: up | asleep | legacy | down | off
      const ri = relayInfo();
      if (ri.mode === 'legacy') return { s: 'legacy', ri };
      if (ri.mode === 'down') return { s: ri.age == null ? 'off' : 'down', ri };
      return { s: Date.now() - hs.pongAt < 12000 ? 'up' : 'asleep', ri };
    }
    function healthItems() {
      const now = Date.now(), items = [], act = activeOrders(), a = authNow();
      const it = (k, v, c) => items.push({ k, v, c });
      let action = null;
      const authBad = Core.authExpired(a, now);
      if (env === 'ag') {
        const o = ownerNow();
        it('Relay', iOwn() ? 'this tab' : o ? 'standby' : 'claiming', iOwn() ? 'g' : o ? 'n' : 'y');
        it('AG', a ? (a.ok ? msS(a.ms) : String(a.status || 'error')) : '--', a ? (a.ok ? 'g' : 'r') : 'n');
        const S = HL.sock;
        it('Feed', S.ok ? agoS(now - Math.max(S.last, S.ping, S.since)) : 'offline', S.ok ? 'g' : 'y');
        const l = GM_getValue('twLeader', null), lf = l && now - l.at < 10000;
        it('Orders', lf ? (l.id === me ? 'this tab' : 'other tab') : act ? 'paused' : 'idle', lf ? 'g' : act ? 'y' : 'n');
        if (authBad) action = { a: 'login', l: 'Log in' };
      } else {
        const rs = relayState(), h = hs.h;
        if (rs.s === 'up') it('Relay', msS(hs.rtt), hs.rtt > 800 ? 'y' : 'g');
        else it('Relay', { asleep: 'asleep', legacy: 'old tab', down: 'closed', off: 'off' }[rs.s], rs.s === 'off' ? 'n' : 'y');
        if (authBad) it('AG', String(a.status), 'r');
        else if (rs.s !== 'up' && rs.s !== 'legacy') it('AG', hs.dstat ? 'direct' : '--', hs.dstat ? (hs.dstat.ok ? 'y' : 'r') : 'n');
        else it('AG', a && a.ok ? msS(a.ms) : '--', a && a.ok ? 'g' : 'n');
        const tk = getMint() && ticks[getMint()];
        it('Feed', tk ? (now - tk.at < 60000 ? agoS(now - tk.at) : 'quiet') : '--', tk && now - tk.at < 60000 ? 'g' : 'n');
        const lead = rs.s === 'up' ? !!(h && h.leader) : (() => { const l = GM_getValue('twLeader', null); return !!l && now - l.at < 10000; })();
        it('Orders', authBad && act ? 'blocked' : lead ? 'AG tab' : act ? 'paused' : 'idle', authBad && act ? 'r' : lead ? 'g' : act ? 'y' : 'n');
        if (st.filter.mode !== 'off') { // AG filter: matches · hidden (grey until a backtester tab has ever published)
          const fl = ui.flt || {}, ever = !!(agPack && agPack.at);
          it('Filter', !ever ? '--' : agLive() ? `${fl.m || 0}✓ ${fl.h || 0}${st.filter.mode === 'dim' ? '◐' : '⊘'}` : 'stale', !ever ? 'n' : agLive() ? 'g' : 'y');
        }
        const ov = (rs.ri.o && rs.ri.o.v) || (h && h.v);
        if (authBad) action = { a: 'login', l: 'Log in' };
        else if (rs.s === 'legacy' || (rs.s === 'up' && ov && ov !== VER)) { action = { a: 'reload', l: `Reload AG tab${ov ? ' (' + ov + ' → ' + VER + ')' : ''}` }; }
        else if (rs.s === 'asleep') action = { a: 'wake', l: 'Wake' };
        else if (rs.s === 'down' || rs.s === 'off') action = { a: 'open', l: 'Open AG' };
      }
      const level = Core.healthLevel(items, action);
      return { items, action, level };
    }
    function footbarHtml() {
      const { items, action, level } = healthItems();
      return `<div class="hf ${level}"><button class="hfi" data-a="p:health" title="Connection health · click for details">${items.map((x) => `<span class="${x.c}" title="${x.k}"><i class="hdt ${x.c}"></i><span class="k">${x.k}</span><span class="v ${x.c === 'y' || x.c === 'r' ? x.c : ''}">${escH(x.v)}</span></span>`).join('')}</button>${action ? `<button class="hfa" data-ha="${action.a}">${escH(action.l)} ›</button>` : ''}</div>`;
    }
    const spark = (a, c) => { if (!a || a.length < 2) return '<svg width="60" height="18"></svg>'; const mx = Math.max(...a) || 1; return `<svg width="60" height="18" viewBox="0 0 60 18"><polyline points="${a.map((v, i) => `${(i * 60) / (a.length - 1)},${(17 - (v / mx) * 15).toFixed(1)}`).join(' ')}" fill="none" stroke="${c}" stroke-width="1.5" stroke-opacity=".85"></polyline></svg>`; };
    const hcol = { g: '#3DDC97', y: '#F2B84B', r: '#F05252', n: '#4B5160' };
    function healthHtml() {
      const { items, level } = healthItems(), now = Date.now(), byK = Object.fromEntries(items.map((x) => [x.k, x]));
      const a = authNow(), act = activeOrders();
      let rows;
      if (env === 'ag') {
        const o = ownerNow(), S = HL.sock;
        rows = [
          ['Relay · this backtester tab', iOwn() ? 'owns the relay: answers the terminal widgets (GMGN, Trojan…)' : o ? `standby · another backtester tab answers (v${o.v || '?'})` : 'claiming the relay…', byK.Relay, '', null],
          ['AG API', a ? `session ${a.ok ? 'OK' : a.status} · checked ${agoS(now - a.at)} ago` : 'not checked yet', byK.AG, a && a.ok ? msS(a.ms) : '--', 'ag'],
          ['AG socket', S.ok ? `connected ${agoS(now - S.since)} · ${S.subs} coin${S.subs === 1 ? '' : 's'} · ${S.re} reconnect${S.re === 1 ? '' : 's'}` : 'disconnected · socket.io is retrying', byK.Feed, S.ok ? agoS(now - Math.max(S.last, S.ping, S.since)) : '--', null],
          ['Order watcher', `${byK.Orders.v === 'idle' ? 'no active orders' : byK.Orders.v} · ${act} active`, byK.Orders, '', null],
        ];
      } else {
        const rs = relayState(), h = hs.h || {}, o = rs.ri.o || {}, S = h.sock || {};
        const rsub = { up: `${o.vis || h.vis ? 'visible' : 'in the background'} · v${o.v || h.v || '?'} · one owner, others on standby`, asleep: 'tab exists but did not answer the last pings (frozen by Chrome?)', legacy: 'still runs an older script: reload it once', down: `gone for ${agoS(rs.ri.age)} · buys / sells go direct`, off: 'no backtester tab seen yet · buys / sells go direct' }[rs.s];
        rows = [
          ['Relay · backtester tab', rsub, byK.Relay, rs.s === 'up' ? msS(hs.rtt) : '--', 'relay'],
          ['AG API', a ? `session ${a.ok ? 'OK' : a.status} · ${a.via === 'direct' ? 'direct call' : 'checked'} ${agoS(now - a.at)} ago` : 'no call yet', byK.AG, a && a.ok ? msS(a.ms) : '--', 'ag'],
          ['AG socket', h.sock ? (S.ok ? `connected ${agoS(now - S.since)} · ${S.subs} coin${S.subs === 1 ? '' : 's'} · ${S.re} reconnect${S.re === 1 ? '' : 's'}` : 'disconnected · retrying') : 'runs in the backtester tab', { c: h.sock ? (S.ok ? 'g' : 'y') : 'n' }, h.sock && S.ok ? agoS(now - Math.max(S.last || 0, S.ping || 0, S.since || 0)) : '--', null],
          ['Price feed', `${SN} title ticks${stream.at ? ' · AG ticks ' + agoS(now - stream.at) + ' ago' : ''}`, byK.Feed, byK.Feed.v, null],
          ...(byK.Filter ? [['AG filter', !(agPack && agPack.at) ? 'no match list yet · open the backtester with its Live Terminal on screen'
            : `${{ smart: 'smart hide', dim: 'dim', badge: 'badges only' }[st.filter.mode]}${agLive() ? '' : ' → badges only (list is stale)'} · ${(ui.flt || {}).m || 0} AG coins here · ${(ui.flt || {}).h || 0} ${st.filter.mode === 'dim' ? 'dimmed' : 'hidden'} · list ${agoS(now - agPack.at)} old`, byK.Filter, byK.Filter.v, null]] : []),
          ['Order watcher', `${byK.Orders.v === 'AG tab' ? 'runs in the backtester tab' : byK.Orders.v === 'idle' ? 'no active orders' : 'needs the backtester tab'} · ${act} active`, byK.Orders, '', null],
        ];
      }
      const logs = (env === 'ag' ? HL.log : hs.log.concat((hs.h && hs.h.log) || [])).slice().sort((x, y) => y.t - x.t).slice(0, 6);
      const tm = (t) => new Date(t).toLocaleTimeString([], { hour12: false });
      const lv = { g: ['HEALTHY', '#3DDC97'], y: ['DEGRADED', '#F2B84B'], r: ['DOWN', '#F05252'] }[level];
      return `<div class="olp pnl"><div class="sh"><b>Connection</b><span class="hbadge" style="background:${lv[1]}">${lv[0]}</span><span class="sp"></span><button class="ib" data-a="panelx" aria-label="Close">${ICON.x}</button></div>
        ${rows.map(([k, sub, x, v, hk]) => `<div class="hhr"><i class="hdt ${x ? x.c : 'n'}"></i><div class="hn"><b>${k}</b><span class="n">${escH(sub)}</span></div>${hk ? spark(hs.hist[hk], hcol[x ? x.c : 'n']) : ''}<span class="hv n">${escH(v || '')}</span></div>`).join('')}
        <div class="hlg"><span class="lb">LAST EVENTS</span>${logs.length ? logs.map((l) => `<span class="n ${l.lvl}"><span class="mut">${tm(l.t)}</span>  ${escH(l.m)}</span>`).join('') : '<span class="mut">nothing yet</span>'}</div>
        <div class="g3">${env === 'ag' ? '' : '<button class="btn sm" data-ha="wake">Wake AG tab</button>'}<button class="btn sm" data-ha="reconnect">Reconnect</button><button class="btn sm" data-ha="copy">Copy report</button></div>
        ${env === 'ag' ? '' : `<label class="ck"><input type="checkbox" data-s="autoReopen" ${st.autoReopen ? 'checked' : ''}>Re-open the backtester tab in the background if it is gone for 30 s</label>`}
        <span class="mut sm">Tip: Chrome → Settings → Performance → “Always keep these sites active” → add backtester.alphagardeners.xyz so Chrome never freezes it.</span></div>`;
    }
    function openAG(active) {
      try { if (typeof GM_openInTab === 'function') return GM_openInTab(AG + '/', { active: !!active, insert: true, setParent: true }); } catch (_) {}
      window.open(AG + '/', '_blank');
    }
    function pingRelay() {
      if (env === 'ag' || relayInfo().mode !== 'v2') return;
      hs.pingId = id(); hs.pingAt = Date.now();
      GM_setValue('agPing', { id: hs.pingId, at: hs.pingAt });
    }
    function healthAct(a) {
      if (a === 'login') { window.open(AG + '/', '_blank'); return toast('Log in on the backtester, then come back'); }
      if (a === 'open') { openAG(true); hl('opened the backtester tab'); return toast('Opening the backtester…'); }
      if (a === 'reload') {
        if (env !== 'ag' && relayState().s === 'legacy') return toast('The backtester tab runs an older version: reload it once (F5)', true);
        GM_setValue('agCmd', { cmd: 'reload', at: Date.now() }); hl('asked the backtester tab to reload'); return toast('Reloading the backtester tab…');
      }
      if (a === 'reconnect') {
        if (env === 'ag') { if (HL.reconnect) HL.reconnect(); bus.drop('/api/'); hlog('manual reconnect'); }
        else { GM_setValue('agCmd', { cmd: 'reconnect', at: Date.now() }); relayDownAt = 0; hl('asked the backtester tab to reconnect'); pingRelay(); }
        loadWallets(true); loadPos(); return toast('Reconnecting…');
      }
      if (a === 'wake') {
        GM_setValue('twPing', Date.now()); GM_setValue('agCmd', { cmd: 'wake', at: Date.now() }); relayDownAt = 0; pingRelay(); toast('Waking the backtester tab…');
        return setTimeout(() => { const s2 = relayState().s; if (s2 === 'up') { hl('backtester tab woke up'); toast('Backtester tab is back'); } else if (s2 === 'down' || s2 === 'off' || s2 === 'asleep') { hl('no answer → opened a fresh backtester tab', 'warn'); openAG(false); toast('No answer: opened a backtester tab in the background'); } render(); }, 2500);
      }
      if (a === 'copy') {
        const rep = JSON.stringify({ v: VER, env, at: new Date().toISOString(), relay: env === 'ag' ? { own: iOwn(), owner: ownerNow() } : { info: relayInfo(), rtt: hs.rtt, pongAgo: hs.pongAt ? Date.now() - hs.pongAt : null, h: hs.h }, auth: authNow(), direct: hs.dstat, sock: env === 'ag' ? HL.sock : null, log: env === 'ag' ? HL.log : hs.log }, null, 1);
        try { navigator.clipboard.writeText(rep); toast('Connection report copied'); } catch (_) { toast('Could not copy', true); }
      }
    }
    let lastRs = '';
    function healthTick() {
      if (env !== 'ag') {
        const rs = relayState().s;
        if (rs !== lastRs) {
          if (lastRs) hl({ up: 'backtester tab connected', asleep: 'backtester tab stopped answering pings', legacy: 'backtester tab runs an older script', down: 'backtester tab is gone', off: 'no backtester tab' }[rs], rs === 'up' ? 'i' : 'warn');
          lastRs = rs;
        }
        if (rs === 'up') { pushHist('relay', hs.rtt); const s2 = hs.h && hs.h.sess; if (s2 && s2.ok) pushHist('ag', s2.ms); }
        autoReopen();
      } else if (HL.sess && HL.sess.ok) pushHist('ag', HL.sess.ms);
      const hi = healthItems(), key = hi.level + hi.items.map((x) => x.k + x.c).join('') + (hi.action ? hi.action.a : '');
      if (key !== hs.key || ui.panel === 'health') { hs.key = key; render(); }
    }
    function autoReopen() {
      if (env === 'ag' || !st.autoReopen || document.hidden) return;
      const ri = relayInfo(), beatAt = GM_getValue('agRelayAt', 0) || 0, now = Date.now();
      if (ri.mode !== 'down' || !beatAt || now - beatAt < H.reopenAfter || now - beatAt > 2 * 3600e3) return;
      if (now - (GM_getValue('agReopenAt', 0) || 0) < H.reopenEvery) return;
      GM_setValue('agReopenAt', now);
      hl(`backtester tab gone for ${agoS(now - beatAt)} → re-opened it in the background`, 'warn');
      toast('Backtester tab was gone: re-opened it in the background (turn off in the connection panel)');
      openAG(false);
    }
    function startHealth() {
      if (env !== 'ag') {
        setInterval(() => { if (!document.hidden) pingRelay(); }, H.pingMs);
        document.addEventListener('visibilitychange', () => { if (!document.hidden) pingRelay(); });
        setTimeout(pingRelay, 300);
      }
      setInterval(() => { if (!document.hidden) healthTick(); }, 1000);
    }

    function infoHtml() {
      const mint = getMint();
      if (info.mint !== mint) loadInfo();
      const tk = mint && ticks[mint], relayAge = (Date.now() - (GM_getValue('agRelayAt', 0) || 0)) / 1000;
      const ago = (t) => (t ? Math.max(0, Math.round((Date.now() - t) / 1000)) + 's ago' : 'never');
      const conn = [
        ['Price stream', tk && Date.now() - tk.at < 10000 ? `${srcName(tk.src)} · live` : tk ? 'stale · ' + ago(tk.at) : 'no ticks', tk && Date.now() - tk.at < 10000 ? 'ok' : tk ? 'warn' : 'bad'],
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
        <div class="keys mut sm"><span><kbd>1–8</kbd> buy</span><span><kbd>⇧1–8</kbd> sell</span><span><kbd>X</kbd> initials</span><span><kbd>U</kbd> unit</span><span><kbd>S</kbd> split</span><span><kbd>G</kbd> group</span><span><kbd>Alt+1–3</kbd> preset</span><span><kbd>D</kbd> dip</span><span><kbd>L</kbd> live</span><span><kbd>C</kbd> collapse</span><span><kbd>B</kbd> holdings bar</span><span><kbd>/</kbd> custom</span><span><kbd>Esc</kbd> close</span></div>
        <span class="sm2">Alerts <span class="mut sm">(coins you hold · run by the backtester tab)</span></span>
        <div class="eg two">${ck('al.dev.on', 'Dev sells', A.dev.on)}${f('al.dev.pct', 'when ≥ % of supply', A.dev.pct, 0.5)}
          ${ck('al.dev.auto', 'Auto-sell 100% on a dev sell', A.dev.auto)}<span></span>
          ${ck('al.whale.on', 'Whale sells', A.whale.on)}${f('al.whale.sol', 'when ≥ ◎', A.whale.sol, 1)}
          ${ck('al.move.on', 'Fast mcap moves', A.move.on)}${f('al.move.pct', 'when ≥ % in 1 min', A.move.pct, 5)}
          ${ck('al.fills', 'Fill & exit notices', A.fills)}${ck('al.sound', 'Sound', A.sound)}
          ${ck('al.desktop', 'Desktop notifications', A.desktop)}<span class="mut sm">${window.Notification ? 'permission: ' + Notification.permission : 'not supported'}</span></div>
        <span class="sm2">Size & ${env === 'ag' ? 'terminal' : SN} cards</span>
        <div class="eg two">${f('scalePct', 'Size % (or drag the corner)', Math.round((Number(st.scale) || 1) * 100), 5)}${ck('autoFit', 'Auto-fit screen height', st.autoFit)}
          ${f('qb', 'Card quick buy (◎)', st.qb, 0.01)}${ck('cards', 'Holdings + quick buy on cards', st.cards)}</div>
        ${env === 'ag' ? '' : `<span class="sm2">AG filter on ${SN} lists <span class="mut sm">(your filtered AG Live Terminal)</span></span>
        <div class="sh"><span class="seg">${[['smart', 'Smart hide'], ['dim', 'Dim'], ['badge', 'Badges only'], ['off', 'Off']].map(([k, l]) => `<button class="${st.filter.mode === k ? 'on' : ''}" data-fm="${k}">${l}</button>`).join('')}</span></div>
        <div class="mut sm">Smart hide is reversible: a coin is back the moment AG matches it. Your current coin is never hidden, and while the list is stale (backtester closed or Live Terminal off screen) only badges show.</div>
        ${site && site.nativeHide ? `<div class="eg two">${ck('flt.native', `Also use ${SN}'s own Hide token`, st.filter.native)}${f('flt.after', 'after a coin is unmatched for (min)', st.filter.after, 1)}</div>
        <div class="mut sm">${SN}'s own hide stays hidden in your ${SN} account: if AG matches the coin later it won't come back by itself. ${nativeDone.size} hidden that way so far.</div>` : ''}`}
        <span class="sm2">Layout</span>
        <div class="sh"><span class="seg">${[[380, 'Tall'], [720, 'Wide · 2 columns']].map(([w, l]) => `<button class="${(wideOn() ? 720 : 380) === w ? 'on' : ''}" data-lw="${w}">${l}</button>`).join('')}</span><span class="mut sm">or drag the right edge</span></div>
        <span class="sm2">Holdings bar</span>
        <div class="eg two">${ck('bar', 'Show holdings at the top', st.bar && !st.barHidden)}${ck('barOneClick', 'One-click ⚡ 100% (no confirm)', st.barOneClick)}${st.barBox || Object.keys(st.barHide).length ? `<button class="btn sm" data-a="barreset" title="Back to the top centre, normal size, nothing hidden">Reset bar position & hidden</button>` : ''}${env === 'ag' ? ck('barOnAg', 'Also on the backtester', st.barOnAg) : ''}</div>
        <span class="sm2">AG Intel</span>
        <div class="eg two">${ck('intelOn', 'Intel panel on coin pages', st.intel.on)}${ck('cardIntel', 'AG risk pill + peek on cards', st.cardIntel)}
          ${ck('unhideOnSignal', 'Unhide a hidden coin on a new AG signal', st.unhideOnSignal)}<span></span>
          <span class="mut sm">${(st.hiddenCoins || []).length} coin(s) hidden from lists</span>${(st.hiddenCoins || []).length ? '<button class="btn sm" data-a="unhide">Unhide all</button>' : '<span></span>'}</div>
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
      if (d.s || d.se === 'be' || d.tf === 'attach' || d.bf) return; // checkboxes → onChange
      if (d.bu) return buyUnitAmt(d.bu);
      if (d.su) return st.sellUnit === 'sol' ? sellSol(d.su) : sell(d.su);
      if (d.su2) return sell(d.su2);
      if (d.ha) return healthAct(d.ha);
      if (d.oc) return cancelOrder(d.oc);
      if (d.bsel != null && TB) { ui.bundSel = d.bsel || null; return render(); }
      if (d.bwatch) { const w = st.bund.watch; if (w.includes(d.bwatch)) st.bund.watch = w.filter((x) => x !== d.bwatch); else w.push(d.bwatch); save(); toast(w.includes(d.bwatch) ? 'Funder watched on every coin you open or hold' : 'Funder unwatched'); return render(); }
      if (d.brule) { ui.bdraft = Object.assign(RULE_DEF(), { who: 'funder', funder: d.brule, scope: 'any', then: 'alert' }); st.bund.view = 'rules'; if (!st.bund.watch.includes(d.brule)) st.bund.watch.push(d.brule); save(); return render(); }
      if (d.bsell) return execSell({ mint: d.bsell, symb: (heldAll[d.bsell] || {}).sym, pct: 100, interactive: true });
      if (d.bq) { return armRule(d.bq === 'dump' ? { who: 'any', when: 'sell', pct: 30, windowSec: 60, scope: 'held', then: 'sell', sellPct: 100, cooldownMin: 5, once: true } : { who: 'any', when: 'sell', pct: 20, windowSec: 60, scope: 'held', then: 'alert', cooldownMin: 5, once: false }); }
      if (d.btog) { const r = st.bund.rules.find((x) => x.id === d.btog); if (r) { r.on = !r.on; save(); } return render(); }
      if (d.bdel) { st.bund.rules = st.bund.rules.filter((x) => x.id !== d.bdel); save(); return render(); }
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
      if (d.fm) { st.filter.mode = d.fm; save(); scanCards(); return render(); }
      if (d.lw) { setW(Number(d.lw)); save(); return render(); }
      if (d.tt) { ui.tf.tab = d.tt; ui.tf.target = ''; return render(); }
      if (d.tq) {
        const mc = mcapNow(getMint());
        const entry = avgEntry(heldBy().map(([, h]) => h));
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
        if (ui.panel === 'health') pingRelay();
        return render();
      }
      switch (a) {
        case 'panelx': ui.panel = null; return render();
        case 'bund': st.bund.open = !st.bund.open; save(); return render();
        case 'bview': st.bund.view = st.bund.view === 'rules' ? 'list' : 'rules'; ui.bundSel = null; save(); return render();
        case 'barm': { const d = Object.assign({}, ui.bdraft || RULE_DEF()); if (d.then !== 'buy') delete d.mode; ui.bdraft = null; return armRule(d); }
        case 'barreset': st.barBox = null; st.barHide = {}; save(); renderBar(); return render();
        case 'intel': st.intel.open = !st.intel.open; save(); if (st.intel.open) loadIntel(getMint()); return render();
        case 'intelr': loadIntel(getMint(), true); return;
        case 'imore': ui.imore = !ui.imore; return render();
        case 'idip': { const mc = mcapNow(getMint()); ui.panel = 'trig'; ui.tf.tab = 'dip'; if (mc) ui.tf.target = kfmt(mc * 0.7); return render(); }
        case 'unhide': st.hiddenCoins = []; st.hiddenMeta = {}; save(); scanCards(); toast('All hidden coins are back'); return render();
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
      if (d.bf) { const b = ui.bdraft || (ui.bdraft = RULE_DEF()); b[d.bf] = e.target.type === 'checkbox' ? e.target.checked : e.target.type === 'number' ? Number(tv) : tv; return render(); }
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
      else if (d.s === 'bar') { st.bar = ch; st.barHidden = false; }
      else if (d.s === 'barOneClick') st.barOneClick = ch;
      else if (d.s === 'autoReopen') st.autoReopen = ch;
      else if (d.s === 'barOnAg') st.barOnAg = ch;
      else if (d.s === 'intelOn') { st.intel.on = ch; if (ch) loadIntel(getMint()); }
      else if (d.s === 'unhideOnSignal') { st.unhideOnSignal = ch; save(); }
      else if (d.s === 'cardIntel') { st.cardIntel = ch; save(); scanCards(); }
      else if (d.s === 'cards') { st.cards = ch; save(); scanCards(); return render(); }
      else if (d.s === 'bund.bg') st.bund.bg = ch;
      else if (d.s === 'flt.native') { st.filter.native = ch; save(); scanCards(); }
      else if (d.s === 'flt.after') st.filter.after = Math.max(0, v || 0);
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
    function openCoin(mint) {
      if (env === 'ag') location.hash = 'token/' + mint;
      else {
        // reuse a link the page already has for this coin (keeps the terminal's own extra params), else the plain URL
        const a = [...document.querySelectorAll(site.cards)].find((x) => x.href && site.cardMint(x.getAttribute(site.cardAttr || 'href')) === mint);
        location.href = a ? a.href : site.tokenUrl(mint);
      }
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
      return `<div class="als">${all.length > 2 ? `<div class="sh mut sm">${all.length - 2} older alert${all.length > 3 ? 's' : ''} hidden<span class="sp"></span><button class="lk" data-a="alclear">Clear all</button></div>` : ''}${list.map((a) => `<div class="al ${a.kind}"><div class="sh"><span class="atag">${{ dev: 'DEV SELL', whale: 'WHALE', move: 'MOVE', bundle: 'BUNDLE' }[a.kind] || 'ALERT'}</span><b>${escH(a.title)}</b><span class="sp"></span><span class="n mut sm">${Math.max(0, Math.round((Date.now() - a.at) / 1000))}s</span></div>
        <div class="sm">${escH(a.body)}</div>
        ${a.kind === 'dev' && !a.auto ? `<div class="g3"><button class="btn danger" data-alsell="${a.mint}">Sell 100%</button><button class="btn" data-alinit="${a.mint}">Sell init</button><button class="btn ghost" data-alx="${a.id}">Dismiss</button></div>`
          : `<div class="ab"><button class="lk" data-open="${a.mint}">Open</button><span class="sp"></span><button class="btn sm ghost" data-alx="${a.id}">Dismiss</button></div>`}</div>`).join('')}</div>`;
    }

    // ---------------------------------------------------------- every position in the current mode (both tabs)
    let heldAll = {};
    // ---------------------------------------------------------- coin info: AG profile chips + your trades
    let info = { mint: null, chips: null, trades: null, at: 0 };
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
      const tr = info.mint === mint && info.trades ? info.trades : null;
      const t0 = tr && tr.length ? tr[0].t : null;
      return { sym: sym || tail(mint), pct: sm.pnl, sol: sm.pnlSol, usd: usdRate && sm.pnlSol != null ? sm.pnlSol * usdRate : null, entry: avgEntry(held.map(([, h]) => h)),
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
        case 'b': st.barHidden = !st.barHidden; save(); renderBar(); break;
        case '/': { if (ui.collapsed) { ui.collapsed = false; render0(); } const i = el.querySelector('[data-a=camt]'); if (i) i.focus(); break; }
        case 'escape': if (ui.panel) { ui.panel = null; render(); } else done = false; break;
        default: done = false;
      }
      if (done) { e.preventDefault(); e.stopImmediatePropagation(); }
    }

    function mountW() {
      if (document.getElementById('agtw')) return;
      const s = document.createElement('style'); const ti = CSS.indexOf('.agtw-toast'); s.textContent = `#agtw{--k:1px;--w:380}` + scalePx(CSS.slice(0, ti)) + CSS.slice(ti); document.head.appendChild(s);
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
      el.addEventListener('dblclick', (e) => { if (e.target.closest('.rz')) { st.scale = 1; save(); setK(1); fit(); } if (e.target.closest('.rw')) { setW(380); save(); fit(); } });
      setW(Number(st.w) || 380);
      el.addEventListener('mousedown', (e) => {
        if (e.target.closest('.rw')) { // width: more room → 2-column layout (≥ 600 at 100%)
          e.preventDefault();
          const sx = e.clientX, sw = Number(st.w) || 380, h = e.target.closest('.rw'); h.classList.add('on');
          const mv = (ev) => setW(sw + (ev.clientX - sx) / curK);
          const up = () => { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); h.classList.remove('on'); save(); fit(); toast(wideOn() ? `Wide layout · ${st.w}px` : `Width ${st.w}px`); };
          document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
          return;
        }
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
      if (TB) { setInterval(() => { tbTick().catch(() => {}); }, 3000); GM_addValueChangeListener('tbFeed', (_k, _o, _v, remote) => { if (remote) { render(); scanCardsSoon(); } }); }
      try { startHealth(); } catch (e) { console.warn('[AG widget] health', e); }
      // test hook (only when localStorage.agtwTest = '1'): lets the test-suite drive timers directly
      try { if (localStorage.getItem('agtwTest') === '1') unsafeWindow.__agtw = { bsnap, tbIngest, bpTpl: () => bpTpl, agPack: () => agPack, nativeDone, pendingGone, pendingBuy, wallets: () => wallets, watch, pollDev, loadHeld, loadDaily, loadSrv, loadPos, st, ui, ticks, heldAll: () => heldAll, render0, scanCards, hidChk, H, hs, healthTick, relayInfo, authBlock, HL }; } catch (_) {}
      setInterval(() => { if (!document.hidden && posRef && !isLive(getMint())) render(); }, 1000); // "synced Xs ago"
      setInterval(() => { const m = getMint(); if (m && srv.mint !== m && st.adv) loadSrv(); }, 900);
      setInterval(() => { const m = getMint(); if (m && st.intel.on && !document.hidden && !ui.collapsed) loadIntel(m); }, 1000); // loadIntel itself throttles to 15s
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
        if (v.w && v.w !== st.w) setW(v.w);
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
})();
