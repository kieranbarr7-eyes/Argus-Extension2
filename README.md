# 👁️ Argus — Amtrak Price Watcher
> Argus never blinks.

A Chrome extension that monitors Amtrak ticket prices in real time and alerts you the moment fares drop below your target price. Built after discovering a pricing pattern on the Northeast Corridor that most travelers never notice.

---

## The Story

Traveling regularly between New York Penn Station and Philadelphia, I noticed something most Amtrak riders don't know: ticket prices drop significantly in the final 1-2 hours before departure. Last minute refunds, no-shows, and Amtrak's desire to fill every seat create brief windows where prices fall dramatically — sometimes from $188 down to $10.

I used to refresh the Amtrak app obsessively in that window, always buying the refundable fare so I could rebook cheaper if the price dropped again. It worked, but it was tedious. I had friends making the exact same NY-PHL commute every week paying full price every time because they simply didn't know this window existed.

Argus automates the entire process. It watches so you don't have to.

---

## How It Works

1. Install Argus and search for your train on Amtrak.com
2. Argus activates automatically and reads all train prices from the page
3. Set your target price threshold
4. Argus monitors prices every 90 seconds — even in the background with the tab closed
5. When a price drops below your threshold you get an instant browser notification
6. One click takes you straight to booking

**The secret weapon:** Always select the refundable fare. If the price drops again after you book, buy the cheaper ticket and cancel the first one. Argus keeps watching even after you book so you never miss a further drop.

---

## Features

- **Real time price monitoring** — reads live Amtrak fares directly from your own browser session
- **Color temperature system** — blue means not a deal yet, amber means getting close, green means book now
- **Background polling** — monitors prices every 90 seconds even when the Amtrak tab is closed
- **Coach and Business class tracking** — see both fare types at a glance with labeled chips
- **Peak drop window indicator** — highlights trains departing within 2 hours when last minute drops are most likely
- **Book Now button** — appears instantly when a price hits your threshold, takes you straight to booking
- **Refundable fare reminder** — reminds you every single time to select the refundable option
- **Savings tracker** — logs every dollar saved across all trips with full price journey breakdown
- **Idle mode** — shows last known prices and Open Amtrak button when you're not on the results page
- **Fare class filter** — toggle between All, Coach, and Business

---

## Installation

Argus is not yet on the Chrome Web Store. Install it manually in developer mode:

1. Download or clone this repository
2. Open Chrome and go to `chrome://extensions`
3. Enable **Developer mode** in the top right
4. Click **Load unpacked**
5. Select the `argus-extension` folder
6. Pin Argus to your toolbar by clicking the puzzle piece icon

---

## Usage

1. Go to **amtrak.com** and search for your route
2. Let the results load — Argus activates automatically
3. Click the Argus eye icon in your toolbar
4. Set your price threshold and select your fare class
5. Argus watches in the background and notifies you the moment prices drop

---

## Tech Stack

### Current — Chrome Extension (v2)

- **Chrome Extension Manifest V3**
- **Vanilla JavaScript** — no framework, zero dependencies
- **MutationObserver** — waits for Amtrak's Angular 18 app to finish rendering before reading prices, re-triggers automatically when new trains load on scroll
- **chrome.alarms** — background polling every 90 seconds with ±15 second random jitter
- **chrome.storage.sync / local** — persistent price history, settings, and route data across sessions
- **chrome.notifications** — instant browser alerts on price drops with 15 minute backoff
- **chrome.tabs** — silently opens and closes background Amtrak tabs for monitoring when no tab is active

### Original — Python Scraper (v1 — deprecated after architectural pivot)

- **Python 3.11**
- **Playwright** — headless Chromium automation for navigating Amtrak's Angular 18 SPA
- **playwright-stealth** — bot detection evasion, patching `navigator.webdriver`, Chrome runtime signals, and user agent fingerprints
- **APScheduler** — background polling scheduler with random jitter intervals
- **SQLite** — local price history storage with timestamped entries
- **Twilio** — SMS price drop alerts via Python SDK
- **Telegram Bot API** — push notification alerts
- **requests** — direct HTTP interception against Amtrak's internal API endpoints
- **smtplib** — email alerts via Gmail SMTP

---

## The Engineering Journey

This project went through two complete architectural phases before reaching the current extension.

### Phase 1 — Python Scraper

The original approach used Playwright to automate Amtrak's booking form and intercept API responses. This required reverse engineering Amtrak's entire Angular 18 front end from scratch:

- **Identified the real booking component** — Amtrak's SPA uses `amt-md-farefinder` as the actual fare finder component, not the decoy `book-now` tag that appears in the initial HTML. The `book-now` component renders empty `<!---->` on load because its `*ngIf` never fires at the default viewport width — only `1920x1080` triggers the desktop layout
- **Solved the form validation problem** — Amtrak's reactive form requires specific Angular events to register valid state. The date field is `readonly` and requires clicking a calendar picker then dispatching both `input` and `change` events manually via `page.evaluate()` to trigger `ControlValueAccessor`. Station autocomplete required a three-strategy fallback system (ArrowDown+Enter, JavaScript DOM click, visible listbox click) because `aria-activedescendant` never populated
- **Cracked station autocomplete** — built a `STATION_NAMES` dictionary mapping Amtrak codes to full search names since the autocomplete XHR only fires for full station names not codes. Destination selection required `wait_for_xhr=False` to avoid a closure capture bug in the response listener
- **Discovered the fare API endpoint** — intercepted `https://www.amtrak.com/dotcom/journey-solution-option` as Amtrak's internal fare API by logging all network responses after the FIND TRAINS button click
- **Hit reCAPTCHA Enterprise** — the fare endpoint returned 403 Forbidden. Applied `playwright-stealth` to patch bot signals but Google reCAPTCHA Enterprise scoring the headless session was the final blocker

### Phase 2 — Architectural Pivot

The scraper hit two walls simultaneously — reCAPTCHA Enterprise blocking the API, and Amtrak's Terms of Service prohibiting automated access. At commercial scale this creates real legal exposure under the CFAA.

The pivot to a Chrome extension solved both problems cleanly. A real user browsing their own Amtrak session is invisible to bot detection because it is a real user. No scraping, no automated requests, no Terms of Service issues. The hard-won knowledge of Amtrak's DOM structure — the `.train-name` selector, the `.select-train` card container, the `amt-md-farefinder` component — transferred directly into the extension's content script.

---

## Roadmap

- [ ] Chrome Web Store submission
- [ ] Smart threshold recommendations based on aggregated price history
- [ ] Mobile app with WebView for last minute platform hunting
- [ ] SMS alerts via Twilio
- [ ] Backend with user accounts and cross-device sync
- [ ] B2B enterprise version for corporate travel managers
- [ ] Probability indicator showing likelihood of hitting target price

---

## Legal

Argus is an independent tool and is not affiliated with Amtrak. It reads publicly visible prices from the user's own browser session and does not make automated requests to Amtrak's servers.

---

*Built by Kieran Barr 
