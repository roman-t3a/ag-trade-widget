# Changelog

## 3.5.1
- Auto-update: Tampermonkey now updates the script from this repo (`@updateURL` / `@downloadURL`).
- `@require` socket.io is pinned with a sha256 integrity hash.
- Code cleanup: pure logic moved into one `Core` block at the top of the file (curve math, multi-wallet legs,
  relay rules, AG intel parsing, request bus…), shared by the widget and unit-tested in Node; dead code removed;
  ESLint clean. Still a single file.
- CI on GitHub Actions: lint, userscript header checks, unit tests, end-to-end tests; tagged versions are released
  with the `.user.js` attached.

## 3.5.0
- Connection: one backtester tab owns the relay (others stand by), so a call from GMGN is never executed twice.
- Calls are acked in ms; no ack in 1.5 s → sent direct (safe); acked but no result → an order is never resent.
- Ping/pong with round-trip time, AG session check every minute (401 → buys refused up front), socket watchdog,
  version check between tabs, optional auto re-open of the backtester tab.
- Health footbar (Relay · AG · Feed · Orders) + Connection panel with latency sparklines, event log and actions.

## 3.4.0
- A hidden coin comes back in the GMGN list (tagged "AG SIGNAL") when AG fires a new signal on it.

## 3.3.0
- Wide layout: drag the right edge (≥ 600 px → 2 columns) or Settings → Layout.
- Holdings bar at the top of GMGN (◎ PnL, two-click ⚡ 100% sell); AG Intel side panel off by default.

## 3.0.0
- Server-side TP/SL exit strategies, trigger orders (dip, TP at mcap, trailing, DCA), safety rails,
  hotkeys, positions, alerts, trade log, shareable PnL card, AG Intel + card insight.

## 2.2.1
- Full redesign; wallet groups, split / consolidate planner; buy in SOL / USD / % of supply; edit-in-place presets;
  USD PnL; live price + PnL stream; average entry mcap; resizable widget; scroll-safe re-rendering.

## 1.7.0
- First version: floating buy/sell panel on the AG backtester and GMGN.
