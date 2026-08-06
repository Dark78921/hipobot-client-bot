# signal-client-bot

Standalone KuCoin Futures client bot project.

It authenticates to `signal-backend` with a licensed API key, reads trading signals from the gated `GET /client/signals`, and places market orders on KuCoin.

The feed is deliberately strategy-free: each coin arrives as only `{ action, confOk, barTime }`. The bot never receives the internals that produce a signal (trend/extreme scores, confidence, setup type, reason, RSI/ATR, entry price, sizing) — those stay on the backend so the strategy can't be reverse-engineered from a bot running on a customer machine.

## Features

- Separate project directory (`signal-client-bot`)
- **Licensed access:** authenticates with a per-client API key issued from the admin panel; verified for authorization + allowed IP before receiving signals
- **Single-bot lock:** claims a heartbeat session — a second bot started with the same key is refused (double-bot protection)
- **Remote run control:** obeys the `running`/`paused` state set from the admin panel or the customer's My Bot page (paused = no new entries; existing positions are still managed)
- Opens position on actionable signal (`LONG`/`SHORT` with `confOk`)
- **Risk-based sizing:** the backend pushes the effective risk % (a per-bot value the admin sets, else the backend default) in the session/heartbeat response; the bot sizes each order as `equity × risk% / 100` of notional, converted to contracts via the KuCoin contract multiplier + mark price. Falls back to the fixed `KUCOIN_ORDER_SIZE` when balance/spec data is unavailable
- **Balance reporting:** reads the KuCoin futures account overview and reports equity/available in each heartbeat so the admin and My Bot pages can show it
- Closes with `reduceOnly` market orders
- Checks close order status (`filled` / `unfilled` / `partial` / `timeout`)
- Retries close if order is not filled

## Setup

```bash
cd signal-client-bot
npm install
```

Copy env template:

```bash
copy .env.example .env
```

Set your **licensing key** and KuCoin credentials in `.env`:

- `CLIENT_API_KEY` — issued from the admin panel (a client must be created, authorized, and — if IP-restricted — have your IP allowed)
- `KUCOIN_API_KEY`
- `KUCOIN_API_SECRET`
- `KUCOIN_API_PASSPHRASE`

Optional — **allocate your own capital**:

- `TRADING_CAPITAL` — the amount of your wallet (in `KUCOIN_ACCOUNT_CURRENCY`) you want the bot to trade with. When set (>0), the provider's risk % is applied to this amount instead of your full account equity, so you can run the bot on only part of your balance. It's capped at your real equity, so it can never over-allocate. Leave `0`/blank to size off the full account.

## Build a protected distribution (no readable source)

To hand the bot to end customers without shipping `index.js`, build a bundled +
obfuscated artifact — or a standalone Windows binary:

```bash
npm install          # dev tools: esbuild, javascript-obfuscator, @yao-pkg/pkg
npm run build        # → build/bot.obf.js  (obfuscated single file; run with `node build/bot.obf.js`)
npm run build:exe    # → dist/signal-client-bot.exe  (standalone; no Node needed on the client)
```

The customer receives only the `.exe` (or `build/bot.obf.js`) plus their own `.env`
in the same folder. `build/` and `dist/` are git-ignored.

> Note: obfuscation + packaging raises the bar substantially but is not
> unbreakable. The signal **strategy already lives server-side** and is never sent
> to the bot (see the strategy-free `/client/signals` feed); this build protects the
> executor, licensing, and sizing code and deters tampering.

## Run (from source)

Make sure `signal-backend` is running and your client is authorized, then:

```bash
npm start
```

On start the bot claims a session, then heartbeats every `CLIENT_HEARTBEAT_MS`. If the license check fails it stops with a clear reason:

- `API key rejected` — unknown/rotated key
- `IP not allowed` — your IP isn't in the client's allowed list
- `DOUBLE-BOT BLOCKED` — another bot is already running with this key
- `awaiting admin approval` — client not authorized yet (keeps retrying; does not trade until approved)

## Notes

- Default backend URL: `https://provider.hipobot.xyz` (override with `SIGNAL_BACKEND_URL`; use `http://127.0.0.1:3400` for local dev)
- Default KuCoin base URL: `https://api-futures.kucoin.com`
- A stable instance id is stored in `.instance-id` so restarts re-claim the same session instead of tripping the double-bot guard against the bot's own prior session. Delete it (or set `CLIENT_INSTANCE_ID`) to force a fresh identity.
- `paused` (set from the admin/My Bot UI) stops **new** entries; open positions are still closed on signal-invalid / direction-flip.
- Close behavior follows signal invalid / direction flip triggers, then verifies order fill state.
