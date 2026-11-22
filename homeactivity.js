/* Calculus Fennicus II — home-page behaviour analytics (the reader has activity.js).
 *
 * Measures how the home page is used and sends it to MyPublicAnalytics through the
 * same beacon (track() from app.js). Nothing here names any content: section ids and
 * content keys (data-key) only, plus the link target a reader clicked.
 *
 * Events:
 *   home_section   settled on a section (≥ SETTLE_MS)                    {section, from}
 *   home_dwell     left a section after ≥ DWELL_MIN_MS, or the page was   {section, ms, visible_ms, engaged_ms, active_ms, reason}
 *                  hidden / left for the reader (reason)
 *   home_click     link or button                                         {section, key, kind, doc, dest, href}
 *   home_details   a collapsible block opened or closed                   {section, key, open}
 *   home_end       tab hidden / page closed / reader opened               {visible_ms, engaged_ms, active_ms, sections: {id: ms}, max_scroll, clicks, reason}
 */
const SETTLE_MS = 1000, DWELL_MIN_MS = 2500, IDLE_MS = 15000, ENGAGED_IDLE_MS = 120000, TICK_CAP_MS = 5000;
let started = false;

export function initHomeActivity(CFG, track) {
  if (!CFG || CFG.analytics === false || started) return;   // renderHome() runs again on a language switch
  started = true;
  const home = document.getElementById('home');
  const now = () => Date.now();
  const shown = () => document.visibilityState === 'visible' && !home.hidden;
  const t = { last: now(), lastActivity: now(), visibleMs: 0, engagedMs: 0, activeMs: 0, clicks: 0, maxScroll: 0, wasShown: shown(),
    sec: null, secSince: now(), secVisible: 0, secEngaged: 0, secActive: 0, settled: null, settleTimer: 0, perSection: {} };

  function currentSection() {
    const y = window.innerHeight * 0.4;
    let best = null;
    for (const el of home.querySelectorAll('section[id], footer[id]')) {
      const r = el.getBoundingClientRect();
      if (r.top <= y && r.bottom > y) best = el.id;
    }
    return best || (window.scrollY < 200 ? 'top' : t.sec);
  }
  function flushSection(reason) {
    if (!t.sec) return;
    const ms = now() - t.secSince;
    if (reason ? t.secVisible >= 1000 : ms >= DWELL_MIN_MS) {
      const x = { section: t.sec, ms, visible_ms: t.secVisible, engaged_ms: t.secEngaged, active_ms: t.secActive };
      if (reason) x.reason = reason;
      track('home_dwell', x);
    }
    t.secSince = now(); t.secVisible = 0; t.secEngaged = 0; t.secActive = 0;
  }
  function summary(reason) {
    return { reason, visible_ms: t.visibleMs, engaged_ms: t.engagedMs, active_ms: t.activeMs, sections: t.perSection, max_scroll: t.maxScroll, clicks: t.clicks };
  }
  function end(reason) { flushSection(reason); track('home_end', summary(reason)); }

  function tick() {
    const n = now(), on = shown();
    if (on) {
      const d = Math.min(n - t.last, TICK_CAP_MS);
      const sec = currentSection();
      if (sec !== t.sec) {
        flushSection();
        t.sec = sec;
        clearTimeout(t.settleTimer);
        t.settleTimer = setTimeout(() => { if (t.sec === sec && t.settled !== sec) { track('home_section', { section: sec, from: t.settled }); t.settled = sec; } }, SETTLE_MS);
      }
      t.visibleMs += d; t.secVisible += d;
      if (t.sec) t.perSection[t.sec] = (t.perSection[t.sec] || 0) + d;
      if (n - t.lastActivity < IDLE_MS) { t.activeMs += d; t.secActive += d; }
      if (n - t.lastActivity < ENGAGED_IDLE_MS) { t.engagedMs += d; t.secEngaged += d; }
      const doc = document.documentElement, max = doc.scrollHeight - window.innerHeight;
      if (max > 0) t.maxScroll = Math.max(t.maxScroll, Math.round(window.scrollY / max * 100));
    }
    // Home left for the reader in the same tab.
    const was = t.wasShown; t.wasShown = on; t.last = n;
    if (was && !on && document.visibilityState === 'visible') end('reader');
    if (!was && on) { t.secSince = n; t.lastActivity = n; }
  }
  for (const e of ['pointermove', 'pointerdown', 'keydown', 'wheel', 'touchstart', 'scroll'])
    window.addEventListener(e, () => { t.lastActivity = now(); }, { passive: true, capture: true });
  setInterval(tick, 1000);

  let hiddenSent = false;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') { const was = t.wasShown; tick(); if (!hiddenSent && was) { hiddenSent = true; end('hidden'); } }
    else { hiddenSent = false; t.last = now(); t.lastActivity = now(); t.secSince = now(); }
  });
  window.addEventListener('pagehide', () => { const was = t.wasShown; tick(); if (!hiddenSent && was) { hiddenSent = true; end('pagehide'); } });

  /* ---- clicks and collapsible blocks ---- */
  const where = (n) => {
    const s = n.closest('section[id], footer[id], header'), k = n.closest('[data-key]');
    return { section: s ? (s.id || 'header') : null, key: k ? k.dataset.key : undefined };
  };
  home.addEventListener('click', (e) => {
    const a = e.target.closest && e.target.closest('a[href], button');
    if (!a || !home.contains(a)) return;
    const x = where(a);
    const href = a.getAttribute('href') || '';
    if (a.tagName === 'BUTTON') x.kind = 'button';
    else if (href.startsWith('#doc=')) {
      const h = new URLSearchParams(href.slice(1));
      x.kind = 'open'; x.doc = h.get('doc'); if (h.get('dest')) x.dest = h.get('dest');
    } else if (href.startsWith('#')) { x.kind = 'anchor'; x.href = href; }
    else { x.kind = 'external'; x.href = href.slice(0, 200); }
    t.clicks++;
    track('home_click', x);
  }, true);
  home.addEventListener('toggle', (e) => {
    const d = e.target;
    if (!d || d.tagName !== 'DETAILS') return;
    track('home_details', Object.assign(where(d), { open: d.open }));
  }, true);
}
