# Bazaar GUI map (verified live, 1.21.11, SkyBlock v0.26 — July 2026)

Ground truth captured with the `--probe` diagnostic. Item names/lore are shown
**lowercased + color-stripped** (that's how `gui.js` normalises them). Slot numbers
are stable for the layouts below but MATCH BY NAME, not by index — Hypixel shifts
things around.

## Navigating to a product (the corrected flow)

`/bz <item>` does NOT open the product page — it opens a **search view**. The
product is a slot inside it. Full path to the trading interface:

1. `chat('/bz ' + item)` → **search window**, title `bazaar ➜ "<item>"`.
   The product tile is the slot whose name == item, lore ends `click to view details!`
   (a skill-locked item shows `you must have <skill> <n>!` instead and can't be opened).
2. Click that product slot → **product details** window, title `<cat> ➜ <item>`.

## Windows

### Main Bazaar — title `bazaar ➜ <category>`
- `search` — open the search sign
- `sell inventory now` — bulk instasell inventory
- `close`
- `manage orders` — → Your Bazaar Orders (lore: `you don't have any ongoing orders.` when empty)
- `bazaar history`, `bazaar settings`
- category tiles (`farming`, `mining`, …) and product tiles (`<name>` with
  `buy price: N coins` / `sell price: N coins`).

### Product details — title `<category> ➜ <item>`
- `buy instantly` — lore `price per unit: N coins` / `stack price: N coins`
- `sell instantly` — lore `inventory: none!` / `price per unit: N coins`  ← our INSTASELL
- **`create buy order`** — lore holds the BUY-side book:
  `top orders:` then lines `- <price> coins each | <qty>x in <k> orders`
- **`create sell offer`** — lore holds the SELL-side book:
  `top offers:` then lines `- <price> coins each | <qty>x from <k> offers`
- `go back` (to product), `go back` (to bazaar), `manage orders`, `view graphs`,
  `instasell ignore`

### Buy Order amount setup — title `how many do you want?`
- `buy a stack!` (64x), `buy a big stack!` (160x), `buy a thousand!` (1,024x)
- `custom amount` — lore `buy up to <max>x.` / `click to specify!` → opens a **sign** to type qty
- `go back`

### Buy Order price screen — title `how much do you want to pay?`
- `same as top order` — match highest buy order
- `top order +0.1` — beat top order by 0.1 so you fill first (the undercut we want)
- `5% of spread` — info tile (lowest sell / highest buy / spread)
- `custom price` — lore `set the price per unit... minimum 50% of the best order.` → opens a **sign**
- `go back`, `cancel buy order`
- After picking a price → a **Confirm** screen (UNVERIFIED — only reachable by
  committing; capture during a deliberate live micro-order).

### Sell Offer flow (VERIFIED live) — PRICE-FIRST, no amount step
`create sell offer` → **`at what price are you selling?`** directly (it offers what
you hold; there is no "how many" screen like buy has) → pick `custom price` (→ sign)
or a preset → Confirm screen `confirm sell offer`, button named `sell offer`.

### Order Options (click an order in Your Bazaar Orders) — title `order options`
- `cancel order` (slot 11) — one click, no confirm popup (returns to the grid)
- `flip order` (15), `go back` (31)

### Your Bazaar Orders — title `your bazaar orders`
- order tile: name `BUY <item>` / `SELL <item>`, lore `Order amount: Nx` /
  `Price per unit: P coins`; a filled order is `[claimable]` (click to claim).
- `go back` (to bazaar), `claim all coins` (lore `you don't have any coins to claim.` when none)
- order tiles populate the grid (none captured yet — account has 0 open orders)

## S-table corrections needed in mineflayerDriver.js
- `_navigateTo` must click INTO the product tile after `/bz <item>` (currently stops at search).
- BUY_ORDER `'buy order'` → matches `create buy order` via substring (OK), prefer `'create buy order'`.
- SELL_OFFER `'sell offer'` → `create sell offer` (OK via substring).
- INSTASELL `'sell instantly'` — CONFIRMED present on details page.
- CUSTOM_AMOUNT `'custom amount'` — CONFIRMED (amount setup).
- Order-book reading: parse `create buy order` / `create sell offer` lore for live depth.
- CUSTOM_PRICE / CONFIRM / sign-input — still to verify.
