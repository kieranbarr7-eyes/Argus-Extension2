/**
 * Argus — content script
 * Runs on https://www.amtrak.com/tickets/departure.html*
 *
 * Waits for Angular to finish rendering, then reads every coach and
 * business-class fare with its train number and departure time.
 * Sends data to the background service worker every 60 s, and immediately
 * when new results appear (e.g. the user scrolls and Angular loads more trains).
 */
(function () {
  'use strict';

  if (window.__argusInitialized) return;
  window.__argusInitialized = true;

  const REPORT_INTERVAL = 60_000; // ms between price reports
  let lastReport        = 0;
  let lastKnownCount    = 0;      // tracks how many trains were found last scan
  let _debugLogged      = false;  // log first card HTML only once

  // ─── Card-container selector (hoisted so MutationObserver can reuse it) ─────
  //
  // Amtrak's Angular app renders each train as a component/element matching
  // one of these selectors.  We try the most specific first.

  const CARD_SEL =
    '.select-train,' +                      // confirmed Amtrak card class
    'amt-train-list-item,amt-train-card,' +
    '[class*="result-row"],[class*="train-result"],[class*="train-card"],' +
    '[class*="departure-result"],[class*="search-result-item"],' +
    '[class*="availability-list-item"],[class*="train-row"]';

  // ─── Route extraction ───────────────────────────────────────────────────────
  //
  // Amtrak encodes the route in EITHER query params or the hash fragment:
  //   ?org=NYP&dst=PHL&df=03/18/2026   (newer URL scheme)
  //   #origin=NYP&destination=WAS&...  (older hash scheme)

  function extractRoute() {
    const search = new URLSearchParams(window.location.search);
    const hash   = new URLSearchParams(
      decodeURIComponent(window.location.hash.replace(/^#/, ''))
    );

    function get(...keys) {
      for (const k of keys) {
        const v = search.get(k) ?? hash.get(k);
        if (v) return v.trim().toUpperCase();
      }
      return '';
    }
    function getRaw(...keys) {
      for (const k of keys) {
        const v = search.get(k) ?? hash.get(k);
        if (v) return v.trim();
      }
      return '';
    }

    return {
      origin:      get('org', 'origin', 'fromStation', 'o', 'from'),
      destination: get('dst', 'destination', 'destinationCity', 'd', 'to'),
      date:        getRaw('df', 'departureDate', 'date', 'travelDate'),
    };
  }

  // ─── Train info lookup ──────────────────────────────────────────────────────
  //
  // Returns { number: '197', routeName: 'Northeast Regional' } or null.
  //
  // Primary source: `.train-name` element whose text is "197 Northeast Regional".
  //   First whitespace-delimited token  → train number
  //   Remaining tokens                  → route name
  //
  // Fallbacks (in priority order):
  //   1. .train-name class (confirmed Amtrak selector)
  //   2. amt-auto-test-id attributes (Angular test hooks)
  //   3. Other class-based train-number elements
  //   4. "Train NNN" text anywhere in node
  //   5. data-* attributes on node or descendants
  //   6. aria-label
  //
  // `probe(node)` searches WITHIN node (good for card-level calls).
  // After probing root we walk UP the DOM for price-element-level calls.

  function findTrainInfo(root) {
    function probe(node) {
      if (!node || node === document.body) return null;

      // 1. .train-name — confirmed Amtrak class: "197 Northeast Regional"
      const trainNameEl = node.querySelector('.train-name');
      if (trainNameEl) {
        const text   = (trainNameEl.textContent ?? '').trim();
        const tokens = text.split(/\s+/);
        if (tokens.length > 0 && /^\d{1,4}$/.test(tokens[0])) {
          return {
            number:    tokens[0],
            routeName: tokens.slice(1).join(' ') || null,
          };
        }
      }

      // 2. amt-auto-test-id (Amtrak Angular testing attributes — stable identifiers)
      const amtAutoEl = node.querySelector(
        '[amt-auto-test-id*="train-number"],[amt-auto-test-id*="trainNumber"],' +
        '[amt-auto-test-id*="train-num"],[amt-auto-test-id*="train-name"],' +
        '[amt-auto-test-id*="service-number"],[amt-auto-test-id*="departure-number"],' +
        '[amt-auto-test-id="train"],[amt-auto-test-id*="trainId"]'
      );
      if (amtAutoEl) {
        const text   = (amtAutoEl.textContent ?? '').trim();
        const tokens = text.split(/\s+/);
        if (tokens.length > 0 && /^\d{1,4}$/.test(tokens[0])) {
          return { number: tokens[0], routeName: tokens.slice(1).join(' ') || null };
        }
        // "Train 161 - Northeast Regional"
        const m = text.match(/\bTrain\s+#?(\d{1,4})\b(?:\s*[-–]\s*(.+))?/i);
        if (m) return { number: m[1], routeName: m[2]?.trim() || null };
      }

      // 3. Other class-based dedicated train-number elements
      const trainNumEl = node.querySelector(
        '[class*="train-number"],[class*="trainNumber"],' +
        '[class*="train-num"],[class*="trainNum"],' +
        '[class*="departure-number"],[class*="departurenumber"],' +
        '[class*="service-number"],[class*="servicenumber"]'
      );
      if (trainNumEl) {
        const text   = (trainNumEl.textContent ?? '').trim();
        const tokens = text.split(/\s+/);
        if (tokens.length > 0 && /^\d{1,4}$/.test(tokens[0])) {
          return { number: tokens[0], routeName: tokens.slice(1).join(' ') || null };
        }
      }

      // 4. "Train NNN" anywhere in the node's full text content
      const byLabel = (node.textContent ?? '').match(/\bTrain\s+#?\s*(\d{1,4})\b/i);
      if (byLabel) return { number: byLabel[1], routeName: null };

      // 5a. data-* attributes on this node itself
      for (const key of ['trainNumber', 'trainno', 'train', 'trainId', 'serviceNumber']) {
        const v = (node.dataset?.[key] ?? '').trim();
        if (/^\d{1,4}$/.test(v)) return { number: v, routeName: null };
      }
      for (const attr of ['data-train-number', 'data-train-no', 'data-train-id', 'data-service-number']) {
        const v = (node.getAttribute(attr) ?? '').trim();
        if (/^\d{1,4}$/.test(v)) return { number: v, routeName: null };
      }

      // 5b. data-* on any descendant
      const attrEl = node.querySelector(
        '[data-train-number],[data-trainno],[data-train],[data-train-id],[data-service-number]'
      );
      if (attrEl) {
        const v =
          attrEl.dataset.trainNumber   ??
          attrEl.dataset.trainno       ??
          attrEl.dataset.train         ??
          attrEl.dataset.trainId       ??
          attrEl.dataset.serviceNumber ??
          '';
        if (/^\d{1,4}$/.test(v.trim())) return { number: v.trim(), routeName: null };
      }

      // 6. aria-label on this node
      const byAria = (node.getAttribute('aria-label') ?? '')
        .match(/(?:Train|train)\s+#?\s*(\d{1,4})\b/);
      if (byAria) return { number: byAria[1], routeName: null };

      return null;
    }

    // First pass — search within root itself (card-level calls)
    const hit = probe(root);
    if (hit) return hit;

    // Second pass — walk up the DOM (price-element-level calls)
    let node = root.parentElement;
    for (let depth = 0; depth < 15; depth++) {
      if (!node || node === document.body) break;
      const hit2 = probe(node);
      if (hit2) return hit2;
      node = node.parentElement;
    }

    return null;
  }

  // Convenience wrapper — returns just the number string (for keying the map)
  function findTrainNumber(el) {
    return findTrainInfo(el)?.number ?? null;
  }

  // ─── Fare-class detection ───────────────────────────────────────────────────

  function findFareClass(el) {
    let node = el;
    for (let depth = 0; depth < 10; depth++) {
      if (!node || node === document.body) break;

      const cls   = (typeof node.className === 'string' ? node.className : '').toLowerCase();
      const aria  = (node.getAttribute('aria-label')     ?? '').toLowerCase();
      const fare  = (node.getAttribute('data-fare-type') ?? node.getAttribute('data-class') ?? '').toLowerCase();
      const amtId = (node.getAttribute('amt-auto-test-id') ?? '').toLowerCase();

      if (/\bbusiness\b/.test(cls)   || /\bbusiness\b/.test(aria) ||
          /\bbusiness\b/.test(fare)  || /\bbusiness\b/.test(amtId)) return 'business';
      if (/\bcoach\b/.test(cls)      || /\bcoach\b/.test(aria) ||
          /\bcoach\b/.test(fare)     || /\bcoach\b/.test(amtId))    return 'coach';

      if (node.parentElement) {
        for (const sib of node.parentElement.children) {
          if (sib === node) continue;
          const t = (sib.textContent ?? '').trim().toLowerCase();
          if (t === 'business' || t === 'business class' || t === 'acela business') return 'business';
          if (t === 'coach'    || t === 'coach class')                               return 'coach';
        }
      }

      node = node.parentElement;
    }
    return null;
  }

  // ─── Departure-time extraction ──────────────────────────────────────────────

  function findDepartureTime(el) {
    let node = el;
    for (let depth = 0; depth < 12; depth++) {
      if (!node || node === document.body) break;

      // amt-auto-test-id for departure time
      const amtTimeEl = node.querySelector(
        '[amt-auto-test-id*="depart-time"],[amt-auto-test-id*="departureTime"],' +
        '[amt-auto-test-id*="departure-time"],[amt-auto-test-id*="origin-time"],' +
        '[amt-auto-test-id*="departTime"]'
      );
      if (amtTimeEl) {
        const raw = (amtTimeEl.getAttribute('datetime') ?? amtTimeEl.textContent ?? '').trim();
        const m   = raw.match(/\b(\d{1,2}:\d{2}\s*(?:AM|PM))\b/i);
        if (m) return m[1];
      }

      // Explicit <time> or departure-time classed element
      const timeEl = node.querySelector(
        'time,[class*="depart-time"],[class*="departureTime"],[class*="departure-time"],' +
        '[class*="departTime"],[class*="depart_time"],[class*="origin-time"],[class*="originTime"]'
      );
      if (timeEl) {
        const raw = (timeEl.getAttribute('datetime') ?? timeEl.textContent ?? '').trim();
        const m   = raw.match(/\b(\d{1,2}:\d{2}\s*(?:AM|PM))\b/i);
        if (m) return m[1];
      }

      // Direct children whose entire text is a time string
      for (const child of node.children) {
        const t = (child.textContent ?? '').trim();
        const m = t.match(/^(\d{1,2}:\d{2}\s*(?:AM|PM))$/i);
        if (m) return m[1];
      }

      node = node.parentElement;
    }
    return null;
  }

  // ─── Price extraction ───────────────────────────────────────────────────────
  //
  // Tries four strategies in order, returning on first success:
  //
  //   Strategy 0 — Per-card extraction (highest confidence)
  //     Finds each train card container, logs the first one for debugging,
  //     extracts the train number from the card header, then associates all
  //     prices inside that same card.  Eliminates cross-train contamination.
  //
  //   Strategy 1 — amt-md-farefinder component scan
  //   Strategy 2 — Full-document class-attribute scan
  //   Strategy 3 — Full text-node TreeWalker scan

  function extractPrices() {
    // Map: key → { coach, business, departureTime, routeName }
    const found = new Map();

    function record(key, price, fareClass, departureTime, routeName) {
      if (!found.has(key)) found.set(key, { coach: null, business: null, departureTime: null, routeName: null });
      const e = found.get(key);
      if (departureTime && !e.departureTime) e.departureTime = departureTime;
      if (routeName    && !e.routeName)      e.routeName     = routeName;
      if (fareClass === 'business') {
        if (e.business === null || price < e.business) e.business = price;
      } else {
        if (e.coach === null || price < e.coach) e.coach = price;
      }
    }

    // ── Strategy 0 — .train-name-anchored per-train extraction ──────────────
    //
    // WHY NOT use CARD_SEL here: CARD_SEL's broad fallback selectors
    // (e.g. [class*="train-result"]) can match a WRAPPER element that contains
    // ALL trains.  querySelectorAll returns that wrapper first; then
    // querySelector('.train-name') inside it returns only the FIRST train name,
    // causing every price on the page to be keyed to one train.
    //
    // CORRECT APPROACH: drive iteration from .train-name, which is confirmed
    // to return exactly one element per train.  Walk UP from each .train-name
    // to dynamically find its exclusive card boundary (the highest ancestor
    // whose parent already contains multiple .train-name elements), then scope
    // all price extraction inside that boundary only.

    const trainNameEls = document.querySelectorAll('.train-name');

    if (trainNameEls.length > 0) {
      if (!_debugLogged) {
        _debugLogged = true;
        console.log(`[Argus] Found ${trainNameEls.length} .train-name elements on page`);
        console.log('[Argus] First .train-name text:', trainNameEls[0].textContent.trim());
      }

      trainNameEls.forEach((tnEl) => {
        const text   = (tnEl.textContent ?? '').trim();
        const tokens = text.split(/\s+/);
        // First token must be a 1-4 digit number (the train number)
        if (tokens.length === 0 || !/^\d{1,4}$/.test(tokens[0])) return;

        const trainNum  = tokens[0];
        const routeName = tokens.slice(1).join(' ') || null;

        // Walk up from .train-name to find this train's exclusive card boundary.
        // The boundary is the highest ancestor whose PARENT contains more than
        // one .train-name element — meaning the parent is the list container,
        // not the individual card.  We stop one level below that parent.
        let cardEl = tnEl;
        while (cardEl.parentElement && cardEl.parentElement !== document.body) {
          if (cardEl.parentElement.querySelectorAll('.train-name').length > 1) {
            break; // cardEl is now isolated to exactly this train
          }
          cardEl = cardEl.parentElement;
        }

        const depTime = findDepartureTime(cardEl);

        cardEl.querySelectorAll(
          '[class*="price"],[class*="fare"],[class*="coach"],[class*="business"],' +
          '[class*="amount"],[amt-auto-test-id*="price"],[amt-auto-test-id*="fare"]'
        ).forEach((el) => {
          const m = (el.textContent ?? '').match(/\$\s*(\d+)/);
          if (!m) return;
          const price = parseInt(m[1], 10);
          if (price < 5 || price > 5000) return;
          const fareClass = findFareClass(el) ?? 'coach';
          record(trainNum, price, fareClass, depTime, routeName);
        });
      });

      console.log(`[Argus] Total trains found: ${found.size}`);
      if (found.size > 0) return serialize(found);
    }

    // ── Strategy 1 — amt-md-farefinder Angular component ────────────────────
    document.querySelectorAll('amt-md-farefinder').forEach((ff) => {
      ff.querySelectorAll(
        '[class*="price"],[class*="fare"],[class*="coach"],[class*="business"],[class*="amount"]'
      ).forEach((el) => {
        const m = (el.textContent ?? '').match(/\$\s*(\d+)/);
        if (!m) return;
        const price     = parseInt(m[1], 10);
        if (price < 5 || price > 5000) return;
        const info      = findTrainInfo(el);
        const fareClass = findFareClass(el) ?? 'coach';
        const depTime   = findDepartureTime(el);
        record(
          info?.number ?? `ff-${el.getBoundingClientRect().top.toFixed(0)}`,
          price, fareClass, depTime, info?.routeName ?? null
        );
      });
    });
    if (found.size > 0) return serialize(found);

    // ── Strategy 2 — full-document class-attribute scan ─────────────────────
    document.querySelectorAll(
      '[class*="price"],[class*="fare"],[class*="coach"],[class*="business"],[class*="amount"]'
    ).forEach((el) => {
      const text = (el.textContent ?? '').trim();
      const m    = text.match(/^\$\s*(\d+)$/);
      if (!m) return;
      const price = parseInt(m[1], 10);
      if (price < 5 || price > 5000) return;
      const info      = findTrainInfo(el);
      const fareClass = findFareClass(el) ?? 'coach';
      const depTime   = findDepartureTime(el);
      record(
        info?.number ?? `pos-${el.getBoundingClientRect().top.toFixed(0)}`,
        price, fareClass, depTime, info?.routeName ?? null
      );
    });
    if (found.size > 0) return serialize(found);

    // ── Strategy 3 — full text-node TreeWalker scan ──────────────────────────
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        return /\$\d+/.test(n.textContent ?? '') ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
      },
    });
    let node;
    while ((node = walker.nextNode())) {
      [...(node.textContent ?? '').matchAll(/\$\s*(\d+)/g)].forEach((m) => {
        const price = parseInt(m[1], 10);
        if (price < 5 || price > 5000) return;
        const info      = findTrainInfo(node.parentElement);
        const fareClass = findFareClass(node.parentElement) ?? 'coach';
        const depTime   = findDepartureTime(node.parentElement);
        const top       = node.parentElement?.getBoundingClientRect().top.toFixed(0) ?? Math.random();
        record(
          info?.number ?? `tx-${top}`,
          price, fareClass, depTime, info?.routeName ?? null
        );
      });
    }
    return serialize(found);
  }

  function serialize(map) {
    return [...map.entries()].map(([trainNumber, { coach, business, departureTime, routeName }], i) => ({
      trainNumber,
      routeName:     routeName     ?? null,
      coachPrice:    coach,
      businessPrice: business,
      departureTime: departureTime ?? null,
      pageIndex:     i,   // preserves DOM insertion order = Amtrak page order
    }));
  }

  // ─── Report to background ───────────────────────────────────────────────────
  //
  // bypassForNew = true  → skip the 60 s throttle if new trains just appeared
  //                        (called by MutationObserver when Angular renders more)
  // bypassForNew = false → normal 60 s cadence

  function checkAndReport(bypassForNew = false) {
    const prices    = extractPrices();
    const isNewData = prices.length > lastKnownCount;
    const now       = Date.now();

    if (bypassForNew && isNewData) {
      // New trains rendered — report immediately regardless of throttle
    } else if (now - lastReport < REPORT_INTERVAL) {
      return;
    }

    if (prices.length === 0) return;

    lastKnownCount = prices.length;
    lastReport     = now;
    chrome.runtime.sendMessage({ type: 'PRICES_UPDATE', prices, route: extractRoute() });
  }

  // ─── MutationObserver — waits for Angular to render ────────────────────────

  let debounceTimer = null;

  const observer = new MutationObserver(() => {
    // Fire as soon as .train-name elements appear (Angular has rendered results),
    // or fall back to generic price/fare indicators.
    if (!document.querySelector('.train-name,[class*="price"],[class*="fare"],amt-md-farefinder')) return;
    clearTimeout(debounceTimer);
    // bypassForNew=true: report immediately if more trains just appeared
    debounceTimer = setTimeout(() => checkAndReport(true), 800);
  });

  observer.observe(document.body, { childList: true, subtree: true });

  // ─── Background alarm relay ─────────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'TRIGGER_CHECK') {
      lastReport = 0; // force immediate report on next call
      checkAndReport();
    }
  });

  // ─── Initial check ──────────────────────────────────────────────────────────

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    setTimeout(checkAndReport, 2500); // wait for Angular's initial render
  }

  // ─── Periodic fallback ──────────────────────────────────────────────────────

  setInterval(checkAndReport, REPORT_INTERVAL);
})();
