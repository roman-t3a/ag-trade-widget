'use strict';
// Synthetic launches in the shape Solana RPC getTransaction (jsonParsed) returns, for the Buy Guard tests.
// cat(): the coin from the Proxima report — dev buys 25.2% at create, a slot-0 sniper, 29 farm wallets buying one
// per slot with one transaction shape (legacy · 0.000029 ◎), the dev selling 6× into them, outside buyers on terminals.
const PUMP = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P', CB = 'ComputeBudget111111111111111111111111111111', ATA = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const GMGN = 'GMgnVFR8Jb39LoXsEVzb3DvBy3ywCmdmJquHUy1Lrkqb', JITO = '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5';
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const addr = (tag) => { let s = tag.replace(/[^1-9A-HJ-NP-Za-km-z]/g, 'x'); let h = 7; for (const c of tag) h = (h * 31 + c.charCodeAt(0)) >>> 0; while (s.length < 44) { h = (h * 1103515245 + 12345) >>> 0; s += B58[h % 58]; } return s.slice(0, 44); };

function launch(mint, o = {}) {
  const S0 = o.slot0 || 454465966, T0 = o.t0 || 1791441407, bal = {}, txs = [];
  let n = 0;
  const tx = ({ rel, w, d, sol = 0, fee = 5000, ver = 'legacy', progs = [PUMP], tip = false, logs = [] }) => {
    const pre = [], post = [];
    for (const [ow, x] of Object.entries(d)) {
      if (ow in bal) pre.push({ mint, owner: ow, uiTokenAmount: { uiAmount: bal[ow] } });
      bal[ow] = (bal[ow] || 0) + x;
      post.push({ mint, owner: ow, uiTokenAmount: { uiAmount: bal[ow] } });
    }
    const ins = progs.map((p) => ({ programId: p }));
    if (tip) ins.push({ programId: '11111111111111111111111111111111', program: 'system', parsed: { type: 'transfer', info: { source: w, destination: JITO, lamports: 100000 } } });
    const sig = addr('sig' + (n++) + mint).slice(0, 44) + 'S';
    txs.push({ slot: S0 + rel, blockTime: T0 + Math.round(rel * 0.4), version: ver === 'legacy' ? 'legacy' : 0,
      transaction: { signatures: [sig], message: { accountKeys: [{ pubkey: w, signer: true, writable: true }], instructions: ins } },
      meta: { err: null, fee, preBalances: [10e9], postBalances: [10e9 - Math.round(sol * 1e9) - fee], preTokenBalances: pre, postTokenBalances: post, logMessages: logs } });
  };
  return { tx, txs, bal, PUMP, CB, ATA, GMGN };
}
function cat(mint, o = {}) {
  const L = launch(mint, o), dev = o.dev || addr('26MEdev'), pool = o.pool || addr('2emzpool'), sn = addr('CWiNsniper');
  const devTok = 251.6e6;
  L.tx({ rel: 0, w: dev, d: { [dev]: devTok, [pool]: 1e9 - devTok }, sol: 8.2, fee: 106000, ver: 0, progs: [CB, PUMP], tip: !!o.tip, logs: ['Program log: Instruction: Create', 'Program log: Instruction: Buy'] });
  L.tx({ rel: 0, w: sn, d: { [sn]: 20.2e6, [pool]: -20.2e6 }, sol: 0.6, fee: 3749000, ver: 0, progs: [CB, '5DVzy5EpG2xVxrwwuyZPDe9EpraUnGh7ZgYABwizzNVu'] });
  L.tx({ rel: 5, w: sn, d: { [sn]: -20.2e6, [pool]: 20.2e6 }, sol: -0.9, fee: 7700, ver: 0, progs: [CB, '5DVzy5EpG2xVxrwwuyZPDe9EpraUnGh7ZgYABwizzNVu'] });
  const farm = Array.from({ length: 29 }, (_, i) => addr('farm' + i));
  const fb = [[5, 0, 19.8], [11, 1, 15.7], [11, 2, 13.8], [12, 3, 0.2], [14, 4, 0.4], [15, 5, 32.1], [16, 6, 11.4], [17, 7, 20.9], [19, 8, 2.1], [20, 9, 10], [20, 10, 5.9], [21, 11, 17], [21, 12, 5.5], [21, 13, 12],
    [22, 14, 8.5], [23, 15, 16.3], [23, 16, 19.2], [24, 17, 2.3], [25, 18, 19.1], [27, 19, 1.5], [29, 20, 17.6], [30, 21, 27.9], [33, 22, 16.7], [34, 13, 0.3], [34, 23, 11.5], [36, 24, 5.4], [36, 10, 4], [37, 25, 2.2], [38, 26, 17.9], [39, 27, 29.8], [39, 28, 6.1]];
  const outs = [[5, 'o1', 1.97, 12500], [6, 'o2', 1.92, 12500], [6, 'o3', 1.96, 40608], [6, 'o4', 0.98, 27000], [6, 'o5', 1.94, 605000], [6, 'o6', 0.49, 77000], [8, 'o7', 1.9, 78977], [8, 'o8', 0.49, 77000], [14, 'o9', 1.8, 505000], [16, 'o10', 1.9, 605000]];
  const devSells = [[13, 75.5], [18, 52.8], [26, 37], [28, 25.9], [32, 18.1], [36, 42.3]];
  const ev = [];
  for (const [rel, i, m] of fb) ev.push({ rel, kind: 'farm', w: farm[i], m });
  for (const [rel, k, m, fee] of outs) ev.push({ rel, kind: 'out', w: addr(k), m, fee });
  for (const [rel, m] of devSells) ev.push({ rel, kind: 'dev', w: dev, m });
  ev.sort((a, b) => a.rel - b.rel);
  for (const e of ev) {
    const tok = e.m * 1e6;
    if (e.kind === 'farm') L.tx({ rel: e.rel, w: e.w, d: { [e.w]: tok, [pool]: -tok }, sol: e.m * 0.03, fee: 29000, progs: [CB, CB, ATA, PUMP] });
    else if (e.kind === 'out') L.tx({ rel: e.rel, w: e.w, d: { [e.w]: tok, [pool]: -tok }, sol: 0.0988, fee: e.fee, progs: e.fee === 15000 ? [CB, GMGN] : [CB, PUMP] });
    else L.tx({ rel: e.rel, w: dev, d: { [dev]: -tok, [pool]: tok }, sol: -e.m * 0.03, fee: 29000, progs: [CB, CB, PUMP] });
  }
  return { txs: L.txs, dev, pool, farm, sniper: sn };
}
// a clean launch: dev buys 2% and holds, 15 buyers on different terminals / fees
function clean(mint) {
  const L = launch(mint), dev = addr('cleandev'), pool = addr('cleanpool');
  L.tx({ rel: 0, w: dev, d: { [dev]: 20e6, [pool]: 980e6 }, sol: 0.6, fee: 105000, progs: [CB, PUMP], logs: ['Program log: Instruction: Create'] });
  for (let i = 0; i < 15; i++) { const w = addr('buyer' + i); L.tx({ rel: 2 + i * 3, w, d: { [w]: 3e6, [pool]: -3e6 }, sol: 0.1, fee: 5000 + i * 7000, progs: i % 3 ? [CB, PUMP] : [CB, GMGN] }); }
  return { txs: L.txs, dev, pool };
}
// a terminal default: 12 buyers with the same fee AND the same router (one terminal's preset), dev holds
function terminal(mint) {
  const L = launch(mint), dev = addr('termdev'), pool = addr('termpool');
  L.tx({ rel: 0, w: dev, d: { [dev]: 10e6, [pool]: 990e6 }, sol: 0.3, fee: 105000, progs: [CB, PUMP], logs: ['Program log: Instruction: Create'] });
  for (let i = 0; i < 12; i++) { const w = addr('tbuyer' + i); L.tx({ rel: 1 + i * 4, w, d: { [w]: 2e6, [pool]: -2e6 }, sol: 0.1, fee: 1005000, progs: [CB, GMGN] }); }
  return { txs: L.txs, dev, pool };
}
// pao(): a Block-0 bundle — the dev creates (12.5%) and 3 wallets buy 12.9% in the SAME slot with the dev's tool
// (v0 · 0.001005 ◎), one outside sniper with a router, then the dev sells everything with that same shape by slot +35
function pao(mint) {
  const L = launch(mint), dev = addr('2bBRdev'), pool = addr('5d3Upool'), b = [addr('DuKtb0'), addr('68aib0'), addr('HZsXb0')], sn = addr('5fgpsn');
  L.tx({ rel: 0, w: dev, d: { [dev]: 124.86e6, [pool]: 875.14e6 }, sol: 4.05, fee: 1010000, ver: 0, progs: [CB, PUMP], logs: ['Program log: Instruction: CreateV2'] });
  [[0, 44.68], [1, 42.94], [2, 41.11]].forEach(([i, m]) => L.tx({ rel: 0, w: b[i], d: { [b[i]]: m * 1e6, [pool]: -m * 1e6 }, sol: 1.8, fee: 1005000, ver: 0, progs: [CB, PUMP] }));
  L.tx({ rel: 0, w: sn, d: { [sn]: 6.13e6, [pool]: -6.13e6 }, sol: 0.3, fee: 302846, ver: 0, progs: [CB, 'L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95'] });
  for (let i = 0; i < 6; i++) { const w = addr('paoout' + i); L.tx({ rel: 2 + i * 3, w, d: { [w]: 0.5e6, [pool]: -0.5e6 }, sol: 0.03, fee: 6000 + i * 9000, progs: [CB, PUMP] }); }
  [[8, 62.43], [12, 31.21], [35, 31.22]].forEach(([rel, m]) => L.tx({ rel, w: dev, d: { [dev]: -m * 1e6, [pool]: m * 1e6 }, sol: -2, fee: 1005000, ver: 0, progs: [CB, PUMP] }));
  return { txs: L.txs, dev, pool, b0: b, sniper: sn };
}
module.exports = { addr, launch, cat, clean, terminal, pao, PUMP, GMGN, JITO };
