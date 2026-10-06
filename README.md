# AG ⚡ Trade Widget

A Tampermonkey userscript: a GMGN / Axiom-style floating buy/sell panel that trades through your
**Alpha Gardeners** wallets, on `backtester.alphagardeners.xyz` and `gmgn.ai`.

![Widget](docs/screenshots/01-main.png)

## Install
1. Install [Tampermonkey](https://www.tampermonkey.net/).
2. Create a new script and paste `ag-trade-widget.user.js` (or drag the file onto Chrome).
3. Keep a **backtester tab** open and logged in: the GMGN widget relays its calls through it.
   Tip: Chrome → Settings → Performance → *Always keep these sites active* → add `backtester.alphagardeners.xyz`.
4. After updating the script, reload the backtester tab once (the footbar tells you when versions differ).

## Features
- Buy in SOL / USD / % of supply, sell in % or SOL; 3 presets edited in place; paper or LIVE.
- Wallet groups, split buys with jitter / stagger, consolidate / split planner.
- Exit strategies (server-side TP / SL on AG), trigger orders (dip, TP at mcap, trailing, DCA), safety rails.
- Live price + PnL (GMGN title ticks + AG socket), average entry, positions, alerts, trade log, share card.
- GMGN cards: AG risk pill + hover peek, quick buy, hide coin (comes back on a new AG signal).
- Holdings bar at the top of GMGN, wide 2-column layout, hotkeys.
- Connection health footbar: Relay · AG · Feed · Orders, with a diagnostics panel.

## How the tabs talk
```
GMGN tab ──agRpc──▶ Tampermonkey storage ──▶ backtester tab (relay owner) ──▶ AG API / socket
   ▲    ◀─agRpcAck / agRpcRes / agPong──┘          standby backtester tabs ignore calls
   └── no ack in 1.5 s → direct HTTPS to AG (an order is never sent twice)
```

## Development
```
npm install          # playwright (Chromium)
npm run check        # syntax check
npm test             # ~130 end-to-end checks against a mocked AG backend; screenshots in test/shots/
```
The suite loads the userscript into a page with GM_* shims, a fake socket.io and a mocked AG backend.

## Design
`design/` holds the design canvas boards (`*.dc.html` + `canvas.json`) used for the proposals.

## Screenshots
| | |
|---|---|
| ![Wide](docs/screenshots/23-wide.png) | ![Health](docs/screenshots/connection-health.png) |
| ![Holdings bar](docs/screenshots/20-holdings-bar.png) | ![Cards](docs/screenshots/19-cards-peek.png) |
