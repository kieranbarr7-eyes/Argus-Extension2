'use strict';

// ─── Constants ────────────────────────────────────────────────────────────────

const ALARM_NAME          = 'argus-recheck';
const ALARM_INTERVAL_MINS = 2;              // check every 2 minutes
const BACKOFF_MS          = 15 * 60 * 1000; // 15-min quiet period per train
const BG_TAB_TIMEOUT_MS   = 30_000;         // close silent tab after 30 s if no prices

// ─── Background-tab tracking ──────────────────────────────────────────────────
//
// When no Amtrak tab is open, Argus opens one silently, reads prices, then
// closes it.  This Map tracks those tabs (tabId → close-timeout ID) so we
// can close them immediately once prices arrive rather than waiting the full 30 s.
// The Map is in-memory; it resets if the service worker is evicted, but the
// 30 s fallback timeout covers that case.

const pendingBgTabs = new Map();

async function closeTab(tabId) {
  clearTimeout(pendingBgTabs.get(tabId));
  pendingBgTabs.delete(tabId);
  try { await chrome.tabs.remove(tabId); } catch { /* already closed */ }
}

// ─── Install / startup ────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(ALARM_NAME, {
    delayInMinutes: ALARM_INTERVAL_MINS,
    periodInMinutes: ALARM_INTERVAL_MINS,
  });
});

// Re-register alarm if the service worker was evicted and restarted
chrome.alarms.get(ALARM_NAME, (alarm) => {
  if (!alarm) {
    chrome.alarms.create(ALARM_NAME, {
      delayInMinutes: ALARM_INTERVAL_MINS,
      periodInMinutes: ALARM_INTERVAL_MINS,
    });
  }
});

// ─── Message handler ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'PRICES_UPDATE') {
    // Auto-capture the Amtrak results URL so we can reopen it for background polls
    const tabUrl = sender.tab?.url ?? '';
    if (tabUrl.includes('amtrak.com/tickets/departure.html')) {
      chrome.storage.sync.set({ watchUrl: tabUrl }).catch(() => {});
    }
    // Close the silent background tab now that we have prices (don't wait the full 30 s)
    if (sender.tab?.id && pendingBgTabs.has(sender.tab.id)) {
      closeTab(sender.tab.id).catch(() => {});
    }
    handlePricesUpdate(message.prices, message.route).catch(console.error);
    return false; // synchronous, no response needed
  }

  if (message.type === 'GET_STATE') {
    getState()
      .then(sendResponse)
      .catch(() => sendResponse({}));
    return true; // keep the message channel open for the async reply
  }
});

// ─── Alarm handler ───────────────────────────────────────────────────────────

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) {
    triggerContentScripts().catch(console.error);
  }
});

/**
 * Every 2 minutes: push the content script on any open Amtrak tab to report
 * its current prices.  When no Amtrak tab is open, open one silently in the
 * background, let content.js extract prices, then close it automatically.
 *
 * The PRICES_UPDATE message handler closes the silent tab as soon as prices
 * arrive.  A 30 s safety timeout closes it even if no prices come through.
 */
async function triggerContentScripts() {
  // ── 1. Prefer an already-open Amtrak tab ─────────────────────────────────
  let tabs;
  try {
    tabs = await chrome.tabs.query({
      url: 'https://www.amtrak.com/tickets/departure.html*',
    });
  } catch {
    return;
  }

  if (tabs.length > 0) {
    for (const tab of tabs) {
      try {
        await chrome.tabs.sendMessage(tab.id, { type: 'TRIGGER_CHECK' });
      } catch {
        // Content script not loaded — inject it
        try {
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: ['content.js'],
          });
        } catch { /* tab discarded or inaccessible */ }
      }
    }
    return; // open tab found — nothing more to do
  }

  // ── 2. No open tab — open a silent background tab using the stored URL ────
  const { watchUrl, watchEnabled } = await chrome.storage.sync.get({
    watchUrl:     null,
    watchEnabled: false,
  });
  if (!watchUrl || !watchEnabled) return; // no watch URL saved yet, or watching is off

  let tab;
  try {
    // active: false keeps it in the background without stealing focus
    tab = await chrome.tabs.create({ url: watchUrl, active: false });
  } catch {
    return;
  }

  // content.js is injected automatically by the manifest content_scripts rule.
  // It calls checkAndReport() after ~2.5 s (Angular render delay), which sends
  // PRICES_UPDATE back here.  The message handler closes the tab then.
  // Safety fallback: close after 30 s regardless.
  const closeId = setTimeout(() => closeTab(tab.id), BG_TAB_TIMEOUT_MS);
  pendingBgTabs.set(tab.id, closeId);
}

// ─── Route key ───────────────────────────────────────────────────────────────

/**
 * Builds a stable storage key from a route object.
 * e.g. { origin:'NYP', destination:'PHL', date:'03/18/2026' } → "NYP_PHL_03182026"
 */
function makeRouteKey(route) {
  if (!route) return null;
  const { origin = '', destination = '', date = '' } = route;
  if (!origin && !destination) return null;
  const dateStr = date.replace(/[/\-\s]/g, '');
  return `${origin}_${destination}_${dateStr}`.replace(/[^A-Z0-9_]/gi, '').toUpperCase() || null;
}

// ─── Core price-checking logic ────────────────────────────────────────────────

/**
 * Called every time the content script sends a price update.
 *
 * @param {Array<{trainNumber:string, coachPrice:number|null, businessPrice:number|null, departureTime:string|null}>} prices
 * @param {{origin?:string, destination?:string, date?:string}} route
 */
async function handlePricesUpdate(prices, route) {
  const routeKey     = makeRouteKey(route);
  const routeHistKey = routeKey ? `prices_${routeKey}` : null;

  // Persist latest snapshot for the popup regardless of watch state
  await chrome.storage.local.set({
    currentPrices:   prices,
    currentRoute:    route ?? {},
    currentRouteKey: routeKey ?? '',
    lastUpdated:     Date.now(),
  });

  // ── Load all mutable state in one read ───────────────────────────────────
  const loadDefaults = {
    observedRanges:       {},   // { routeKey: { min, max } }  — persistent, never resets
    priceHistory:         {},
    priceOrigins:         {},
    lastAlerts:           {},
    totalSavings:         0,
    lastDrop:             null,
    pendingBookingChecks: {},
    bookedPrices:         {},
    priceJourneys:        {},
  };
  if (routeHistKey) loadDefaults[routeHistKey] = {}; // prices_NYP_PHL_03182026

  const local = await chrome.storage.local.get(loadDefaults);

  const observedRanges = local.observedRanges;
  const priceHistory   = local.priceHistory;
  const priceOrigins   = local.priceOrigins;
  const lastAlerts     = local.lastAlerts;
  const pendingBookingChecks = local.pendingBookingChecks;
  const bookedPrices   = local.bookedPrices;
  const priceJourneys  = local.priceJourneys;
  let totalSavings     = local.totalSavings;
  let lastDrop         = local.lastDrop;
  const routeHistory   = routeHistKey ? local[routeHistKey] : null;

  // ── Persistent observed range keyed by route (Feature 3) ─────────────────
  //
  // Always update the global '__global__' bucket regardless of route detection,
  // so the popup can show a range even when URL params aren't available.
  // Also update the per-route bucket when routeKey is known.
  {
    const globalRR = observedRanges['__global__'] ?? { min: null, max: null };
    const routeRR  = routeKey ? (observedRanges[routeKey] ?? { min: null, max: null }) : null;

    for (const { coachPrice, businessPrice } of prices) {
      for (const p of [coachPrice, businessPrice]) {
        if (p == null) continue;
        if (globalRR.min === null || p < globalRR.min) globalRR.min = p;
        if (globalRR.max === null || p > globalRR.max) globalRR.max = p;
        if (routeRR) {
          if (routeRR.min === null || p < routeRR.min) routeRR.min = p;
          if (routeRR.max === null || p > routeRR.max) routeRR.max = p;
        }
      }
    }

    observedRanges['__global__'] = globalRR;
    if (routeKey && routeRR) observedRanges[routeKey] = routeRR;
  }

  // ── Snapshot prev prices BEFORE mutating history ─────────────────────────
  const prevPrices = {};
  for (const { trainNumber } of prices) {
    for (const label of ['coach', 'business']) {
      const k = `${trainNumber}-${label}`;
      prevPrices[k] = priceHistory[k]; // undefined = first sight
    }
  }

  // ── Update price origins, history, route history, and open journeys ───────
  const now = Date.now();
  for (const { trainNumber, coachPrice, businessPrice } of prices) {
    for (const [price, label] of [[coachPrice, 'coach'], [businessPrice, 'business']]) {
      if (price == null) continue;
      const k = `${trainNumber}-${label}`;
      if (priceOrigins[k] === undefined) priceOrigins[k] = price;
      priceHistory[k] = price;
      if (routeHistory) routeHistory[k] = { price, ts: now };
      if (bookedPrices[k] !== undefined && priceJourneys[k]) {
        priceJourneys[k].final = price;
        priceJourneys[k].saved = priceJourneys[k].original - price;
      }
    }
  }

  // ── Alert checking ────────────────────────────────────────────────────────
  const { threshold, watchEnabled } = await chrome.storage.sync.get({
    threshold: null,
    watchEnabled: false,
  });

  if (watchEnabled && threshold !== null && !isNaN(Number(threshold))) {
    const thresholdNum = Number(threshold);

    function checkFare(trainNumber, price, fareLabel) {
      if (price == null) return;
      const histKey     = `${trainNumber}-${fareLabel.toLowerCase()}`;
      const prevPrice   = prevPrices[histKey];
      const lastAlertAt = lastAlerts[histKey] ?? 0;
      if (price > thresholdNum) return;
      if (now - lastAlertAt < BACKOFF_MS) return;
      const isDropOrNew = prevPrice === undefined || price < prevPrice;
      if (!isDropOrNew) return;

      chrome.notifications.create(`argus-${trainNumber}-${fareLabel.toLowerCase()}-${now}`, {
        type: 'basic',
        iconUrl: 'icons/icon128.png',
        title: 'Argus — Price Drop Detected',
        message:
          `Train ${trainNumber} ${fareLabel} dropped to $${price} — tap to book.\n` +
          `Tip: Book the refundable fare — Argus keeps watching for further drops.`,
        priority: 2,
      });

      lastAlerts[histKey] = now;
      if (prevPrice !== undefined && prevPrice > price) totalSavings += prevPrice - price;
      lastDrop = { trainNumber, price, fareClass: fareLabel, timestamp: now };
      pendingBookingChecks[trainNumber] = { price, fareClass: fareLabel, timestamp: now };
    }

    for (const { trainNumber, coachPrice, businessPrice } of prices) {
      checkFare(trainNumber, coachPrice,    'Coach');
      checkFare(trainNumber, businessPrice, 'Business');
    }
  }

  // ── Persist everything ────────────────────────────────────────────────────
  const toSave = {
    observedRanges,
    priceHistory,
    priceOrigins,
    lastAlerts,
    totalSavings,
    lastDrop,
    pendingBookingChecks,
    priceJourneys,
  };
  if (routeHistKey && routeHistory) toSave[routeHistKey] = routeHistory;
  await chrome.storage.local.set(toSave);
}

// ─── State helper (used by popup) ────────────────────────────────────────────

async function getState() {
  const [sync, local] = await Promise.all([
    chrome.storage.sync.get({ threshold: '', watchEnabled: false, watchUrl: null }),
    chrome.storage.local.get({
      currentPrices:        [],
      currentRoute:         {},
      currentRouteKey:      '',
      lastUpdated:          null,
      totalSavings:         0,
      lastDrop:             null,
      observedRanges:       {},
      pendingBookingChecks: {},
      bookedPrices:         {},
      priceOrigins:         {},
      priceJourneys:        {},
    }),
  ]);

  // Derive the observed range — prefer per-route bucket, fall back to global
  const routeKey      = local.currentRouteKey;
  const observedRange =
    (routeKey && local.observedRanges[routeKey]?.min !== null
      ? local.observedRanges[routeKey]
      : null) ??
    (local.observedRanges['__global__']?.min !== null
      ? local.observedRanges['__global__']
      : null);

  return { ...sync, ...local, observedRange };
}
