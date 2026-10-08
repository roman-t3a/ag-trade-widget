# Changelog

## 3.13.0
- **Buy Guard (Trojan).** Before a buy leaves the widget (buttons, hotkeys, Trenches ⚡, dip / DCA orders, bundle
  rules), the coin gets a 0–100 score. It reads the coin's first 60 transactions over Solana RPC and finds the creator,
  the biggest group of wallets sharing one transaction shape (a launch tool's farm), the dev's sells and slot-0
  snipers, then adds Trojan's holders data.
  - Checks: farm stream, dev sells into it, reused farm wallets (1,000+ transactions in the 4 days before), a farm
    you saved, a dev you flagged, nuke risk (your buy pushes outside buying past a round SOL line in the first
    10 min, where a launcher's Sniper Guard may sell into you), bundles already out, shared funder, dev record (off).
  - Clear → the buy goes. Caution → shrunk to ◎ 0.05 (asks first for a manual buy). Block → not sent: cancel, buy
    small, or hold 2 s to buy anyway. Orders and bundle rules skip a blocked coin for 30 min. Every stop is logged.
  - "Why?" draws the launch: lanes for the dev, the farm, slot-0 and outside buyers, the transaction shapes, and the
    dev's holding over time.
  - Bundles panel → shield button: the guard view for the coin, the log, and "Remember this farm" / "Flag this dev".
  - Trenches cards in view are checked one at a time: a GUARD chip, and blocked cards dimmed (or hidden, or chip only).
  - ⚙ → Buy Guard: on / off, warn · shrink · block, score lines, shrink size, nuke lines, RPC address (public
    mainnet by default; a key-based RPC is much faster), what to do if the check is late, each check and its weight.
  - New `@connect` hosts for Solana RPC providers (mainnet, Helius, QuickNode, Triton, Ankr, Alchemy, Shyft).

## 3.12.1
- Bundles: the coin's **pool** (pump.fun bonding curve, or the AMM pool after migration) is no longer listed as a
  bundle. It is the #1 holder and its two Trojan rows differ, so it looked like one. It's skipped when Trojan flags it
  as the reserve owner, or when a wallet never buys or sells but moves tokens in and out on every trade. Applies to
  both groupings, the summary, rules and badges.

## 3.12.0
- Bundles panel: a **grouping switch** — *Trojan's bundles* (default, Trojan's own linking, as in 3.11) or *Same first
  funder* (the 3.10 way: 2+ wallets fed by the same first funder, from the wallet rows; shows same-funding-amount and
  big-funder flags). Saved; rules, feed and badges use the grouping you pick (history restarts when you switch).

## 3.11.0
- **Bundles now match Trojan's own grouping.** 3.10 guessed bundles from wallets sharing a first funder, which gave
  different groups than Trojan's holders table. Trojan links bundle wallets server-side: its
  `/v1/tokens/bundled-positions` has one row per bundle (the whole bundle's amounts, under its primary wallet), and
  `/v1/tokens/positions` one row per wallet. A bundle is now a bundled row that isn't that wallet alone — the same
  rows, balances, buys and sells Trojan shows.
- While Trojan's holders table is on screen, the panel also takes Trojan's bundle name (e.g. "Beanzz"), wallet
  count, confidence (high / medium / low) and member wallets from it.
- Background watch replays both requests for the coins you hold. "Watch funder" is now "Watch bundle".

## 3.10.1
- Fix: collapsing the Trojan BUNDLES panel left a wide empty box; it now folds to the thin tab (click it to reopen).

## 3.10.0
- **Trojan bundles** (Trojan only). A BUNDLES panel docks next to the widget on every Trojan coin:
  - bundle risk, how many bundles still hold how much of the supply, snipers, dev-linked wallets, a supply bar;
  - one row per bundle (wallets sharing the same first funder): wallets, share held, last move (SOLD x%, EXIT,
    ACCUM, SPLIT, NEW, HOLDING), PnL, bag left;
  - open a bundle: bought / sold / PnL, funder → wallets, flags (bundled at launch, same funding amount, snipers,
    dev-linked), what it did, sell my bag, rule for this bundle, watch the funder everywhere.
- Data: Trojan's own holders endpoint (`/v1/tokens/bundled-positions`). The widget reads the answers Trojan's page
  already gets, asks for the coin on screen if the page didn't, and (one Trojan tab at a time) watches the coins you
  hold every ~15s with the same request.
- **Bundle rules**: when (any / top-3 / ≥ X% / dev-linked / sniper bundle / watched funder) sells ≥ X% within N s,
  is out, accumulates, sends tokens out, appears, or ALL bundles are out; on this coin / coins I hold / any coin I
  open; then alert, sell X%, sell initials, hide the coin, or **buy** (reverse rules, paper by default). Once per
  coin or a cooldown, shared across tabs; LIVE rules ask for confirmation; safety rails apply to rule buys.
- Feed of bundle moves across coins; `BUNDLE −x%` badges in the holdings bar and `BUNDLES x%` on Trenches cards;
  BUNDLE alert cards say what happened and what the rule did.

## 3.9.0
- **Faster balance / position updates after a trade.** Buys lower the wallet balances right away, then AG is
  re-read at 0.6 · 1.5 · 3 · 5 · 8 · 12 · 18 · 26 s until both the position and the balance show the trade (instead
  of fixed refreshes at 2.5 / 8 s). Terminal tabs no longer get a balance up to 30 s old from the backtester
  tab's cache. Auto orders executed by the backtester tab refresh every tab the same way.
- **Holdings bar**
  - a position you fully sell disappears at once (it stays hidden until AG drops it, 2 min max);
  - a buy shows as a dashed "pending…" chip until AG lists the position;
  - **hide a position** with ×; "+N hidden" shows them again (↺ to unhide). Closing the position forgets the hide;
  - **movable** (drag the dotted grip) and **resizable** (corner; taller = chips on several rows). Double-click
    either to put it back at the top; ⚙ → Holdings bar → Reset;
  - each chip shows the value held, PnL; the tooltip has wallets, entry → now mcap; click Σ to sort by value /
    PnL ◎ / PnL %.

## 3.8.0
- **AG filter on every terminal** (GMGN, Trojan, Axiom), moved here from AG Intel. The backtester tab publishes the
  coins of your filtered Live Terminal; terminal lists then:
  - badge each AG coin on its card (`AG <risk> · <×> from signal`, colored by risk; click opens it on AG),
  - **smart hide** the rest (default): reversible, a coin is back the moment AG matches it; or dim / badges only / off,
  - never hide the coin you are on, and show badges only while the list is stale (backtester closed, or its Live
    Terminal off screen for 15 min).
- Optional: also use the terminal's own **Hide token** (GMGN, Axiom) for coins still unmatched after N minutes. Off by
  default because those hides stay in your account there.
- Footbar **Filter** item (`12✓ 40⊘`), a row in the connection panel, and an `AG ✓` / `not in AG` chip on the coin
  you are on. Settings: ⚙ → AG filter.
- Hidden rows in virtual lists hide their wrapper instead of leaving the layout.

## AG Intel 2.0.0
- Now lives in this repo (`ag-intel.user.js`, auto-updates from here) and runs on the backtester only: its GMGN
  overlay moved to AG Trade Widget 3.8.0 (AG filter), on every terminal.
- Pure logic in one `Core` block (risk / momentum / wallet scores, launch-vs-now deltas, trailing-stop step, socials
  and copycat parsing, GMGN payload picking, safe markdown), unit-tested in Node.
- AI brief providers (Grok, Claude) behind one interface; one GM request helper for every external call.
- Safer: `@connect *` removed (only the hosts it uses), `@noframes`, symbols in the trailing-SL log are escaped.
- Same panel, settings, API keys and trailing stop-loss state as 1.x (nothing to set up again).

## 3.7.0
- **Axiom** (`axiom.trade`) support: the widget, holdings bar, positions and exits on every Axiom page; buy / sell
  on a coin page (`/meme/<pair>`). The URL holds the pair address, so the mint is read from the page's own Solscan /
  pump.fun link (ignoring the previous coin's link for a moment after an in-app navigation). Live mcap from the tab
  title.
- Axiom Pulse cards get the overlay: your position + PnL, ⚡ quick buy, AG risk pill + peek, hide coin.
- Fix: "Open" from a GMGN card (peek / holdings bar) could navigate to `undefined`: GMGN cards are `<div href>`,
  which have no `.href`. It now falls back to the coin URL.

## 3.6.1
- Fix: on Trojan the widget showed up twice. Trojan's TradingView chart is a same-origin iframe whose URL is also
  `/terminal?token=…`, so the script ran inside it too. The script now runs in the top window only (`@noframes` +
  a runtime guard), on every site.
- Trojan: `@match` is `trojan.com` only (no more `*.trojan.com`, which also matched its wallet / login iframes).

## 3.6.0
- **Trojan** (`trojan.com`) support: the widget, holdings bar, positions and exits work on every Trojan page;
  on a token page (`/terminal?token=<mint>`) you can buy / sell, with live mcap from the tab title.
- Trojan Trenches / list cards get the same overlay as GMGN cards: your position + PnL, ⚡ quick buy, AG risk pill
  and hover peek, hide coin (the 28px ticker strip at the top is left alone).
- Site adapters: everything terminal-specific (token from the URL, symbol from the title, card selector, coin URL)
  now lives in `Core.SITES`, unit-tested with real URLs and titles. Adding a terminal = one entry there and one
  `@match` line. GMGN behaviour unchanged.

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
