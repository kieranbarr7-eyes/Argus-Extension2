'use strict';

// ─── DOM helpers ───────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);

// ─── App state ─────────────────────────────────────────────────────────────────
let _state       = null;   // last fetched state from background
let _sort        = 'listed';
let _fareFilter  = 'all';  // 'all' | 'coach' | 'business'
let _settingsOpen = false;
let _savingsOpen  = false;
let _checkedTimer = null;

// ─── Utility ───────────────────────────────────────────────────────────────────
function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function relativeTime(ts) {
  if (!ts) return null;
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 8)    return 'just now';
  if (s < 60)   return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

function formatRoute(route) {
  if (!route) return null;
  const { origin = '', destination = '', date = '' } = route;
  const parts = [origin, destination].filter(Boolean);
  if (!parts.length) return null;
  const r = parts.join(' → ');
  return date ? `${r} · ${date}` : r;
}

function formatRouteShort(route) {
  if (!route) return null;
  const { origin = '', destination = '', date = '' } = route;
  if (!origin || !destination) return null;
  // Format date as "Mar 19"
  let dateStr = '';
  if (date) {
    try {
      const [m, d] = date.split('/');
      const dt = new Date(new Date().getFullYear(), parseInt(m) - 1, parseInt(d));
      dateStr = ' · ' + dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    } catch { dateStr = ' · ' + date; }
  }
  return `${origin} → ${destination}${dateStr}`;
}

function isPeakWindow(depTime) {
  if (!depTime) return false;
  const m = depTime.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (!m) return false;
  let h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  const ampm = m[3].toUpperCase();
  if (ampm === 'PM' && h !== 12) h += 12;
  if (ampm === 'AM' && h === 12) h = 0;
  const now = new Date();
  const dep = new Date(now);
  dep.setHours(h, min, 0, 0);
  if (dep <= now) return false;
  return (dep - now) / 3_600_000 <= 2;
}

/**
 * Color temperature for a price vs threshold.
 * Returns 'cool' | 'warm' | 'deal' | 'neutral'
 */
function priceTemp(price, threshold) {
  if (!threshold || threshold <= 0 || price == null) return 'cool';
  if (price <= threshold) return 'deal';
  if (price <= threshold * 1.2) return 'warm';
  return 'cool';
}

// ─── Checked stamp (live relative timer) ───────────────────────────────────────
function startCheckedTimer(ts) {
  clearInterval(_checkedTimer);
  if (!ts) { $('last-checked').textContent = ''; return; }
  const update = () => {
    $('last-checked').textContent = `checked ${relativeTime(ts)}`;
  };
  update();
  _checkedTimer = setInterval(update, 10_000);

  // Pulse the dot if very recent
  const dot = $('check-dot');
  if (Date.now() - ts < 12_000) {
    dot.classList.add('live');
    // pulse status-dot too
    $('status-dot').classList.add('recently-checked');
    setTimeout(() => $('status-dot').classList.remove('recently-checked'), 2_000);
  } else {
    dot.classList.remove('live');
  }
}

// ─── Onboarding ────────────────────────────────────────────────────────────────
$('ob-got-it').addEventListener('click', async () => {
  await chrome.storage.local.set({ onboarded: true });
  $('onboarding').classList.add('hidden');
  $('main').classList.remove('hidden');
  await loadAndRender();
});

// ─── Watch toggle ──────────────────────────────────────────────────────────────
$('watch-toggle').addEventListener('change', async (e) => {
  await chrome.storage.sync.set({ watchEnabled: e.target.checked });
  setStatusDot(e.target.checked);
});

function setStatusDot(active) {
  const dot = $('status-dot');
  dot.className = `status-dot ${active ? 'active' : 'inactive'}`;
}

// ─── Settings expand / collapse (active mode) ──────────────────────────────────
$('btn-settings-expand').addEventListener('click', () => {
  _settingsOpen = !_settingsOpen;
  $('settings-panel').classList.toggle('hidden', !_settingsOpen);
});

// Mark Save button visible when threshold input changes
$('threshold-input').addEventListener('input', () => {
  $('btn-save-settings').classList.remove('hidden');
});

$('btn-save-settings').addEventListener('click', async () => {
  const raw = $('threshold-input').value.trim();
  const val = Number(raw);
  if (!raw || isNaN(val) || val <= 0) { $('threshold-input').focus(); return; }
  await chrome.storage.sync.set({ threshold: val });
  $('btn-save-settings').classList.add('hidden');
  $('btn-save-settings').textContent = 'Saved ✓';
  setTimeout(() => { $('btn-save-settings').textContent = 'Save'; }, 1_500);
  // Update summary text + re-render
  if (_state) {
    _state.threshold = val;
    renderSettingsSummary(_state);
    renderPricesList(_state);
  }
});

$('threshold-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('btn-save-settings').click();
});

// ─── Fare class filter ─────────────────────────────────────────────────────────
$('fare-filter').addEventListener('click', (e) => {
  const btn = e.target.closest('.fare-btn');
  if (!btn) return;
  _fareFilter = btn.dataset.fare;
  document.querySelectorAll('.fare-btn').forEach((b) =>
    b.classList.toggle('active', b.dataset.fare === _fareFilter)
  );
  if (_state) {
    renderSettingsSummary(_state); // update "Watching · $95 · Coach" summary
    renderPricesList(_state);
  }
});

// ─── Sort bar ──────────────────────────────────────────────────────────────────
document.addEventListener('click', (e) => {
  const btn = e.target.closest('.sort-btn');
  if (!btn) return;
  _sort = btn.dataset.sort;
  document.querySelectorAll('.sort-btn').forEach((b) =>
    b.classList.toggle('active', b.dataset.sort === _sort)
  );
  if (_state) renderPricesList(_state);
});

// ─── Savings toggle ────────────────────────────────────────────────────────────
$('savings-toggle').addEventListener('click', () => {
  _savingsOpen = !_savingsOpen;
  $('savings-body').classList.toggle('hidden', !_savingsOpen);
  $('savings-chevron').classList.toggle('open', _savingsOpen);
});

// ─── Share savings ─────────────────────────────────────────────────────────────
$('btn-share').addEventListener('click', async () => {
  const btn = $('btn-share');
  const amount = btn.dataset.amount ?? '0';
  try {
    await navigator.clipboard.writeText(
      `Just saved $${amount} on Amtrak with Argus 👁️ argus.app`
    );
    btn.textContent = 'Copied! ✓';
  } catch {
    btn.textContent = 'Copy failed';
  }
  setTimeout(() => { btn.textContent = 'Share savings 📋'; }, 2_000);
});

// ─── Open Amtrak (idle mode) ────────────────────────────────────────────────────
$('btn-open-amtrak').addEventListener('click', () => {
  const url = (_state?.watchUrl) || 'https://www.amtrak.com';
  chrome.tabs.create({ url });
});

// ─── Edit settings (idle mode) ─────────────────────────────────────────────────
$('btn-edit-settings').addEventListener('click', () => {
  const panel = $('idle-settings');
  const showing = !panel.classList.contains('hidden');
  panel.classList.toggle('hidden', showing);
  if (!showing && _state) {
    $('idle-thresh-input').value = _state.threshold || '';
  }
});

$('idle-cancel-btn').addEventListener('click', () => {
  $('idle-settings').classList.add('hidden');
});

$('idle-save-btn').addEventListener('click', async () => {
  const raw = $('idle-thresh-input').value.trim();
  const val = Number(raw);
  if (!raw || isNaN(val) || val <= 0) { $('idle-thresh-input').focus(); return; }
  await chrome.storage.sync.set({ threshold: val });
  $('idle-settings').classList.add('hidden');
  if (_state) {
    _state.threshold = val;
    renderIdleMode(_state);
  }
});

// ─── Prices list event delegation ──────────────────────────────────────────────
$('prices-list').addEventListener('click', async (e) => {
  // Book Now → open Amtrak in new tab
  const bookBtn = e.target.closest('.btn-book-now');
  if (bookBtn) {
    const url = bookBtn.dataset.url;
    if (url) chrome.tabs.create({ url });
    return;
  }

  // "I booked it" / "Yes, I booked it"
  const bookedBtn = e.target.closest('.btn-booked-it');
  if (!bookedBtn) return;

  const trainNumber = bookedBtn.dataset.train;
  const price       = Number(bookedBtn.dataset.price);
  const fareClass   = bookedBtn.dataset.fare;
  const histKey     = `${trainNumber}-${fareClass.toLowerCase()}`;

  await chrome.storage.sync.set({ threshold: price });
  if ($('threshold-input')) $('threshold-input').value = price;

  const { pendingBookingChecks, bookedPrices, priceOrigins, priceJourneys } =
    await chrome.storage.local.get({
      pendingBookingChecks: {},
      bookedPrices:         {},
      priceOrigins:         {},
      priceJourneys:        {},
    });

  delete pendingBookingChecks[trainNumber];
  bookedPrices[histKey] = price;
  const original = priceOrigins[histKey] ?? price;
  priceJourneys[histKey] = {
    trainNumber, fareClass, original, booked: price, final: price,
    saved: original - price,
  };

  await chrome.storage.local.set({ pendingBookingChecks, bookedPrices, priceJourneys });
  await loadAndRender();
});

// ─── Idle prices list event delegation ─────────────────────────────────────────
$('idle-prices-list').addEventListener('click', (e) => {
  const bookBtn = e.target.closest('.btn-book-now');
  if (bookBtn) {
    const url = bookBtn.dataset.url;
    if (url) chrome.tabs.create({ url });
  }
});

// ─── Renderers ─────────────────────────────────────────────────────────────────

function renderSettingsSummary(state) {
  const { threshold = '', watchEnabled = false } = state;
  const fareLabel = _fareFilter === 'all' ? 'All fares'
                  : _fareFilter === 'coach' ? 'Coach only' : 'Business only';
  const parts = [];
  if (watchEnabled) parts.push('Watching');
  else parts.push('Paused');
  if (threshold) parts.push(`$${threshold}`);
  parts.push(fareLabel);
  $('settings-summary-text').textContent = parts.join(' · ');
}

function renderPricesList(state) {
  const {
    currentPrices        = [],
    threshold            = '',
    bookedPrices         = {},
    pendingBookingChecks = {},
    watchUrl             = null,
    watchEnabled         = false,
  } = state;

  const list     = $('prices-list');
  const thresh   = Number(threshold);
  const bookUrl  = watchUrl || 'https://www.amtrak.com/tickets/departure.html';

  console.log('[Argus] renderPricesList —',
              'prices:', currentPrices.length,
              '| thresh:', thresh,
              '| rawThreshold:', threshold,
              '| watchEnabled:', watchEnabled,
              '| fareFilter:', _fareFilter);

  // Watching paused
  if (!watchEnabled) {
    list.innerHTML =
      `<div class="empty-state">Watching paused — enable the toggle to resume</div>`;
    return;
  }

  if (currentPrices.length === 0) {
    list.innerHTML =
      `<div class="scanning-state">` +
        `<span class="scanning-dot"></span>` +
        `<span>Argus is scanning…</span>` +
      `</div>`;
    return;
  }

  // Filter by fare class
  const filtered = currentPrices.filter((p) => {
    if (_fareFilter === 'coach')    return p.coachPrice    !== null;
    if (_fareFilter === 'business') return p.businessPrice !== null;
    return true;
  });

  if (filtered.length === 0) {
    const label = _fareFilter === 'coach' ? 'Coach' : 'Business';
    list.innerHTML = `<div class="empty-state">No ${label} fares found on this page</div>`;
    return;
  }

  // Sort
  const sorted = filtered.slice().sort((a, b) => {
    if (_sort === 'cheapest') {
      const ap = a.coachPrice ?? a.businessPrice ?? Infinity;
      const bp = b.coachPrice ?? b.businessPrice ?? Infinity;
      return ap - bp;
    }
    return (a.pageIndex ?? 0) - (b.pageIndex ?? 0);
  });

  list.innerHTML = sorted.map(({ trainNumber, routeName, coachPrice, businessPrice, departureTime }, idx) => {
    // Determine alert temperatures
    const coachTemp = priceTemp(coachPrice, thresh);
    const bizTemp   = priceTemp(businessPrice, thresh);
    const isDeal    = coachTemp === 'deal' || bizTemp === 'deal';
    const isWarm    = !isDeal && (coachTemp === 'warm' || bizTemp === 'warm');
    const rowClass  = isDeal ? 'deal' : isWarm ? 'warm' : '';

    // Booking state
    const coachBooked = bookedPrices[`${trainNumber}-coach`];
    const bizBooked   = bookedPrices[`${trainNumber}-business`];
    const bookedAt    = coachBooked ?? bizBooked;
    const isBooked    = bookedAt !== undefined;
    const pending     = pendingBookingChecks[trainNumber];

    // Fare chips
    const chips = [];
    if (coachPrice !== null && (_fareFilter === 'all' || _fareFilter === 'coach')) {
      chips.push(
        `<div class="fare-chip ${priceTemp(coachPrice, thresh)}">` +
          `<span class="fare-chip-label">Coach</span>` +
          `<span class="fare-chip-price">$${coachPrice}</span>` +
        `</div>`
      );
    }
    if (businessPrice !== null && (_fareFilter === 'all' || _fareFilter === 'business')) {
      chips.push(
        `<div class="fare-chip ${priceTemp(businessPrice, thresh)}">` +
          `<span class="fare-chip-label">Business</span>` +
          `<span class="fare-chip-price">$${businessPrice}</span>` +
        `</div>`
      );
    }

    // Departure + peak badge
    const isPeak = isPeakWindow(departureTime);
    const depHtml = departureTime
      ? (isPeak
          ? `<span class="peak-badge">🔥 Peak window</span>`
          : `<span class="train-dep">${esc(departureTime)}</span>`)
      : '';

    // Book actions
    let bookHtml = '';
    if (isDeal && !isBooked) {
      const alertFare  = coachTemp === 'deal' ? 'Coach' : 'Business';
      const alertPrice = coachTemp === 'deal' ? coachPrice : businessPrice;
      bookHtml =
        `<div class="book-row">` +
          `<button class="btn-book-now" data-url="${esc(bookUrl)}">Book Now →</button>` +
          `<button class="btn-booked-it" ` +
            `data-train="${esc(String(trainNumber))}" ` +
            `data-price="${alertPrice}" ` +
            `data-fare="${esc(alertFare)}">I booked it</button>` +
          `<span class="book-hint">Select refundable fare</span>` +
        `</div>`;
    } else if (pending && !isBooked) {
      bookHtml =
        `<div class="pending-prompt">` +
          `<span class="pending-text">Did you book at $${pending.price}?</span>` +
          `<button class="btn-booked-it" ` +
            `data-train="${esc(String(trainNumber))}" ` +
            `data-price="${pending.price}" ` +
            `data-fare="${esc(pending.fareClass)}">Yes, I booked it</button>` +
        `</div>`;
    }

    const stillWatching = isBooked
      ? `<div class="still-watching">Still watching for drops below $${bookedAt}</div>`
      : '';

    return (
      `<div class="price-row ${rowClass}" style="animation-delay:${idx * 50}ms">` +
        `<div class="row-top">` +
          `<div class="train-info">` +
            `<span class="train-number">${esc(String(trainNumber))}</span>` +
            (routeName ? `<span class="train-route">${esc(routeName)}</span>` : '') +
            depHtml +
          `</div>` +
          `<div class="fare-chips">${chips.join('')}</div>` +
        `</div>` +
        bookHtml +
        stillWatching +
      `</div>`
    );
  }).join('');
}

function renderSavings(state) {
  const { totalSavings = 0, priceJourneys = {} } = state;
  const journeys = Object.values(priceJourneys);
  const total    = journeys.reduce((s, j) => s + (j.saved || 0), 0) || totalSavings || 0;

  $('savings-label').textContent = `Total saved: $${total}`;

  const journeysEl = $('savings-journeys');
  if (journeys.length > 0) {
    journeysEl.innerHTML = journeys.map(({ trainNumber, fareClass, original, booked, final: fin, saved }) =>
      `<div class="journey-row">` +
        `<div class="journey-train">Train ${esc(String(trainNumber))} · ${esc(fareClass)}</div>` +
        `<div class="journey-prices">` +
          `<span class="j-orig">$${original}</span> → ` +
          `<span class="j-booked">$${booked}</span> → ` +
          `<span class="j-final">$${fin}</span> ` +
          `<span class="j-saved">— Saved $${saved}</span>` +
        `</div>` +
      `</div>`
    ).join('');
  } else {
    journeysEl.innerHTML = '';
  }

  const shareBtn = $('btn-share');
  if (total > 0) {
    shareBtn.classList.remove('hidden');
    shareBtn.dataset.amount = total;
  } else {
    shareBtn.classList.add('hidden');
  }
}

function renderIdleMode(state) {
  const { currentRoute, currentPrices = [], lastUpdated, threshold, watchUrl } = state;
  const routeStr = formatRoute(currentRoute);

  if (routeStr) {
    $('idle-watching').classList.remove('hidden');
    $('idle-empty').classList.add('hidden');
    $('idle-route').textContent = routeStr;
    $('idle-threshold-display').textContent = threshold ? `Alert below $${threshold}` : 'No threshold set';
    const seen = lastUpdated ? `Last checked ${relativeTime(lastUpdated)}` : '';
    $('idle-last-seen').textContent = seen;
  } else {
    $('idle-watching').classList.add('hidden');
    $('idle-empty').classList.remove('hidden');
  }

  // Last known prices
  const priceWrap = $('idle-prices-wrap');
  if (currentPrices.length > 0) {
    priceWrap.classList.remove('hidden');
    const bookUrl = watchUrl || 'https://www.amtrak.com/tickets/departure.html';
    $('idle-prices-list').innerHTML = currentPrices.slice(0, 8).map(({ trainNumber, routeName, coachPrice, businessPrice }) => {
      const fares = [];
      if (coachPrice !== null)    fares.push(`Coach <strong>$${coachPrice}</strong>`);
      if (businessPrice !== null) fares.push(`Biz <strong>$${businessPrice}</strong>`);
      return (
        `<div class="idle-price-row">` +
          `<span class="idle-price-train">${esc(String(trainNumber))}${routeName ? ` · ${esc(routeName)}` : ''}</span>` +
          `<span class="idle-price-fares">${fares.join(' &nbsp;')}</span>` +
        `</div>`
      );
    }).join('');
  } else {
    priceWrap.classList.add('hidden');
  }
}

function renderActiveMode(state) {
  const { threshold = '', watchEnabled = false, currentRoute, lastUpdated, observedRange } = state;

  // Settings summary + inputs
  $('threshold-input').value = threshold;
  renderSettingsSummary(state);

  // Observed range
  const rangeEl = $('observed-range');
  rangeEl.textContent = (observedRange && observedRange.min !== null)
    ? `Observed: $${observedRange.min} – $${observedRange.max}`
    : 'Observing prices…';

  // Route header
  $('prices-route').textContent = formatRouteShort(currentRoute) || '—';

  // Checked timer
  startCheckedTimer(lastUpdated);

  // Prices
  renderPricesList(state);

  // Savings
  renderSavings(state);
}

// ─── Master render ─────────────────────────────────────────────────────────────
function renderState(state) {
  _state = state;

  const { watchEnabled = false, currentPrices = [], currentRoute, lastUpdated } = state;

  // Watch toggle
  $('watch-toggle').checked = !!watchEnabled;
  setStatusDot(watchEnabled);

  // Active mode = prices were received within the last 5 minutes.
  // This means we are (or very recently were) on an Amtrak results page.
  // Using stored price count alone would show active mode forever from stale data.
  const ACTIVE_MS = 5 * 60 * 1000;
  const isActive  = currentPrices.length > 0
                    && !!lastUpdated
                    && (Date.now() - lastUpdated < ACTIVE_MS);

  console.log('[Argus] renderState — prices:', currentPrices.length,
              '| lastUpdated:', lastUpdated ? Math.round((Date.now() - lastUpdated) / 1000) + 's ago' : 'never',
              '| isActive:', isActive,
              '| threshold:', state.threshold,
              '| watchEnabled:', watchEnabled);

  if (isActive) {
    $('idle-mode').classList.add('hidden');
    $('active-mode').classList.remove('hidden');
    renderActiveMode(state);
  } else {
    $('active-mode').classList.add('hidden');
    $('idle-mode').classList.remove('hidden');
    renderIdleMode(state);
  }
}

// ─── Real-time price updates ────────────────────────────────────────────────────
//
// background.js stores new prices in chrome.storage.local every time the content
// script sends a PRICES_UPDATE message. Listening here means the popup instantly
// reflects new prices without needing a manual refresh or GET_STATE poll.

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.currentPrices || changes.lastUpdated)) {
    loadAndRender().catch(console.error);
  }
});

// ─── Init ──────────────────────────────────────────────────────────────────────
async function loadAndRender() {
  const state = await new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'GET_STATE' }, (resp) => {
      resolve(chrome.runtime.lastError ? {} : (resp ?? {}));
    });
  });
  renderState(state);
}

async function init() {
  const { onboarded } = await chrome.storage.local.get({ onboarded: false });
  if (!onboarded) {
    $('onboarding').classList.remove('hidden');
    $('main').classList.add('hidden');
    return;
  }
  $('onboarding').classList.add('hidden');
  $('main').classList.remove('hidden');
  await loadAndRender();
}

init().catch(console.error);
