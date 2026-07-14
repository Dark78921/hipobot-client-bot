# signal-client-bot

Standalone KuCoin Futures client bot project.

It authenticates to `signal-backend` with a licensed API key, reads trading signals from the gated `GET /client/signals`, and places market orders on KuCoin.

## Features

- Separate project directory (`signal-client-bot`)
- **Licensed access:** authenticates with a per-client API key issued from the admin panel; verified for authorization + allowed IP before receiving signals
- **Single-bot lock:** claims a heartbeat session — a second bot started with the same key is refused (double-bot protection)
- **Remote run control:** obeys the `running`/`paused` state set from the admin panel or the customer's My Bot page (paused = no new entries; existing positions are still managed)
- Opens position on actionable signal (`LONG`/`SHORT` with `confOk`)
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

## Run

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

- Default backend URL: `http://127.0.0.1:3400`
- Default KuCoin base URL: `https://api-futures.kucoin.com`
- A stable instance id is stored in `.instance-id` so restarts re-claim the same session instead of tripping the double-bot guard against the bot's own prior session. Delete it (or set `CLIENT_INSTANCE_ID`) to force a fresh identity.
- `paused` (set from the admin/My Bot UI) stops **new** entries; open positions are still closed on signal-invalid / direction-flip.
- Close behavior follows signal invalid / direction flip triggers, then verifies order fill state.
