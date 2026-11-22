/* Calculus Fennicus II — behaviour analytics (ported from ../phd/activity.js).
 * CF2 changes: every event carries doc (kirja | ratkaisut | lukukartta) and the
 * printed page label; sign-in outcomes (signin_ok / signin_denied / signin_error)
 * are sent by app.js at the gate, so this module no longer sends signin/signout.
 *
 * Sends every reader action to MyPublicAnalytics (site=CFG.site) through the
 * vendored beacon (window.mypa.send → Worker /collect → D1). Identity comes
 * from the shared localStorage key the beacon already reads, so a signed-in
 * reader's events carry user_email (verified server-side via the Google id
 * token; later events in the same session inherit it).
 *
 * Events (all with `page` = current page where meaningful):
 *   pageview        (beacon, on load; client context)
 *   page_view       reader settled on a page (≥ SETTLE_MS)          {page, from, method}
 *   page_dwell      left a page after ≥ DWELL_MIN_MS, or the tab     {page, ms, visible_ms, engaged_ms, active_ms, scroll_ms, reason}
 *                   was hidden / the reader was left (reason)
 *                     ms         = wall time on the page while the reader was shown
 *                     visible_ms = tab visible
 *                     engaged_ms = visible and some input within ENGAGED_IDLE_MS (reading maths: long still periods)
 *                     active_ms  = visible and some input within IDLE_MS
 *   every reader event also carries osa / luku (part and chapter of the page) when known, and vid (visit id)
 *   nav             explicit navigation                             {method: prev|next|input|key|hash, page, from}
 *   link            clicked a PDF link                              {kind: internal|external, page, to|href}
 *   back            ↩ / Alt+←                                       {from}
 *   zoom            zoom changed                                    {zoom, from, method: button|keyboard|wheel|pinch|fit}
 *   search_open / search / search_nav / search_close                {q, hits, i, of, page}
 *   comment_open / comment_cancel / comment_sent                    {kind, page, category, len, audio}
 *   feedback        the comment itself (comments.js)
 *   voice           dictation / recording started                   {mode}
 *   signin / signout                                                {}
 *   heartbeat       every HEARTBEAT_MS while visible                {page, active_ms, scroll_ms, pages_seen, max_page, …}
 *   engagement_end  tab hidden / page closed                        {visible_ms, active_ms, scroll_ms, scroll_events, pages_seen,
 *                                                                    max_page, last_page, zooms, searches, links, comments, min_zoom, max_zoom, reason}
 */
export function initActivity(R, CFG) {
  if (!CFG || CFG.analytics === false) return;
  const SETTLE_MS = 800, DWELL_MIN_MS = 2500, HEARTBEAT_MS = 60000, IDLE_MS = 15000, ENGAGED_IDLE_MS = 120000, SCROLL_GAP_MS = 1200, TICK_CAP_MS = 5000;
  const readerEl = document.getElementById('reader');
  const shown = () => document.visibilityState === 'visible' && !(readerEl && readerEl.hidden);
  const stage = document.getElementById('stage');

  const now = () => Date.now();
  const t = {
    start: now(), lastActivity: now(), lastVisible: now(), visibleMs: 0, activeMs: 0, engagedMs: 0,
    scrollMs: 0, scrollEvents: 0, lastScroll: 0,
    page: R.currentPage() || 1, pageSince: now(), pageActiveMs: 0, pageScrollMs: 0, pageVisibleMs: 0, pageEngagedMs: 0, pageMethod: 'load',
    pageDoc: R.doc, pageLabel: null, wasShown: true,
    pagesSeen: new Set(), maxPage: 1, zooms: 0, searches: 0, links: 0, comments: 0, backs: 0,
    minZoom: 1, maxZoom: 1, settleTimer: 0, ended: false, lastHeartbeat: now(),
  };

  // Part and chapter of a page: chapter starts come from the home-page content (CFG.toc),
  // resolved to physical pages with the open document's named destinations.
  const tocCache = {};
  function place(doc, page) {
    try {
      const toc = CFG.toc; if (!toc || !doc || doc !== R.doc) return {};
      let L = tocCache[doc];
      if (!L) {
        const D = R.dests || {}, base = doc.replace(/-en$/, ''), at = (k) => (k && D[k] ? D[k][0] : null);
        L = [];
        if (base === 'kirja') {
          for (const p of toc.parts) { const n = at(p.dest); if (n) L.push({ n, osa: p.osa, luku: p.osa + '.0' }); }
          for (const c of toc.chapters) { const n = at(c.dest); if (n) L.push({ n, osa: c.osa, luku: c.luku }); }
        } else if (base === 'ratkaisut') {
          for (const p of toc.parts) { const n = at(p.ratkDest); if (n) L.push({ n, osa: p.osa }); }
        }
        L.sort((a, b) => a.n - b.n);
        if (!Object.keys(D).length) return {};
        tocCache[doc] = L;
      }
      let hit = null;
      for (const x of L) { if (x.n <= page) hit = x; else break; }
      return hit ? (hit.luku ? { osa: hit.osa, luku: hit.luku } : { osa: hit.osa }) : {};
    } catch (_) { return {}; }
  }
  function send(ev, extra) {
    try {
      if (!(window.mypa && window.mypa.send)) return;
      const x = Object.assign({ page: t.page, doc: R.doc }, extra || {});
      if (x.label == null && typeof x.page === 'number' && x.doc === R.doc) x.label = R.label(x.page);
      if (x.osa == null && typeof x.page === 'number') Object.assign(x, place(x.doc, x.page));
      window.mypa.send(ev, x);
    } catch (_) {}
  }
  // The beacon is a classic deferred script; wait for it (max ~5 s) before the first custom event.
  const queue = [];
  function sendQ(ev, extra) { if (window.mypa && window.mypa.send) { flush(); send(ev, extra); } else queue.push([ev, extra]); }
  function flush() { while (queue.length) { const [e, x] = queue.shift(); send(e, x); } }
  let waited = 0; const wt = setInterval(() => { if (window.mypa || (waited += 250) > 5000) { clearInterval(wt); flush(); } }, 250);

  /* ---- activity / visibility accounting ---- */
  function tick() {
    const n = now(), on = shown(), was = t.wasShown;
    t.wasShown = on;                                        // before flush/summary below: they call tick() again
    if (on) {
      const d = Math.min(n - t.lastVisible, TICK_CAP_MS);   // a sleeping laptop must not count as reading
      t.visibleMs += d; t.pageVisibleMs += d;
      if (n - t.lastActivity < IDLE_MS) { t.activeMs += d; t.pageActiveMs += d; }
      if (n - t.lastActivity < ENGAGED_IDLE_MS) { t.engagedMs += d; t.pageEngagedMs += d; }
    }
    t.lastVisible = n;
    // Reader left for the home page (same tab): close the page and the visit summary.
    if (was && !on && document.visibilityState === 'visible') { flushPage('home'); sendQ('engagement_end', summary('home')); }
    if (!was && on) { t.pageSince = n; t.lastActivity = n; }
  }
  const activityEvents = ['pointermove', 'pointerdown', 'keydown', 'wheel', 'touchstart', 'scroll'];
  for (const e of activityEvents) window.addEventListener(e, () => { t.lastActivity = now(); }, { passive: true, capture: true });
  // The reader may have jumped (deep link, restored position, return from the home page)
  // without this module hearing a 'page' event: the time so far was spent on the page
  // that is actually shown, so re-label it instead of closing a page nobody looked at.
  function syncPage() {
    if (!shown() || t.settleTimer) return;
    const cp = R.currentPage();
    if (!cp || cp === t.page || R.doc !== (t.pageDoc || R.doc)) return;
    t.page = cp; t.pageLabel = R.label(cp); t.pagePlace = place(R.doc, cp); settled = cp; t.pagesSeen.add(cp); t.maxPage = Math.max(t.maxPage, cp);
  }
  setInterval(() => { syncPage(); tick(); }, 1000);

  stage.addEventListener('scroll', () => {
    const n = now();
    t.scrollEvents++;
    if (t.lastScroll && n - t.lastScroll < SCROLL_GAP_MS) { t.scrollMs += n - t.lastScroll; t.pageScrollMs += n - t.lastScroll; }
    t.lastScroll = n;
  }, { passive: true });

  /* ---- page dwell ---- */
  // A navigation (button, link, search…) smooth-scrolls through intermediate
  // pages; only the page the reader SETTLES on (SETTLE_MS without change) gets
  // a page_view, attributed to the pending navigation method and to the
  // previously settled page. Intermediate pages never reach DWELL_MIN_MS.
  let settled = t.page, pendingMethod = null, pendingUntil = 0;
  function resetPage() { t.pageSince = now(); t.pageActiveMs = 0; t.pageScrollMs = 0; t.pageVisibleMs = 0; t.pageEngagedMs = 0; }
  // Close the time spent on the current page. Without a reason this is an ordinary page
  // change (short visits are dropped); with one (hidden / pagehide / home / doc) whatever
  // has accumulated is sent, so the last page of a visit is never lost.
  function flushPage(reason) {
    const ms = now() - t.pageSince;
    const keep = reason ? t.pageVisibleMs >= 1000 : ms >= DWELL_MIN_MS;
    if (keep) {
      const x = { page: t.page, doc: t.pageDoc || R.doc, ms, visible_ms: t.pageVisibleMs, engaged_ms: t.pageEngagedMs, active_ms: t.pageActiveMs, scroll_ms: t.pageScrollMs };
      if (t.pageLabel != null) x.label = t.pageLabel;
      if (reason) x.reason = reason;
      Object.assign(x, t.pagePlace || place(x.doc, x.page));
      sendQ('page_dwell', x);
    }
    resetPage();
  }
  function leavePage(next) {
    tick();
    flushPage();
    t.page = next; t.pageDoc = R.doc; t.pageLabel = R.label(next); t.pagePlace = place(R.doc, next);
    t.maxPage = Math.max(t.maxPage, next);
    clearTimeout(t.settleTimer);
    t.settleTimer = setTimeout(() => {
      const method = (pendingMethod && now() < pendingUntil) ? pendingMethod : 'scroll';
      pendingMethod = null;
      t.settleTimer = 0;
      const from = settled; settled = next; t.pagesSeen.add(next);
      if (from !== next) sendQ('page_view', { page: next, from, method });
    }, SETTLE_MS);
  }
  t.pagesSeen.add(t.page);
  function intent(method) { pendingMethod = method; pendingUntil = now() + 2500; }
  R.on('nav', (d) => { intent(d.method); sendQ('nav', { method: d.method, page: d.page, from: d.from }); });
  R.on('page', (d) => { if (!shown()) return; if (d.page !== t.page) leavePage(d.page); });   // a hidden reader reports page 1

  /* ---- discrete actions ---- */
  R.on('link', (d) => { t.links++; if (d.kind === 'internal') intent('link'); sendQ('link', d); });
  R.on('back', (d) => { t.backs++; intent('back'); sendQ('back', d); });
  R.on('zoom', (d) => { t.zooms++; t.minZoom = Math.min(t.minZoom, d.zoom); t.maxZoom = Math.max(t.maxZoom, d.zoom); sendQ('zoom', d); });
  R.on('search_open', (d) => sendQ('search_open', d));
  let lastSearchQ = '';
  R.on('search', (d) => { if (!d.q || d.q === lastSearchQ) return; lastSearchQ = d.q; t.searches++; intent('search'); sendQ('search', d); });
  R.on('search_nav', (d) => { intent('search'); sendQ('search_nav', d); });
  R.on('search_close', (d) => sendQ('search_close', d));
  R.on('comment_open', (d) => sendQ('comment_open', d));
  R.on('comment_cancel', (d) => sendQ('comment_cancel', d));
  R.on('comment_sent', (d) => { t.comments++; sendQ('comment_sent', d); });
  R.on('voice', (d) => sendQ('voice', d));
  R.on('doc', (d) => {
    tick(); flushPage('doc');            // time on the previous document's page stays with that document
    clearTimeout(t.settleTimer); t.settleTimer = 0;
    t.pageDoc = d.doc; t.page = R.currentPage() || 1; t.pageLabel = R.label(t.page); settled = t.page; t.pagePlace = place(d.doc, t.page);
    sendQ('doc_open', { doc: d.doc, pages: d.pages });
  });
  R.on('doc_switch', (d) => sendQ('doc_switch', d));
  R.on('deeplink', (d) => sendQ('deeplink', d));
  R.on('copy_link', (d) => sendQ('copy_link', d));
  R.on('outline_open', (d) => sendQ('outline_open', d));
  R.on('outline_nav', (d) => { intent('outline'); sendQ('outline_nav', d); });
  R.on('download', (d) => sendQ('download', d));

  /* ---- heartbeat + engagement_end ---- */
  function summary(reason) {
    tick();
    return {
      reason, page: t.page, visible_ms: t.visibleMs, engaged_ms: t.engagedMs, active_ms: t.activeMs, total_ms: now() - t.start,
      scroll_ms: t.scrollMs, scroll_events: t.scrollEvents, pages_seen: t.pagesSeen.size, max_page: t.maxPage,
      last_page: t.page, zooms: t.zooms, searches: t.searches, links: t.links, backs: t.backs, comments: t.comments,
      min_zoom: t.minZoom, max_zoom: t.maxZoom, num_pages: R.numPages || 0,
    };
  }
  setInterval(() => {
    if (!shown()) return;
    if (now() - t.lastActivity > HEARTBEAT_MS * 2) return;   // idle tab: stay quiet
    sendQ('heartbeat', summary('heartbeat'));
  }, HEARTBEAT_MS);
  let hiddenSent = false;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') { const was = t.wasShown; tick(); if (!hiddenSent && was) { hiddenSent = true; flushPage('hidden'); sendQ('engagement_end', summary('hidden')); } }
    else { hiddenSent = false; t.lastVisible = now(); t.lastActivity = now(); t.pageSince = now(); }
  });
  window.addEventListener('pagehide', () => { const was = t.wasShown; tick(); if (!hiddenSent && was) { hiddenSent = true; flushPage('pagehide'); sendQ('engagement_end', summary('pagehide')); } });

  return { summary };
}
