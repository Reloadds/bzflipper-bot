# Hypixel 1.21.11 connection — FINDINGS

## Environment (all LATEST as of 2026-07)
- mineflayer 4.37.1 (latest), minecraft-protocol 1.66.2 (latest), minecraft-data 3.111.0 (latest), prismarine-chunk 1.40.0
- `minecraft-data('1.21.11')` → present. protocol **774**, dataVersion 4671. supportedVersions includes 1.21.11.
- Node 24 on the dev box (bot runs on user's Windows machine).
- Account: `itz_Beluga` (email audaus12435u12@outlook.com), Microsoft auth. Reaches Hypixel Limbo (seen in-game), so account is valid/known to Hypixel.

## Observed failure modes
### A) DIRECT to mc.hypixel.net, version 1.21.11
- Trace: set_protocol → login_start → encryption_begin ↔ → compress → **login success** → login_acknowledged (we send) → we manually send `brand` + `settings` → `state login→configuration` → **socketClosed (hadError=false)**, no `<< configuration` packets from server.
- mineflayer `login`/`spawn` never fire. Account lingers online briefly (server waiting).
- = dies IN the configuration phase, server closes. Matches mineflayer#3775 family.

### B) Via ViaProxy (bot speaks 1.8.9 or 1.20.1 → ViaProxy → Hypixel 1.21.11)
- Bot: set_protocol → login_start → compress → login success → `state login→play` → **socketClosed at ~15.5s** (consistent 15.5s for 1.8.9 AND 1.20.1).
- mineflayer `login`/`spawn` NEVER fire. No chat/kick message. hadError=false.
- ViaProxy log: `[SESSION] Connected successfully! Switching to PLAY state` → 15s later `[DISCONNECT] Connection closed` (no reason).
- ViaProxy toggles tried: `ignore-protocol-translation-errors: true`, `fake-accept-resource-packs: true` → NO CHANGE.
- **15.5s + never spawns = classic KeepAlive-timeout signature: read loop likely died on an early PLAY packet.** ← NOT YET CONFIRMED (need packet trace + error capture).

## Hypotheses
| # | Hypothesis | Status |
|---|---|---|
| 1 | Config-phase settings/brand not sent (dropped in ~short timeout) | DIRECT: we DO send them manually, still dies. PROXY (pre-1.20.2): no config phase, N/A. |
| 2 | **Deserialize error kills read loop → KeepAlive stops → 15s timeout** | **LEADING. Not yet captured. Need last-packet-before-death + thrown error.** |
| 3 | Stale/partial 1.21.11 prismarine data | Ruled out at version level (all latest, data present). Could still be buggy 1.21.11 translation. |
| 4 | Anti-bot / Limbo | Reaches Limbo; account joined normally? (assume yes — it's the user's alt). |
| 5 | Secure chat / session | Not observed. |

## Next test
Instrumented `diag.js` on the PROXY path: full packet trace + keep_alive arrival/echo + thrown-error capture + heartbeat. Determine the LAST packet before the read loop stalls and whether an error is thrown. (User runs; I read the diag-*.log.)
