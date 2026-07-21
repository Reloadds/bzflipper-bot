# Importable config

Two JSON files let you drive the bot with MBF-style configs — either by **file**
(drop them here) or **live** from the dashboard's **Import config** panel
(http://localhost:3000).

- **`settings.json`** — trading gates (profit %, price bounds, order slots, volume,
  purse limits). Copy `settings.example.json` → `settings.json` and edit.
- **`filters.json`** — `blacklist` (never trade these) + `whitelist` (per-item
  overrides) + optional `selectiveBuys`. Copy `filters.example.json` → `filters.json`.

Blacklist/whitelist use **Bazaar product IDs** (e.g. `ENCHANTED_COAL`,
`SUSPICIOUS_SCRAP`, `PRECURSOR_GEAR`), which match the bot's internal item tags
exactly.

## How the fields map

| Import field | Bot behaviour |
|---|---|
| `profit.minPercentage` | minimum net margin % to trade an item |
| `profit.min` / `profit.max` | per-order expected-profit floor / manipulation ceiling (coins) |
| `price.maxPricePerUnitBuy` / `minPricePerUnitBuy` | skip items whose top buy order is above / below this |
| `price.maxPricePerUnitSell` | skip items whose lowest sell offer is above this |
| `price.manipulationTriggerPercentage` | lone-outlier top-of-book spoof guard |
| `price.temporaryBlacklistDuration` | minutes a benched item stays benched |
| `orders.maxBuyOrders` | number of concurrent order slots |
| `volume.minBuy` / `minSell` | min hourly volume feeding our buy / sell leg |
| `purse.minPurse` | coins kept in reserve (never spent) |
| `purse.maxSpentPerOrder` | hard cap on coins per single order |
| `selectiveBuys` (bool) | true = only trade whitelisted items |
| `webhook`, `webpage.settings.port/password` | Discord alerts, dashboard port/password |
| `blacklist[]` | product IDs never traded |
| `whitelist{ ID: {minProfit, minPercentage, maxBuyOrder} }` | per-item gate overrides |

Ignored (this bot authenticates + connects via `config.json`): `key`, `username`,
`friendlyKeys`, `proxy`. `orders.sortBy` is always `coinsPerHour`.

Live imports persist into `config.json` **and** are mirrored back here as
`settings.json` / `filters.json`, so they survive a restart. Those two live files
are git-ignored (they may hold your webhook/password); only the `*.example.json`
are committed.
