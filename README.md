# bzflipper-bot — headless Bazaar flipper (Mineflayer)

A **fully headless** Hypixel SkyBlock Bazaar flipper. It logs a Mineflayer bot
into Hypixel, and drives the same decision brain as the
[Fabric mod](https://github.com/Reloadds/bzflipper) — ranking, two-sided capital
velocity, sizing, undercut/relist — but with no game client rendering.

The pure brain (price math, API + ranking, the state machine) is the tested core
from [bzflipper-headless](https://github.com/Reloadds/bzflipper-headless), vendored
into `src/`. This repo adds the **Mineflayer driver** that implements the game
actions against a live `bot`.

> ⚠️ **Read this.** Automating the Bazaar breaks Hypixel's rules (Rule #4,
> exploiting) and **a headless bot is the most detectable form** — no legit-client
> fingerprint, no rendering, pure behavioral signature. Watchdog hunts exactly
> this. **Use a throwaway alt you don't care about.** This is a learning project.

## Two modes

| Mode | `dryRun` | What it does | Risk |
|---|---|---|---|
| **OBSERVE** *(default)* | `true` | Logs in, gets on SkyBlock, reads your purse / cookie / open orders, fetches the live Bazaar and prints the ranked flips. **Places nothing.** | Read-only. Safe study. Start here. |
| **LIVE** | `false` | Runs the state machine — places, claims, relists, and cancels **real orders with real coins**. | Real automation. Ban risk. |

## Setup

```bash
git clone https://github.com/Reloadds/bzflipper-bot
cd bzflipper-bot
npm install                 # pulls mineflayer
cp config.example.json config.json
# edit config.json — set "username" to your Microsoft email, leave dryRun: true
npm start
```

**First run auth:** with `"auth": "microsoft"`, Mineflayer prints a
**device-code link + code** to the console. Open the link, sign in with the alt's
Microsoft account, enter the code. The token is cached, so you only do this once.

## What you'll see in OBSERVE mode

Every ~15s:

```
── 14:32:07 · purse 104.10M · cookie 38h · api 3s · orders 7
  TOP FLIPS (coins/hr):
    1. Enchanted Redstone          2.14M/hr  m13.7%  vel 687u/hr
    2. Sphinx Shard                1.98M/hr  m8.2%   vel 41k/hr
    ...
  OPEN ORDERS:
    SELL Enchanted Redstone   3.1  × 8202   64% [claim]
    BUY  Whale Bait           1.2  × 26880  0%
```

That proves the whole chain works headless: login → SkyBlock → Bazaar read →
ranking. **This is what to verify first.**

## Going live (only after OBSERVE looks right)

Set `"dryRun": false` in `config.json`. The state machine then trades.

**Heads-up — the write path needs a live tuning pass.** The order-placing
sequences (buy/sell/claim/cancel and especially the **sign inputs** for custom
amount/price) depend on Hypixel's exact GUI text and the sign-edit packet for your
protocol version. Every such string is centralized in `src/mineflayerDriver.js`
(the `S = {…}` table) and marked `TUNE:` where it needs confirming against the real
GUIs. Expect to adjust these once while watching OBSERVE output before live works
cleanly. Cookie auto-refresh is **not yet wired headless** — keep a buff active
manually (or `cookieRefreshEnabled: false`, the default).

## Config (`config.json`)

- `username` — your Microsoft **email** (not the gamertag), `auth: "microsoft"`.
- `version` — protocol to connect with. `"1.21"` is well-supported by Mineflayer
  and accepted by Hypixel via ViaVersion. If login fails on version, try another
  supported one (see notes below).
- `warpCommand` — how to reach SkyBlock after login (default `skyblock`).
- `dryRun` — **`true` = observe (safe), `false` = live trading.**
- `strategy` — the brain knobs (order slots, margins, sizing, volume floors …),
  same meaning as the mod's config.

## Known caveats (be realistic)

- **Version support.** Mineflayer needs `minecraft-data` to support the protocol
  you connect with. `1.21` is safe today; the very latest MC may not be. Hypixel
  accepts a wide range via ViaVersion, so pin `version` to a supported one.
- **Hypixel login hurdles.** Hypixel sometimes gates non-vanilla clients; if the
  bot connects but can't reach SkyBlock, join once manually on that account first.
- **The GUI write path is unverified** (see "Going live"). OBSERVE is the tested
  surface; live trading is a scaffold you finish by tuning the `S` strings.
- This can get the account **banned**. Throwaway alt only.

## Roadmap

- [x] Brain + state machine (vendored, tested — 14/14).
- [x] Mineflayer driver: reads (purse/cookie/orders) + OBSERVE mode.
- [ ] Tune the write sequences (sign input, confirm slots) against live GUIs.
- [ ] Port the hardened cookie-consume flow to headless.
- [ ] `prismarine-viewer` hook to watch bring-up.

## License

MIT.
