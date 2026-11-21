/* Calculus Fennicus II — pdf.js reader (ES module).
 *
 * Ported from ../phd/reader.js (continuous scroll, lazy render, ≤ KEEP_RENDERED
 * pages rasterized, sharp text on Retina, selectable TextLayer, pinch/ctrl-wheel
 * zoom) with the deep-link model of ../calculus-fennicus/viewer.html:
 *
 *   #doc=kirja&dest=<named destination>     (dests-<doc>.json → [page, topFraction])
 *   #doc=kirja&label=<LaTeX label>          (labels-<doc>.json → {dest, ref, page})
 *   #doc=kirja&page=<printed page label>    (PDF /PageLabels; falls back to physical)
 *   #doc=kirja&q=<search term>
 *
 * Differences to the phd reader:
 *   - the PDF comes in as DECRYPTED BYTES from app.js (getDocument({data})); it
 *     never exists as a URL, a Blob or a file;
 *   - three documents (kirja, ratkaisut, lukukartta) in one reader;
 *   - printed page labels in the page box, outline sidebar (pdf.getOutline),
 *     copy-link-to-here, back stack across documents;
 *   - links in the PDF: same-site (calculus-fennicus-2) → in-app navigation,
 *     volume 1 / anything else → new tab.
 *
 * Exposes window.Reader for search.js / comments.js / owner.js / activity.js.
 */
import * as pdfjsLib from './vendor/pdfjs/pdf.min.mjs';

const CFG = window.CF2_CONFIG || {};
pdfjsLib.GlobalWorkerOptions.workerSrc = './vendor/pdfjs/worker-shim.mjs';

const KEEP_RENDERED = 8;
const MAX_DPR = 2;
const cMapUrl = './vendor/pdfjs/cmaps/';
const standardFontDataUrl = './vendor/pdfjs/standard_fonts/';
const DOC_IDS = Object.keys(CFG.docs || { kirja: 1, ratkaisut: 1, lukukartta: 1 });

const $ = (id) => document.getElementById(id);
const stage = $('stage');
const pagesEl = $('pages');
const loading = $('loading');
const loadingBar = document.querySelector('#loading .bar i');
const loadingMsg = $('loadingMsg');
const pageInput = $('pageInput');
const pageTotal = $('pageTotal');

let APP = null;   // { fetchDoc(doc, onProgress) → {data:Uint8Array, dests, labels} }

const state = {
  doc: null, gen: 0,
  pdf: null, n: 0,
  base: { w: 595, h: 842 },
  scale: 1, zoom: 1, cur: 1,
  recs: new Map(), order: [], observer: null, visible: new Set(), renderTimer: 0,
  paintedCbs: [], back: [], destCache: new Map(), listeners: {},
  pageLabels: null, labelToPhys: new Map(),
  dests: {}, labels: {}, destsByPage: null,
  target: null,            // the deep-link target currently "held" in the hash
  lastPos: {},             // doc -> {page, frac} (restore when switching back)
  loadingDoc: null,
};

/* ---------------- public API ---------------- */
let readyResolve;
const Reader = {
  cfg: CFG,
  ready: new Promise((r) => { readyResolve = r; }),
  get doc() { return state.doc; },
  get numPages() { return state.n; },
  get pageEl() { return (n) => state.recs.get(n)?.el || null; },
  get zoom() { return state.zoom; },
  get pdf() { return state.pdf; },
  get dests() { return state.dests; },
  get labels() { return state.labels; },
  currentPage: () => state.cur,
  label: (n) => pageLabel(n),
  // Nearest named destination at or above (page, yFrac): a stable, layout-independent
  // anchor for comments ({dest, dp, dy}); walks back to an earlier page if needed.
  nearestDest: (page, yFrac) => {
    const m = destIndex();
    const same = m.get(page);
    if (same) { let best = null; for (const [top, name] of same) { if (top <= yFrac + 0.005) best = [top, name]; else break; }
      if (best) return { dest: best[1], dp: 0, dy: +Math.max(0, yFrac - best[0]).toFixed(4) }; }
    for (let p = page - 1; p >= 1; p--) { const a = m.get(p); if (a && a.length) return { dest: a[a.length - 1][1], dp: page - p, dy: +yFrac.toFixed(4) }; }
    return null;
  },
  open, goToPage, goToDest, goTarget, goBack, setZoom, scrollToFraction, linkHere, pushBack,
  on(name, cb) { (state.listeners[name] = state.listeners[name] || []).push(cb); },
  emit(name, data) { for (const cb of state.listeners[name] || []) { try { cb(data || {}); } catch (_) {} } },
  onPainted: (cb) => { state.paintedCbs.push(cb); },
  pageOfNode(node) {
    let el = node && node.nodeType === 3 ? node.parentElement : node;
    while (el && el !== pagesEl) {
      if (el.classList && el.classList.contains('page')) return Number(el.dataset.n) || 0;
      el = el.parentElement;
    }
    return 0;
  },
  hlLayer: (n) => state.recs.get(n)?.hl || null,
  isRendered: (n) => !!state.recs.get(n)?.rendered,
};
window.Reader = Reader;

export function initReader(app) {
  APP = app;
  setupNav();
  setupOutlineUi();
  setupDocSelector();
  return Reader;
}

/* ---------------- documents ---------------- */
function pageLabel(n) {
  return (state.pageLabels && state.pageLabels[n - 1]) || String(n);
}
function physFromLabel(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return 0;
  if (state.labelToPhys.has(s)) return state.labelToPhys.get(s);
  if (state.labelToPhys.has(s.toLowerCase())) return state.labelToPhys.get(s.toLowerCase());
  const k = parseInt(s, 10);
  return Number.isFinite(k) ? k : 0;
}

/* Open a document (if not already open) and go to the target. */
async function open(doc, target, opts = {}) {
  if (!DOC_IDS.includes(doc)) doc = CFG.defaultDoc || 'kirja';
  if (doc !== state.doc) {
    if (state.doc && state.n) state.lastPos[state.doc] = viewPos();
    const ok = await loadDoc(doc);
    if (!ok) return false;
    if (!target && state.lastPos[doc]) target = { phys: state.lastPos[doc].page, frac: state.lastPos[doc].frac };
  }
  if (target) await goTarget(target, { behavior: opts.behavior || 'auto', fromHash: opts.fromHash });
  else if (!opts.keep) { goToPage(1); writeHash(); }
  return true;
}

async function loadDoc(doc) {
  const gen = ++state.gen;
  state.loadingDoc = doc;
  showLoading(true, 'Avataan: ' + ((CFG.docs && CFG.docs[doc] && CFG.docs[doc].label) || doc) + '…');
  updateDocSelector(doc);
  let got;
  try {
    got = await APP.fetchDoc(doc, (loaded, total) => {
      if (gen !== state.gen) return;
      if (loadingBar && total) loadingBar.style.width = Math.round((loaded / total) * 90) + '%';
    });
  } catch (e) {
    if (gen === state.gen) showError('Dokumentin avaus epäonnistui: ' + (e && e.message || e));
    return false;
  }
  if (gen !== state.gen) return false;
  // tear down the previous document
  teardown();
  if (state.pdf) { try { await state.pdf.destroy(); } catch (_) {} state.pdf = null; }
  try {
    const task = pdfjsLib.getDocument({
      data: got.data,                 // decrypted bytes (transferred to the worker; no URL, no Blob)
      cMapUrl, cMapPacked: true, standardFontDataUrl,
      isEvalSupported: false,
    });
    state.pdf = await task.promise;
  } catch (e) {
    if (gen === state.gen) showError('PDF:n avaus epäonnistui: ' + (e && e.message || e));
    return false;
  }
  if (gen !== state.gen) return false;
  if (loadingBar) loadingBar.style.width = '100%';
  state.doc = doc;
  state.n = state.pdf.numPages;
  state.dests = got.dests || {};
  state.labels = got.labels || {};
  state.destsByPage = null;
  state.destCache = new Map();
  try { state.pageLabels = await state.pdf.getPageLabels(); } catch (_) { state.pageLabels = null; }
  state.labelToPhys = new Map();
  if (state.pageLabels) state.pageLabels.forEach((l, i) => { if (l && !state.labelToPhys.has(l)) state.labelToPhys.set(l, i + 1); });
  pageTotal.textContent = '/ ' + pageLabel(state.n);
  const p1 = await state.pdf.getPage(1);
  const vp1 = p1.getViewport({ scale: 1 });
  state.base = { w: vp1.width, h: vp1.height };
  state.cur = 1;
  layout();
  setupObserver();
  showLoading(false);
  buildOutline(gen);
  updateDownloadBtn();
  readyResolve && (readyResolve(Reader), readyResolve = null);
  Reader.emit('doc', { doc, pages: state.n });
  return true;
}

function teardown() {
  if (state.observer) { state.observer.disconnect(); state.observer = null; }
  for (const n of [...state.recs.keys()]) unrender(n);
  state.recs.clear(); state.order = []; state.visible.clear();
  pagesEl.innerHTML = '';
  state.target = null;
}

function showLoading(on, msg) {
  if (!loading) return;
  loading.classList.toggle('hide', !on);
  if (on) {
    loading.classList.remove('err');
    if (loadingBar) loadingBar.style.width = '0%';
    if (loadingMsg && msg) loadingMsg.textContent = msg;
  }
}
function showError(msg) {
  if (!loading) return;
  loading.classList.remove('hide'); loading.classList.add('err');
  if (loadingMsg) loadingMsg.textContent = msg;
}

/* ---------------- layout ---------------- */
function fitScale() {
  const avail = Math.max(280, Math.min(stage.clientWidth - (stage.clientWidth < 600 ? 12 : 40), 1100));
  return (avail / state.base.w) * state.zoom;
}
function layout() {
  state.scale = fitScale();
  const cssW = Math.floor(state.base.w * state.scale);
  const cssH = Math.floor(state.base.h * state.scale);
  pagesEl.style.width = cssW + 'px';
  const frag = document.createDocumentFragment();
  for (let n = 1; n <= state.n; n++) {
    let rec = state.recs.get(n);
    if (!rec) {
      const el = document.createElement('div');
      el.className = 'page';
      el.dataset.n = String(n);
      el.dataset.label = pageLabel(n);
      const hl = document.createElement('div'); hl.className = 'hl';
      el.appendChild(hl);
      frag.appendChild(el);
      rec = { el, canvas: null, hl, link: null, rendered: false, rendering: false, task: null };
      state.recs.set(n, rec);
    }
    rec.el.style.width = cssW + 'px';
    rec.el.style.height = cssH + 'px';
  }
  if (frag.childNodes.length) pagesEl.appendChild(frag);
}
function relayoutRerender() {
  for (const n of state.recs.keys()) unrender(n);
  layout();
  if (state.observer) { state.observer.disconnect(); setupObserver(); }
}

/* ---------------- render pipeline ---------------- */
function setupObserver() {
  state.visible.clear();
  state.observer = new IntersectionObserver(onIntersect, { root: stage, rootMargin: '700px 0px' });
  for (const rec of state.recs.values()) state.observer.observe(rec.el);
}
function onIntersect(entries) {
  for (const e of entries) {
    const n = Number(e.target.dataset.n);
    if (e.isIntersecting) state.visible.add(n); else state.visible.delete(n);
  }
  // Debounce: a long jump scrolls past hundreds of placeholders; only render
  // what is still near the viewport once the scroll has settled a moment.
  clearTimeout(state.renderTimer);
  state.renderTimer = setTimeout(() => {
    const near = [...state.visible].sort((a, b) => Math.abs(a - state.cur) - Math.abs(b - state.cur)).slice(0, KEEP_RENDERED - 2);
    for (const n of near) render(n);
  }, 60);
  updateCur();
}

async function render(n) {
  const rec = state.recs.get(n);
  if (!rec || rec.rendered || rec.rendering || !state.pdf) return;
  const gen = state.gen;
  rec.rendering = true;
  try {
    const page = await state.pdf.getPage(n);
    if (gen !== state.gen || !rec.rendering) return;
    const vp = page.getViewport({ scale: state.scale });
    rec.el.style.width = Math.floor(vp.width) + 'px';
    rec.el.style.height = Math.floor(vp.height) + 'px';
    const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(vp.width * dpr);
    canvas.height = Math.floor(vp.height * dpr);
    canvas.style.width = Math.floor(vp.width) + 'px';
    canvas.style.height = Math.floor(vp.height) + 'px';
    const ctx = canvas.getContext('2d', { alpha: false });
    rec.el.insertBefore(canvas, rec.hl);
    rec.canvas = canvas;
    rec.task = page.render({ canvasContext: ctx, viewport: vp, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null });
    await rec.task.promise;
    if (gen !== state.gen || !rec.rendering) return;
    await addTextLayer(rec, page, vp);
    await addLinkLayer(rec, page, vp);
    if (gen !== state.gen || !rec.rendering) return;
    rec.rendered = true;
    rec.rendering = false;
    touch(n);
    for (const cb of state.paintedCbs) { try { cb(n, rec.el, rec.hl); } catch (_) {} }
  } catch (e) {
    rec.rendering = false;   // cancelled render (fast scroll / doc switch) is normal
  }
}

async function addTextLayer(rec, page, vp) {
  const div = document.createElement('div');
  div.className = 'textLayer';
  div.style.setProperty('--scale-factor', String(state.scale));
  div.style.setProperty('--total-scale-factor', String(state.scale));
  rec.el.appendChild(div);
  const tl = new pdfjsLib.TextLayer({
    textContentSource: page.streamTextContent({ includeMarkedContent: true }),
    container: div, viewport: vp,
  });
  await tl.render();
  rec.textDiv = div;
}

/* Classify a URL found in the PDF: same site → in-app target; volume 1 → new tab. */
function classifyUrl(url) {
  let u;
  try { u = new URL(url, location.href); } catch (_) { return { kind: 'external', url }; }
  const bases = (CFG.siteBaseUrls || []).slice();
  bases.push(location.origin + location.pathname.replace(/index\.html$/, ''));
  const plain = u.origin + u.pathname.replace(/index\.html$/, '');
  if (bases.some((b) => plain === b || plain + '/' === b || plain === b + '/')) {
    return { kind: 'site', target: parseTarget(u.hash), doc: parseDoc(u.hash) };
  }
  if (CFG.volume1Url && url.startsWith(CFG.volume1Url)) return { kind: 'volume1', url };
  return { kind: 'external', url };
}

async function addLinkLayer(rec, page, vp) {
  let anns = [];
  try { anns = await page.getAnnotations({ intent: 'display' }); } catch (_) { return; }
  const links = anns.filter((a) => a.subtype === 'Link' && (a.url || a.unsafeUrl || a.dest));
  if (!links.length) return;
  const layer = document.createElement('div'); layer.className = 'linklayer';
  const from = Number(rec.el.dataset.n);
  for (const a of links) {
    const r = pdfjsLib.Util.normalizeRect(a.rect);
    const [x1, y1] = vp.convertToViewportPoint(r[0], r[1]);
    const [x2, y2] = vp.convertToViewportPoint(r[2], r[3]);
    const el = document.createElement('a');
    const url = a.url || a.unsafeUrl;
    if (url) {
      const c = classifyUrl(url);
      if (c.kind === 'site') {
        el.href = '#' + hashFor(c.doc || state.doc, c.target);
        el.className = 'internal site';
        el.title = 'Siirry: ' + describeTarget(c.doc, c.target);
        el.addEventListener('click', (ev) => {
          ev.preventDefault();
          Reader.emit('link', { kind: 'site', page: from, doc: state.doc, to_doc: c.doc || state.doc, to: describeTarget(c.doc, c.target) });
          navigate(c.doc || state.doc, c.target);
        });
      } else {
        el.href = url; el.target = '_blank'; el.rel = 'noopener';
        el.title = c.kind === 'volume1' ? 'Avaa niteessä 1 (uusi välilehti)' : url;
        el.className = c.kind;
        el.addEventListener('click', () => Reader.emit('link', { kind: c.kind, page: from, doc: state.doc, href: String(url).slice(0, 300) }));
      }
    } else {
      const dest = a.dest;
      el.href = '#'; el.className = 'internal';
      el.title = typeof dest === 'string' ? dest.replace(/^(section|subsection|chapter|figure|table|cite|equation|Hfootnote|page|Thm|Item|Exa)\./, '') : 'Siirry';
      el.addEventListener('click', (ev) => { ev.preventDefault(); goToDest(dest, from); });
    }
    el.style.left = Math.min(x1, x2) + 'px';
    el.style.top = Math.min(y1, y2) + 'px';
    el.style.width = Math.abs(x2 - x1) + 'px';
    el.style.height = Math.abs(y2 - y1) + 'px';
    layer.appendChild(el);
  }
  rec.el.appendChild(layer);
  rec.link = layer;
}

/* In-app navigation to (doc, target) with a back-stack entry. */
async function navigate(doc, target) {
  pushBack();
  if (doc !== state.doc) {
    // push a history entry so the browser back button also works across docs
    history.pushState(null, '', '#' + hashFor(doc, target));
    await open(doc, target, { behavior: 'auto' });
  } else {
    await goTarget(target, { behavior: 'smooth' });
  }
}

/* ---------------- destinations ---------------- */
async function resolveDest(dest) {
  if (!dest) return null;
  const key = typeof dest === 'string' ? dest : null;
  if (key && state.dests[key]) {
    const [page, frac] = state.dests[key];
    return { page, frac };
  }
  if (key && state.destCache.has(key)) return state.destCache.get(key);
  let arr = dest;
  if (typeof dest === 'string') { try { arr = await state.pdf.getDestination(dest); } catch (_) { arr = null; } }
  if (!Array.isArray(arr) || !arr.length) return null;
  let page = 0;
  const ref = arr[0];
  try {
    if (typeof ref === 'number') page = ref + 1;
    else if (ref && typeof ref === 'object') page = (await state.pdf.getPageIndex(ref)) + 1;
  } catch (_) { page = 0; }
  if (!page) return null;
  const kind = arr[1] && arr[1].name ? arr[1].name : String(arr[1] || '');
  let top = null;
  if (kind === 'XYZ') top = typeof arr[3] === 'number' ? arr[3] : null;
  else if (kind === 'FitH' || kind === 'FitBH') top = typeof arr[2] === 'number' ? arr[2] : null;
  else if (kind === 'FitR') top = typeof arr[5] === 'number' ? arr[5] : null;
  const out = { page, frac: top == null ? 0 : Math.max(0, Math.min(1, (state.base.h - top) / state.base.h)) };
  if (key) state.destCache.set(key, out);
  return out;
}

async function goToDest(dest, fromPage) {
  const d = await resolveDest(dest);
  if (!d) return;
  Reader.emit('link', { kind: 'internal', page: fromPage || state.cur, doc: state.doc, to: d.page });
  pushBack();
  state.target = typeof dest === 'string' ? { dest } : { page: pageLabel(d.page) };
  scrollToPos(d.page, d.frac, Math.abs(d.page - state.cur) > 3 ? 'auto' : 'smooth');
  writeHash();
}

/* target: {dest} | {label} | {page: printed label} | {phys, frac} | {q} */
async function goTarget(target, opts = {}) {
  if (!target) return false;
  let page = 0, frac = 0, ok = true;
  if (target.label) {
    const L = state.labels[target.label];
    const d = L && L.dest ? await resolveDest(L.dest) : null;
    if (d) { page = d.page; frac = d.frac; } else if (L && L.page) page = physFromLabel(L.page); else ok = false;
  } else if (target.dest) {
    const d = await resolveDest(target.dest);
    if (d) { page = d.page; frac = d.frac; } else ok = false;
  } else if (target.page != null) {
    page = physFromLabel(target.page);
  } else if (target.phys) {
    page = target.phys; frac = target.frac || 0;
  }
  if (target.q) {
    Reader.ready.then(() => { if (Reader.search) Reader.search.search(target.q); });
  }
  if (!ok || !page) {
    Reader.emit('deeplink', { doc: state.doc, target: target.label || target.dest || target.page, found: false });
    if (!target.q) toast('Kohdetta ei löytynyt: ' + (target.label || target.dest || target.page));
    return false;
  }
  if (opts.fromHash && (target.label || target.dest)) Reader.emit('deeplink', { doc: state.doc, target: target.label || target.dest, page: pageLabel(page), found: true });
  state.target = (target.label || target.dest) ? target : null;
  scrollToPos(page, frac, opts.behavior || 'auto');
  if (state.target) { const el = state.recs.get(page)?.el; if (el) { el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); } }
  writeHash();
  return true;
}

function scrollToPos(n, frac, behavior) {
  n = Math.max(1, Math.min(state.n, n | 0));
  const rec = state.recs.get(n); if (!rec) return;
  const h = rec.el.offsetHeight || state.base.h * state.scale;
  const y = rec.el.offsetTop + h * (frac || 0) - (frac ? 24 : 12);
  stage.scrollTo({ top: Math.max(0, y), behavior: behavior || 'auto' });
  state.cur = n; if (document.activeElement !== pageInput) pageInput.value = pageLabel(n);
  render(n);
}

/* Search results / owner view: put page fraction fy ~1/3 down the viewport. */
function scrollToFraction(n, fy, behavior = 'smooth') {
  const rec = state.recs.get(n); if (!rec) return;
  const y = rec.el.offsetTop + (rec.el.offsetHeight || state.base.h * state.scale) * (fy || 0);
  stage.scrollTo({ top: Math.max(0, y - stage.clientHeight / 3), behavior: Math.abs(n - state.cur) > 3 ? 'auto' : behavior });
  state.cur = n; pageInput.value = pageLabel(n);
  state.target = null; writeHash();
  render(n);
}

/* ---------------- hash ---------------- */
export function parseDoc(hash) {
  const h = new URLSearchParams(String(hash || '').replace(/^#/, ''));
  const d = h.get('doc');
  return d && DOC_IDS.includes(d) ? d : null;
}
export function parseTarget(hash) {
  const h = new URLSearchParams(String(hash || '').replace(/^#/, ''));
  const label = h.get('label'), dest = h.get('dest'), page = h.get('page'), q = h.get('q');
  let t = null;
  if (label) t = { label }; else if (dest) t = { dest }; else if (page) t = { page };
  if (q) t = Object.assign(t || {}, { q });
  return t;
}
function hashFor(doc, t) {
  const p = new URLSearchParams();
  p.set('doc', doc || state.doc || 'kirja');
  if (t && t.label) p.set('label', t.label);
  else if (t && t.dest) p.set('dest', t.dest);
  else if (t && t.page != null) p.set('page', String(t.page));
  else if (t && t.phys) p.set('page', pageLabel(t.phys));
  return p.toString();
}
function writeHash() {
  if (!state.doc) return;
  const t = state.target || { page: pageLabel(state.cur) };
  const h = '#' + hashFor(state.doc, t);
  if (location.hash !== h) history.replaceState(null, '', h);
}
function describeTarget(doc, t) {
  const d = (doc && CFG.docs && CFG.docs[doc] && CFG.docs[doc].label) || '';
  if (!t) return d;
  return (d ? d + ': ' : '') + (t.label || t.dest || ('s. ' + t.page));
}

/* ---------------- copy link to here ---------------- */
function viewPos() {
  const rec = state.recs.get(state.cur);
  if (!rec) return { page: state.cur, frac: 0 };
  const top = stage.scrollTop + 30;
  const frac = Math.max(0, Math.min(1, (top - rec.el.offsetTop) / (rec.el.offsetHeight || 1)));
  return { page: state.cur, frac };
}
function destIndex() {
  if (state.destsByPage) return state.destsByPage;
  const m = new Map();
  for (const [name, v] of Object.entries(state.dests || {})) {
    if (!Array.isArray(v) || /^(Doc-Start|page\.|Hfootnote\.)/.test(name)) continue;
    if (!m.has(v[0])) m.set(v[0], []);
    m.get(v[0]).push([v[1], name]);
  }
  for (const a of m.values()) a.sort((x, y) => x[0] - y[0]);
  state.destsByPage = m;
  return m;
}
function linkHere() {
  const { page, frac } = viewPos();
  const list = destIndex().get(page) || [];
  let best = null;
  for (const [f, name] of list) { if (f <= frac + 0.03) best = name; else break; }
  const t = best ? { dest: best } : { page: pageLabel(page) };
  const base = location.origin + location.pathname;
  return { url: base + '#' + hashFor(state.doc, t), target: t, page };
}

/* ---------------- back stack ---------------- */
function pushBack() {
  if (!state.doc) return;
  state.back.push({ doc: state.doc, top: stage.scrollTop, left: stage.scrollLeft, zoom: state.zoom, pos: viewPos() });
  if (state.back.length > 50) state.back.shift();
  updateBackBtn();
}
async function goBack() {
  const b = state.back.pop();
  updateBackBtn();
  if (!b) return;
  Reader.emit('back', { from: state.cur, doc: state.doc, to_doc: b.doc });
  if (b.doc !== state.doc) {
    history.pushState(null, '', '#' + hashFor(b.doc, { phys: b.pos.page }));
    await open(b.doc, { phys: b.pos.page, frac: b.pos.frac });
    return;
  }
  if (b.zoom !== state.zoom) setZoom(b.zoom, { keepView: false });
  state.target = null;
  requestAnimationFrame(() => { stage.scrollTo({ top: b.top, left: b.left, behavior: 'auto' }); updateCur(); writeHash(); });
}
function updateBackBtn() { const b = $('back'); if (b) b.disabled = !state.back.length; }

function touch(n) {
  const i = state.order.indexOf(n);
  if (i >= 0) state.order.splice(i, 1);
  state.order.push(n);
  let guard = state.order.length;
  while (state.order.length > KEEP_RENDERED && guard-- > 0) {
    const victim = state.order.shift();
    if (Math.abs(victim - state.cur) <= 2) { state.order.push(victim); continue; }
    unrender(victim);
  }
}
function unrender(n) {
  const rec = state.recs.get(n);
  if (!rec || (!rec.rendered && !rec.rendering)) return;
  if (rec.task) { try { rec.task.cancel(); } catch (_) {} rec.task = null; }
  if (rec.canvas) { rec.canvas.width = 0; rec.canvas.height = 0; rec.canvas.remove(); rec.canvas = null; }
  if (rec.textDiv) { rec.textDiv.remove(); rec.textDiv = null; }
  if (rec.link) { rec.link.remove(); rec.link = null; }
  rec.hl.innerHTML = '';
  rec.rendered = false; rec.rendering = false;
  const i = state.order.indexOf(n); if (i >= 0) state.order.splice(i, 1);
}

/* ---------------- navigation ---------------- */
function updateCur() {
  if (!state.n) return;
  // pages are uniform height: compute directly instead of scanning 1644 boxes
  const first = state.recs.get(1); if (!first) return;
  const stride = (first.el.offsetHeight || 1) + 16;
  const mid = stage.scrollTop + stage.clientHeight * 0.42 - first.el.offsetTop;
  const best = Math.max(1, Math.min(state.n, Math.floor(mid / stride) + 1));
  if (best !== state.cur) {
    const from = state.cur;
    state.cur = best;
    if (document.activeElement !== pageInput) pageInput.value = pageLabel(best);
    if (state.target) {
      // keep a dest/label in the hash while its page is still in view
      const tp = state.target.dest ? (state.dests[state.target.dest] || [])[0] : null;
      if (!tp || Math.abs(tp - best) > 0) state.target = null;
    }
    writeHash();
    Reader.emit('page', { page: best, from, label: pageLabel(best) });
  }
}

function goToPage(n, method) {
  n = Math.max(1, Math.min(state.n, n | 0));
  const rec = state.recs.get(n);
  if (!rec) return;
  if (method) Reader.emit('nav', { method, page: n, from: state.cur });
  state.target = null;
  stage.scrollTo({ top: rec.el.offsetTop - 12, behavior: Math.abs(n - state.cur) > 3 ? 'auto' : 'smooth' });
  state.cur = n; pageInput.value = pageLabel(n);
  render(n);
  writeHash();
}

function setupNav() {
  let raf = 0;
  stage.addEventListener('scroll', () => {
    if (raf) return; raf = requestAnimationFrame(() => { raf = 0; updateCur(); });
  }, { passive: true });
  $('prev').onclick = () => goToPage(state.cur - 1, 'prev');
  $('next').onclick = () => goToPage(state.cur + 1, 'next');
  pageInput.addEventListener('change', () => { const p = physFromLabel(pageInput.value); if (p) goToPage(p, 'input'); else pageInput.value = pageLabel(state.cur); });
  pageInput.addEventListener('focus', () => pageInput.select());
  $('zin').onclick = () => setZoom(state.zoom * 1.2, { method: 'button' });
  $('zout').onclick = () => setZoom(state.zoom / 1.2, { method: 'button' });
  $('zfit').onclick = () => setZoom(1, { method: 'fit' });
  $('zpage').onclick = () => setZoom(fitPageZoom(), { method: 'fit_page' });
  $('back').onclick = goBack;
  const cl = $('copyLink');
  if (cl) cl.onclick = async () => {
    const l = linkHere();
    try { await navigator.clipboard.writeText(l.url); toast('Linkki kopioitu: ' + describeTarget(state.doc, l.target)); }
    catch (_) { window.prompt('Kopioi linkki:', l.url); }
    Reader.emit('copy_link', { doc: state.doc, page: l.page, target: l.target.dest || l.target.page });
  };
  updateBackBtn(); updateZoomLabel();

  let rt = 0;
  window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => { if (state.n) setZoom(state.zoom, { method: 'resize' }); }, 200); });

  window.addEventListener('keydown', (e) => {
    if (document.body.dataset.view !== 'reader') return;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && !e.altKey && (e.key === '+' || e.key === '=' || e.key === 'Add')) { e.preventDefault(); setZoom(state.zoom * 1.2, { method: 'keyboard' }); return; }
    if (mod && !e.altKey && (e.key === '-' || e.key === '_' || e.key === 'Subtract')) { e.preventDefault(); setZoom(state.zoom / 1.2, { method: 'keyboard' }); return; }
    if (mod && !e.altKey && e.key === '0') { e.preventDefault(); setZoom(1, { method: 'keyboard' }); return; }
    if (/input|textarea|select/i.test(e.target.tagName)) return;
    if (e.altKey && e.key === 'ArrowLeft') { e.preventDefault(); goBack(); return; }
    if (e.key === 'ArrowRight' || e.key === 'PageDown') { goToPage(state.cur + 1, 'key'); e.preventDefault(); }
    else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { goToPage(state.cur - 1, 'key'); e.preventDefault(); }
  });

  stage.addEventListener('wheel', (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    const factor = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0025));
    preview.method = 'wheel';
    previewZoom(clampZoom(previewTarget() * factor), e.clientX, e.clientY);
  }, { passive: false });
  let gestureStart = 1;
  stage.addEventListener('gesturestart', (e) => { e.preventDefault(); gestureStart = previewTarget(); }, { passive: false });
  stage.addEventListener('gesturechange', (e) => { e.preventDefault(); preview.method = 'pinch'; previewZoom(clampZoom(gestureStart * e.scale), e.clientX, e.clientY); }, { passive: false });
  stage.addEventListener('gestureend', (e) => { e.preventDefault(); commitPreview(); }, { passive: false });
  let pinch = null;
  stage.addEventListener('touchstart', (e) => {
    if (e.touches.length === 2) pinch = { d: touchDist(e), z: previewTarget(), cx: (e.touches[0].clientX + e.touches[1].clientX) / 2, cy: (e.touches[0].clientY + e.touches[1].clientY) / 2 };
  }, { passive: true });
  stage.addEventListener('touchmove', (e) => {
    if (!pinch || e.touches.length !== 2) return;
    e.preventDefault();
    preview.method = 'pinch';
    previewZoom(clampZoom(pinch.z * (touchDist(e) / pinch.d)), pinch.cx, pinch.cy);
  }, { passive: false });
  const endPinch = () => { if (pinch) { pinch = null; commitPreview(); } };
  stage.addEventListener('touchend', endPinch, { passive: true });
  stage.addEventListener('touchcancel', endPinch, { passive: true });
}
function touchDist(e) {
  const dx = e.touches[0].clientX - e.touches[1].clientX, dy = e.touches[0].clientY - e.touches[1].clientY;
  return Math.hypot(dx, dy) || 1;
}

/* ---------------- document selector + download ---------------- */
function setupDocSelector() {
  const sel = $('docSel'); if (!sel) return;
  sel.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-doc]'); if (!b) return;
    const doc = b.dataset.doc;
    if (doc === state.doc) return;
    Reader.emit('doc_switch', { from: state.doc, to: doc });
    location.hash = '#doc=' + doc;   // app.js routes it (history entry → browser back works)
  });
}
function updateDocSelector(doc) {
  document.querySelectorAll('#docSel button[data-doc]').forEach((b) => b.classList.toggle('on', b.dataset.doc === doc));
}
function updateDownloadBtn() {
  const b = $('dlBtn'); if (!b) return;
  if (!CFG.allowDownload) { b.remove(); return; }
  b.style.display = '';
  b.onclick = async () => {
    try {
      const got = await APP.fetchDoc(state.doc);
      const url = URL.createObjectURL(new Blob([got.data], { type: 'application/pdf' }));
      const a = document.createElement('a'); a.href = url; a.download = 'Calculus-Fennicus-II-' + state.doc + '.pdf';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
      Reader.emit('download', { doc: state.doc });
    } catch (e) { toast('Lataus epäonnistui'); }
  };
}

/* ---------------- outline sidebar ---------------- */
function setupOutlineUi() {
  const btn = $('tocBtn'), side = $('outline');
  if (!btn || !side) return;
  const set = (on) => { document.body.classList.toggle('toc-open', on); btn.classList.toggle('on', on); if (state.n) setTimeout(() => setZoom(state.zoom, { method: 'resize' }), 220); };
  btn.onclick = () => { const on = !document.body.classList.contains('toc-open'); set(on); if (on) Reader.emit('outline_open', { doc: state.doc }); };
  $('tocClose').onclick = () => set(false);
  Reader.closeOutlineIfNarrow = () => { if (window.innerWidth < 900) set(false); };
}
async function buildOutline(gen) {
  const list = $('tocList'); if (!list) return;
  list.innerHTML = '<div class="tocEmpty">Ladataan sisällystä…</div>';
  let ol = null;
  try { ol = await state.pdf.getOutline(); } catch (_) {}
  if (gen !== state.gen) return;
  list.innerHTML = '';
  if (!ol || !ol.length) { list.innerHTML = '<div class="tocEmpty">Ei sisällysluetteloa.</div>'; return; }
  const mk = (items, depth) => {
    const ul = document.createElement('ul');
    for (const it of items) {
      const li = document.createElement('li');
      const row = document.createElement('div'); row.className = 'tocRow d' + depth;
      if (it.items && it.items.length) {
        const tg = document.createElement('button'); tg.type = 'button'; tg.className = 'tg'; tg.textContent = '▸'; tg.setAttribute('aria-label', 'Avaa');
        tg.onclick = (e) => { e.stopPropagation(); li.classList.toggle('open'); tg.textContent = li.classList.contains('open') ? '▾' : '▸'; };
        row.appendChild(tg);
        if (depth === 0 && items.length <= 3) { li.classList.add('open'); tg.textContent = '▾'; }
      } else {
        const sp = document.createElement('span'); sp.className = 'tg'; row.appendChild(sp);
      }
      const a = document.createElement('a'); a.href = '#'; a.textContent = it.title || '(nimetön)';
      a.onclick = async (e) => {
        e.preventDefault();
        if (it.dest) { await goToDest(it.dest, state.cur); Reader.emit('outline_nav', { doc: state.doc, title: String(it.title).slice(0, 120) }); }
        Reader.closeOutlineIfNarrow && Reader.closeOutlineIfNarrow();
      };
      row.appendChild(a); li.appendChild(row);
      if (it.items && it.items.length) li.appendChild(mk(it.items, depth + 1));
      ul.appendChild(li);
    }
    return ul;
  };
  list.appendChild(mk(ol, 0));
}

/* ---------------- zoom ---------------- */
const ZOOM_MIN = 0.4, ZOOM_MAX = 5;
function clampZoom(z) { return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z)); }
function fitPageZoom() {
  const w1 = fitScale() / state.zoom;              // scale at zoom 1
  const hAvail = stage.clientHeight - 30;
  return clampZoom(hAvail / (state.base.h * w1));
}
function updateZoomLabel() {
  const el = $('zlabel');
  if (el) el.textContent = Math.round(state.zoom * 100) + ' %';
  const zin = $('zin'), zout = $('zout');
  if (zin) zin.disabled = state.zoom >= ZOOM_MAX - 1e-6;
  if (zout) zout.disabled = state.zoom <= ZOOM_MIN + 1e-6;
}
const preview = { z: null, timer: 0, ax: 0, ay: 0, method: 'wheel' };
function previewTarget() { return preview.z == null ? state.zoom : preview.z; }
function previewZoom(z, clientX, clientY) {
  preview.z = z;
  preview.ax = clientX; preview.ay = clientY;
  const k = z / state.zoom;
  const sr = stage.getBoundingClientRect();
  const px = (clientX == null ? sr.width / 2 : clientX - sr.left), py = (clientY == null ? sr.height / 2 : clientY - sr.top);
  if (!preview.origin) preview.origin = { sx: stage.scrollLeft, sy: stage.scrollTop, px, py };
  pagesEl.style.transformOrigin = '0 0';
  pagesEl.style.transform = 'scale(' + k + ')';
  const docW = pagesEl.offsetWidth * k;
  const shift = Math.max(0, (stage.clientWidth - docW) / 2) - Math.max(0, (stage.clientWidth - pagesEl.offsetWidth) / 2);
  pagesEl.style.marginLeft = (shift > 0 ? shift : 0) + 'px';
  stage.scrollTop = (preview.origin.sy + preview.origin.py) * k - py;
  stage.scrollLeft = (preview.origin.sx + preview.origin.px) * k - px;
  const el = $('zlabel'); if (el) el.textContent = Math.round(z * 100) + ' %';
  clearTimeout(preview.timer); preview.timer = setTimeout(commitPreview, 180);
}
function commitPreview() {
  clearTimeout(preview.timer); preview.timer = 0;
  if (preview.z == null) return;
  const z = preview.z, ax = preview.ax, ay = preview.ay;
  preview.z = null; preview.origin = null;
  pagesEl.style.transform = ''; pagesEl.style.marginLeft = '';
  setZoom(z, { anchorX: ax, anchorY: ay, fromPreview: true, method: preview.method });
}
function setZoom(z, opts = {}) {
  if (!state.n) return;
  const prevZoom = state.zoom;
  const newZoom = clampZoom(z);
  const sr = stage.getBoundingClientRect();
  const ax = opts.anchorX == null ? sr.width / 2 : opts.anchorX - sr.left;
  const ay = opts.anchorY == null ? sr.height * 0.35 : opts.anchorY - sr.top;
  const prevW = pagesEl.offsetWidth || 1, prevH = pagesEl.scrollHeight || 1;
  let fx = (stage.scrollLeft + ax) / prevW, fy = (stage.scrollTop + ay) / prevH;
  if (opts.fromPreview) {
    const k = newZoom / prevZoom;
    fx = (stage.scrollLeft + ax) / (prevW * k); fy = (stage.scrollTop + ay) / (prevH * k);
  }
  state.zoom = newZoom;
  relayoutRerender();
  updateZoomLabel();
  if (opts.method && opts.method !== 'resize' && Math.abs(newZoom - prevZoom) > 1e-6) {
    Reader.emit('zoom', { zoom: Math.round(newZoom * 100) / 100, from: Math.round(prevZoom * 100) / 100, method: opts.method, page: state.cur, doc: state.doc });
  }
  if (opts.keepView === false) return;
  const newW = pagesEl.offsetWidth || 1, newH = pagesEl.scrollHeight || 1;
  stage.scrollTop = fy * newH - ay;
  stage.scrollLeft = fx * newW - ax;
  updateCur();
}

/* ---------------- toast ---------------- */
let toastTimer = 0;
export function toast(msg, err) {
  const t = $('toast'); if (!t) return;
  t.textContent = msg; t.classList.toggle('err', !!err); t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
}
Reader.toast = toast;
