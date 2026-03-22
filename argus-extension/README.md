# Argus — Amtrak Price Watcher

> **Argus never blinks.**

A Chrome extension that monitors Amtrak train fares on the search results page and fires a browser notification the moment a price drops below your threshold.  No backend, no accounts — everything is stored locally using Chrome's storage API.

---

## File structure

```
argus-extension/
├── manifest.json          # MV3 extension manifest
├── background.js          # Service worker: stores prices, fires notifications
├── content.js             # Injected into Amtrak search results; extracts fares
├── popup.html             # Extension popup UI
├── popup.js               # Popup logic
├── styles.css             # Deep-navy Argus theme
├── generate-icons.js      # Node.js icon generator (run once, no deps)
├── generate-icons.py      # Python icon generator (same output, no deps)
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

---

## Loading the extension in Chrome (developer mode)

1. Open Chrome and navigate to `chrome://extensions`.
2. Enable **Developer mode** (toggle in the top-right corner).
3. Click **Load unpacked**.
4. Select the `argus-extension/` folder from this project.
5. The Argus eye icon appears in your Chrome toolbar.

> **Tip:** Pin the extension by clicking the puzzle-piece icon in the toolbar and pinning Argus.

---

## How to use

### 1 — Search for a train on Amtrak

Go to [amtrak.com](https://www.amtrak.com) and search for any route.  You will land on a URL like:

```
https://www.amtrak.com/tickets/departure.html#origin=NYP&destination=WAS&...
```

Argus automatically activates on this page and begins reading prices.

### 2 — Set your threshold

Click the Argus icon in the toolbar to open the popup:

- Enter a **price threshold** in the `$` input field (e.g. `50`).
- Click **Save**.

Argus will alert you whenever any train on the page drops to or below that dollar amount.

### 3 — Enable watching

Flip the **Watching** toggle to the on position.  The status dot in the top-right turns electric blue with a pulsing glow.

### 4 — Wait for alerts

- While you have an Amtrak search tab open, Argus re-reads prices every **60 seconds** using a `MutationObserver` and a periodic interval.
- The background service worker uses a Chrome alarm to poke open Amtrak tabs every minute even when the popup is closed.
- When a price drops below your threshold, you'll receive a **browser notification**:

  > **Argus — Price Drop Detected**
  > Train 95 dropped to $48 — tap to book

- Argus enforces a **15-minute quiet period** per train to prevent spam.

### 5 — Track your savings

Every time Argus catches a downward price move, it calculates the delta from the last known price and adds it to **Total savings tracked**, visible in the popup.

---

## How to test it locally

### Quick smoke test (no real Amtrak page needed)

1. Load the extension in Chrome (see above).
2. Open any webpage and navigate to `chrome://extensions`.
3. Click **Service Worker** next to Argus to open DevTools for `background.js`.
4. In the DevTools console, paste:

```js
chrome.runtime.sendMessage({
  type: 'PRICES_UPDATE',
  prices: [
    { trainNumber: '95', price: 45 },
    { trainNumber: '97', price: 62 },
  ],
  route: { origin: 'NYP', destination: 'WAS' },
});
```

5. Open the extension popup — you should see Train 95 and 97 listed with their prices.
6. Set your threshold to `50` and enable watching, then re-run the message above.  Train 95 ($45) is below threshold; a browser notification should fire.

### End-to-end test on the real Amtrak site

1. Go to `https://www.amtrak.com` and search for any route (e.g. New York → Washington).
2. On the results page, right-click → **Inspect** → **Console** tab.
3. Verify Argus' content script is running:

```js
window.__argusInitialized   // should log: true
```

4. Open the Argus popup — prices should appear within a few seconds of the Angular app finishing its render.

### Checking storage state

In the background service worker DevTools console:

```js
// Sync storage (threshold, watch toggle)
chrome.storage.sync.get(null, console.log);

// Local storage (price history, last drop, savings)
chrome.storage.local.get(null, console.log);
```

### Clearing all state

```js
chrome.storage.sync.clear();
chrome.storage.local.clear();
```

---

## Regenerating icons

**Python (recommended — no dependencies):**

```bash
cd argus-extension
python generate-icons.py
```

**Node.js (if available — no dependencies):**

```bash
cd argus-extension
node generate-icons.js
```

Both scripts write `icons/icon16.png`, `icons/icon48.png`, and `icons/icon128.png` — a navy circle with an anti-aliased white eye and a blue pupil.

---

## Architecture notes

| File | Role |
|------|------|
| `content.js` | Injected into `departure.html`. Uses `MutationObserver` to wait for Angular to render, then extracts fares via three selector strategies (Angular component → CSS class → text-node scan). Reports every 60 s. |
| `background.js` | MV3 service worker. Receives price updates, persists them to `chrome.storage.local`, compares against the user threshold in `chrome.storage.sync`, and fires `chrome.notifications` on drops. A `chrome.alarms` alarm pings open Amtrak tabs every minute. |
| `popup.{html,js,css}` | Reads state from the background worker via a `GET_STATE` message. All UI updates happen on popup open — no persistent socket. |

---

## Limitations & future ideas

- **Angular selector fragility** — Amtrak can change CSS class names at any time. The three-strategy fallback in `content.js` is robust but not invincible.  If prices stop appearing, inspect the page and update the selectors.
- **Threshold is global** — one threshold applies to all trains on the page. A per-train threshold would be a natural next step.
- **No history chart** — price history is stored but not visualised. A simple sparkline in the popup would be nice.
- **Mobile push** — browser notifications only fire while Chrome is open.  A lightweight backend + Web Push would allow phone alerts.
