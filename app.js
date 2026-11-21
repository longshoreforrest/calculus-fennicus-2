/* Calculus Fennicus II — application shell (ES module, entry point).
 *
 *  1. Gate: Google Identity Services sign-in → POST {idToken} to CFG.gateEndpoint
 *     → 200 {key, email, owner} | 403 {error:'not_allowed', email} | 401 {error:'bad_token'}.
 *     The key (base64 of 32 raw bytes) lives only in memory + sessionStorage (this tab).
 *  2. Decrypt: every asset in enc/ is  IV (12 bytes) ‖ AES-256-GCM ciphertext ‖ tag (16 bytes)
 *     — the WebCrypto layout. content.json.enc renders the homepage; the PDFs are
 *     decrypted in memory and handed to pdf.js as bytes (never a URL, Blob or file).
 *  3. Routing on the URL hash: '#doc=…' → reader, anything else → homepage. The hash
 *     survives sign-in (nothing navigates away), so deep links land after the gate.
 *
 * Local dev bypass: with a localhost gateEndpoint (publish2.mjs --local) and
 * ?devtoken=1 in the URL, GIS is skipped and the mock gate (tools/cf2-mock-gate.mjs)
 * hands out the key. ?devtoken=deny / ?devtoken=bad simulate 403 / 401.
 */
const CFG = window.CF2_CONFIG || {};
const V = CFG.buildVersion && CFG.buildVersion !== 'dev' ? '?v=' + encodeURIComponent(CFG.buildVersion) : '';
const KEY_SS = 'cf2:key';
const $ = (id) => document.getElementById(id);

const isLocalGate = (() => {
  try { const h = new URL(CFG.gateEndpoint, location.href).hostname; return h === 'localhost' || h === '127.0.0.1'; } catch (_) { return false; }
})();
const devParam = new URLSearchParams(location.search).get('devtoken');
CFG.devBypass = !!(isLocalGate && devParam);

/* ---------------- analytics (MyPublicAnalytics beacon) ---------------- */
const trackQueue = [];
function track(ev, extra) {
  if (CFG.analytics === false) return;
  const go = () => { try { window.mypa.send(ev, extra || {}); } catch (_) {} };
  if (window.mypa && window.mypa.send) go(); else trackQueue.push(go);
}
(function waitBeacon(t) {
  if (window.mypa && window.mypa.send) { while (trackQueue.length) trackQueue.shift()(); return; }
  if (t < 40) setTimeout(() => waitBeacon(t + 1), 250);
})(0);

/* ---------------- crypto ---------------- */
let cryptoKey = null;
const jsonCache = new Map();

function b64ToBytes(b64) {
  const s = atob(String(b64).trim().replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
async function importKey(b64) {
  const raw = b64ToBytes(b64);
  if (raw.length !== 32) throw new Error('key must be 32 bytes');
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['decrypt']);
}
async function fetchEnc(name, onProgress) {
  const r = await fetch(CFG.encDir + name + V, { cache: 'default' });
  if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + name);
  const total = Number(r.headers.get('content-length')) || 0;
  if (!r.body || !onProgress || !total) return new Uint8Array(await r.arrayBuffer());
  const reader = r.body.getReader();
  const buf = new Uint8Array(total);
  let off = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (off + value.length > buf.length) { // content-length lied (compression): fall back to concatenation
      const bigger = new Uint8Array(Math.max(buf.length * 2, off + value.length)); bigger.set(buf.subarray(0, off)); return finishGrow(bigger, off, value, reader, onProgress, total);
    }
    buf.set(value, off); off += value.length;
    onProgress(off, total);
  }
  return off === buf.length ? buf : buf.subarray(0, off);
}
async function finishGrow(buf, off, first, reader, onProgress, total) {
  let chunks = [buf.subarray(0, off), first]; let n = off + first.length;
  for (;;) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); n += value.length; onProgress(Math.min(n, total), total); }
  const out = new Uint8Array(n); let o = 0; for (const c of chunks) { out.set(c, o); o += c.length; } return out;
}
async function decryptBytes(buf, key = cryptoKey) {
  if (!key) throw new Error('locked');
  if (buf.length < 12 + 16) throw new Error('ciphertext too short');
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: buf.subarray(0, 12) }, key, buf.subarray(12));
  return new Uint8Array(pt);
}
async function decryptJson(name, key) {
  if (jsonCache.has(name)) return jsonCache.get(name);
  const j = JSON.parse(new TextDecoder().decode(await decryptBytes(await fetchEnc(name), key)));
  jsonCache.set(name, j);
  return j;
}
async function fetchDoc(doc, onProgress) {
  const [enc, dests, labels] = await Promise.all([
    fetchEnc(doc + '.pdf.enc', onProgress),
    decryptJson('dests-' + doc + '.json.enc').catch(() => ({})),
    decryptJson('labels-' + doc + '.json.enc').catch(() => ({})),
  ]);
  const data = await decryptBytes(enc);
  return { data, dests, labels };
}

/* ---------------- gate ---------------- */
let content = null;
let unlocking = false;

function gateMsg(html, kind) {
  const m = $('gateMsg'); if (!m) return;
  m.className = 'gateMsg' + (kind ? ' ' + kind : '');
  m.textContent = '';
  if (html instanceof Node) m.appendChild(html); else m.textContent = html || '';
}
function showView(v) {
  document.body.dataset.view = v;
  $('gate').hidden = v !== 'gate';
  $('home').hidden = v !== 'home';
  $('reader').hidden = v !== 'reader';
}

async function unlock(b64, how) {
  let key;
  try { key = await importKey(b64); } catch (_) { return false; }
  let c;
  try { jsonCache.delete('content.json.enc'); c = await decryptJson('content.json.enc', key); }
  catch (e) { jsonCache.clear(); return false; }
  cryptoKey = key; content = c;
  try { sessionStorage.setItem(KEY_SS, b64); } catch (_) {}
  renderHome(content);
  route({ initial: true });
  if (how) document.documentElement.dataset.unlocked = how;
  return true;
}

let pendingReq = null;
async function sendAccessRequest(ev) {
  ev.preventDefault();
  if (!pendingReq) return;
  const btn = $('gateReqBtn'); btn.disabled = true; btn.textContent = 'Lähetetään…';
  try {
    const r = await fetch(CFG.gateEndpoint.replace(/\/key$/, '/request'), {
      method: 'POST', mode: 'cors', credentials: 'omit',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken: pendingReq.idToken, message: $('gateReqMsg').value.trim() }),
    });
    if (!r.ok) throw new Error(String(r.status));
    $('gateReq').hidden = true;
    gateMsg('Pyyntö lähetetty kirjoittajalle (' + pendingReq.email + '). Saat tiedon, kun käyttöoikeus on lisätty — kirjaudu silloin uudelleen.');
    track('access_request', { email: pendingReq.email });
  } catch (e) {
    btn.disabled = false; btn.textContent = 'Yritä uudelleen';
    gateMsg('Pyynnön lähetys epäonnistui. Yritä hetken kuluttua uudelleen.', 'err');
  }
}

async function requestKey(id) {
  if (unlocking || cryptoKey) return;
  unlocking = true;
  gateMsg('Tarkistetaan käyttöoikeutta…');
  $('gateOut').hidden = true;
  if ($('gateReq')) $('gateReq').hidden = true;
  let r, j = {};
  try {
    r = await fetch(CFG.gateEndpoint, {
      method: 'POST', mode: 'cors', credentials: 'omit',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken: id.idToken }),
    });
    try { j = await r.json(); } catch (_) {}
  } catch (e) {
    unlocking = false;
    gateMsg('Avainpalveluun ei saatu yhteyttä. Yritä hetken kuluttua uudelleen.', 'err');
    track('signin_error', { reason: 'network', email: id.email });
    return;
  }
  unlocking = false;
  if (r.status === 200 && j.key) {
    const ok = await unlock(j.key, 'gate');
    if (ok) {
      track('signin_ok', { email: j.email || id.email, owner: !!j.owner, dev: !!CFG.devBypass });
      gateMsg('');
    } else {
      gateMsg('Avain saatiin, mutta sisällön purku epäonnistui. Sivustoa saatetaan päivittää — yritä hetken kuluttua.', 'err');
      track('signin_error', { reason: 'decrypt', email: j.email || id.email });
    }
    return;
  }
  if (r.status === 403) {
    const email = j.email || id.email || '';
    gateMsg('Ei käyttöoikeutta (' + email + ').', 'err');
    $('gateOut').hidden = false;
    pendingReq = { idToken: id.idToken, email };
    if ($('gateReq')) { $('gateReq').hidden = false; $('gateReqBtn').disabled = false; $('gateReqBtn').textContent = 'Pyydä käyttöoikeutta'; }
    track('signin_denied', { email, error: j.error || 'not_allowed' });
    return;
  }
  if (r.status === 401) {
    gateMsg('Kirjautuminen ei kelvannut. Kirjaudu uudelleen.', 'err');
    track('signin_error', { reason: 'bad_token', email: id.email });
    window.CF2Auth && window.CF2Auth.signOut();
    return;
  }
  gateMsg('Avainpalvelu vastasi virheellä (' + r.status + ').', 'err');
  track('signin_error', { reason: 'http_' + r.status, email: id.email });
}

function devSignIn() {
  if (!CFG.devBypass) return;
  const tok = devParam === 'deny' ? 'deny' : devParam === 'bad' ? 'bad' : 'dev';
  const id = { email: tok === 'deny' ? 'denied@example.com' : 'dev@localhost', name: 'Kehittäjä (paikallinen)', sub: 'dev', picture: '', idToken: tok, exp: Math.floor(Date.now() / 1000) + 3600, t: Date.now(), dev: true };
  window.CF2Auth.setDevIdentity(id);
}

function signOutAll() {
  track('signout', {});
  try { sessionStorage.removeItem(KEY_SS); } catch (_) {}
  cryptoKey = null; content = null; jsonCache.clear();
  window.CF2Auth && window.CF2Auth.signOut();
  // reload drops every decrypted byte from memory
  setTimeout(() => { location.replace(location.pathname + location.search); }, 150);
}

/* ---------------- download / print blocking ---------------- */
if (!CFG.allowDownload) {
  window.addEventListener('keydown', (e) => {
    const k = (e.key || '').toLowerCase();
    if ((e.metaKey || e.ctrlKey) && (k === 's' || k === 'p')) {
      e.preventDefault(); e.stopPropagation();
      flash('Tallennus ja tulostus eivät ole käytössä.');
      track('blocked', { action: k === 's' ? 'save' : 'print' });
    }
  }, true);
  window.addEventListener('beforeprint', () => track('blocked', { action: 'print_menu' }));
}
function flash(msg) {
  const t = $('toast'); if (!t) return;
  t.textContent = msg; t.classList.add('show');
  clearTimeout(flash.t); flash.t = setTimeout(() => t.classList.remove('show'), 2600);
}

/* ---------------- routing ---------------- */
let readerMods = null;
async function loadReader() {
  if (readerMods) return readerMods;
  readerMods = (async () => {
    const rm = await import('./reader.js' + V);
    const R = rm.initReader({ fetchDoc });
    const load = (f, fn) => import('./' + f + V).then(fn).catch((e) => console.warn(f + ' init', e));
    load('search.js', (m) => { R.search = m.initSearch(R); });
    load('comments.js', (m) => m.initComments(R, CFG));
    load('activity.js', (m) => m.initActivity(R, CFG));
    load('owner.js', (m) => { R.owner = m.initOwner(R, CFG); });
    return { rm, R };
  })();
  return readerMods;
}

async function route(opts = {}) {
  if (!cryptoKey) return;
  const h = new URLSearchParams((location.hash || '').replace(/^#/, ''));
  if (h.get('doc')) {
    showView('reader');
    const { rm, R } = await loadReader();
    const doc = rm.parseDoc(location.hash) || CFG.defaultDoc || 'kirja';
    await R.open(doc, rm.parseTarget(location.hash), { fromHash: true });
    return;
  }
  showView('home');
  const anchor = (location.hash || '').replace(/^#/, '');
  const el = anchor && !anchor.includes('=') ? document.getElementById(anchor) : null;
  if (el) el.scrollIntoView({ behavior: opts.initial ? 'auto' : 'smooth' });
  else if (!opts.initial) window.scrollTo(0, 0);
}
window.addEventListener('hashchange', () => route());

/* ---------------- homepage ---------------- */
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}
const fmt = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
const getLang = () => { try { return localStorage.getItem(CFG.langKey || 'cf2-lang') === 'en' ? 'en' : 'fi'; } catch (_) { return 'fi'; } };
const setLang = (l) => { try { localStorage.setItem(CFG.langKey || 'cf2-lang', l); } catch (_) {} };
const langDoc = (doc) => (getLang() === 'en' && CFG.docs && CFG.docs[doc + '-en'] ? doc + '-en' : doc);
const docHref = (doc, dest) => '#doc=' + langDoc(doc) + (dest ? '&dest=' + encodeURIComponent(dest) : '');
function langSwitch(onChange) {
  const mk = (l, label, title) => {
    const flag = h('span', { class: 'flag' }); flag.innerHTML = (CFG.flags && CFG.flags[l]) || '';
    return h('button', { type: 'button', class: getLang() === l ? 'on' : '', title, 'aria-pressed': getLang() === l ? 'true' : 'false',
      onclick: () => { if (getLang() !== l) { setLang(l); onChange(); } } }, flag, h('span', {}, label));
  };
  return h('div', { class: 'langsel', role: 'group', 'aria-label': 'Kieli / Language' }, mk('fi', 'FI', 'Suomeksi'), mk('en', 'EN', 'In English'));
}

function renderHome(c) {
  const home = $('home');
  home.innerHTML = '';
  const id = window.CF2Auth && window.CF2Auth.getIdentity();
  const S = c.stats || {};

  const themeBtn = h('button', { class: 'iconbtn', type: 'button', title: 'Vaihda teema', 'aria-label': 'Vaihda teema', onclick: toggleTheme }, '◐');
  const userChip = h('div', { class: 'user' },
    id && id.picture ? h('img', { src: id.picture, alt: '', referrerpolicy: 'no-referrer' }) : null,
    h('span', { class: 'hide-sm' }, id ? (id.name || id.email) : ''),
    h('button', { class: 'linkbtn', type: 'button', onclick: () => signOutAll() }, 'Kirjaudu ulos'));

  const header = h('header', { class: 'top' },
    h('a', { class: 'brand', href: '#' }, h('span', { class: 'mark sm' }, 'CF', h('sup', {}, 'II')), h('span', { class: 'hide-sm' }, c.title)),
    h('nav', { class: 'nav' },
      h('a', { href: '#lue' }, 'Lue'), h('a', { href: '#osat' }, 'Osat'),
      h('a', { href: '#niteet', class: 'hide-sm' }, 'Kaksi nidettä'), h('a', { href: '#tekijat', class: 'hide-sm' }, 'Tekijä'),
      c.volume1 ? h('a', { href: c.volume1.url, target: '_blank', rel: 'noopener' }, 'Nide 1 ↗') : null),
    langSwitch(() => renderHome(c)), themeBtn, userChip);

  const U = c.ui || {};
  const SL = U.statLabels || {};
  const stats = ['pages', 'chapters', 'exercises', 'figures'].map((k) => [S[k], SL[k] || k]).filter((x) => x[0] != null);

  const hero = h('section', { class: 'hero', id: 'top' },
    h('p', { class: 'kicker' }, U.kicker || ''),
    h('h1', {}, c.title, h('span', { class: 'sub' }, c.subtitle)),
    h('p', { class: 'lead' }, c.lead),
    h('p', { class: 'mission' }, c.mission),
    h('div', { class: 'cta' },
      h('a', { class: 'btn primary lg', href: docHref('kirja') }, getLang() === 'en' ? 'Read the book' : 'Lue kirja'),
      h('a', { class: 'btn lg', href: '#osat' }, 'Selaa osia')),
    h('dl', { class: 'stats' }, stats.map(([n, l]) => h('div', { class: 'stat' }, h('dt', {}, fmt(n)), h('dd', {}, l)))));

  const docOrder = ['kirja', 'ratkaisut', 'lukukartta'];
  const docs = h('section', { class: 'section', id: 'lue' },
    h('h2', {}, U.docsHeading || ''),
    h('p', { class: 'muted' }, U.docsIntro || ''),
    h('div', { class: 'cards three' }, docOrder.filter((d) => c.docs && c.docs[d]).map((d, i) => {
      const D = c.docs[langDoc(d)] || c.docs[d];
      return h('a', { class: 'card doc d' + i, href: docHref(d) },
        h('span', { class: 'ico', 'aria-hidden': 'true' }, ['📖', '✎', '🗺'][i]),
        h('h3', {}, D.title),
        h('p', { class: 'name' }, D.name),
        h('p', {}, D.desc),
        h('p', { class: 'meta' }, D.pages ? fmt(D.pages) + ' s.' : '', CFG.allowDownload ? ' · PDF ladattavissa' : ''),
        h('span', { class: 'go' }, 'Avaa lukijassa →'));
    })));

  const parts = h('section', { class: 'section', id: 'osat' },
    h('h2', {}, U.partsHeading || ''),
    h('p', { class: 'muted' }, U.partsIntro || ''),
    h('div', { class: 'cards parts' }, (c.parts || []).map((p) => h('article', { class: 'card part' },
      h('a', { class: 'cover', href: docHref('kirja', p.dest), 'aria-label': p.kicker + ': ' + p.title },
        h('span', { class: 'num' }, p.id),
        h('span', { class: 'kick' }, p.kicker + (p.page ? ' · s. ' + p.page + (p.endPage ? '–' + p.endPage : '') : '')),
        h('h3', {}, p.title)),
      h('p', {}, p.summary),
      p.luvut && p.luvut.length ? h('details', {},
        h('summary', {}, p.luvut.length + ' lukua' + (p.exercises ? ' · ' + p.exercises + ' tehtävää' : '')),
        h('ol', { class: 'luvut' }, p.luvut.map((l) => h('li', {}, h('a', { href: docHref('kirja', l.dest) }, h('span', { class: 'ref' }, l.ref), ' ', l.title))))) : null,
      h('div', { class: 'links' },
        h('a', { href: docHref('kirja', p.dest) }, 'Avaa osa →'),
        p.ratkDest ? h('a', { href: docHref('ratkaisut', p.ratkDest) }, 'Ratkaisut →') : null)))));

  const cont = h('section', { class: 'section split', id: 'niteet' },
    h('div', {},
      h('h2', {}, U.contHeading || ''),
      (c.continuation || []).map((t) => h('p', {}, t)),
      c.volume1 ? h('p', {}, h('a', { class: 'btn', href: c.volume1.url, target: '_blank', rel: 'noopener' }, c.volume1.label + ' ↗')) : null),
    h('ol', { class: 'timeline' },
      (U.timeline || []).map((t) => h('li', { class: t.now ? 'now' : null }, h('b', {}, t.title), h('span', {}, t.text)))));

  const authors = h('section', { class: 'section', id: 'tekijat' },
    h('h2', {}, U.authorsHeading || ''),
    h('div', { class: 'authors' }, (c.authors || []).map((a) => h('div', { class: 'author' },
      h('span', { class: 'av', 'aria-hidden': 'true' }, a.initials), h('div', {}, a.url ? h('a', { href: a.url, target: '_blank', rel: 'noopener' }, h('b', {}, a.name + ' ↗')) : h('b', {}, a.name), h('span', {}, a.role))))),
    h('p', {}, c.authorsText),
    c.volume1Author ? h('p', { class: 'muted' }, c.volume1Author.text + ' ', h('a', { href: c.volume1Author.url, target: '_blank', rel: 'noopener' }, c.volume1Author.name + ' ↗')) : null,
    h('h3', {}, U.licenseHeading || ''),
    h('p', {}, c.license, ' ', c.licenseUrl ? h('a', { href: c.licenseUrl, target: '_blank', rel: 'noopener' }, (c.licenseLabel || 'Lisenssi') + ' ↗') : null),
    c.thanks ? h('p', { class: 'muted' }, c.thanks) : null);

  const footer = h('footer', { class: 'foot' },
    h('span', {}, c.title + ' — ' + c.subtitle),
    h('nav', { class: 'footlinks' }, (c.links || []).map((l) => h('a', { href: l.url, target: '_blank', rel: 'noopener' }, l.label + ' ↗'))),
    h('span', { class: 'muted' }, 'Versio ' + (c.build || CFG.buildVersion)));

  home.append(header, hero, docs, parts, cont, authors, footer);
}

function toggleTheme() {
  const cur = document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  const next = cur === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('cf2:theme', next); } catch (_) {}
}

/* ---------------- reader chrome hooks ---------------- */
$('homeBtn').addEventListener('click', (e) => { e.preventDefault(); history.pushState(null, '', location.pathname + location.search); route(); });
window.addEventListener('cf2-signout-request', () => signOutAll());

/* ---------------- boot ---------------- */
(async function boot() {
  showView('gate');
  const auth = await import('./auth.js' + V);
  auth.initAuth(CFG);
  $('gateOut').addEventListener('click', () => { window.CF2Auth.signOut(); gateMsg(''); $('gateOut').hidden = true; if ($('gateReq')) $('gateReq').hidden = true; pendingReq = null; window.CF2Auth.prompt(); });
  if ($('gateReq')) $('gateReq').addEventListener('submit', sendAccessRequest);
  window.addEventListener('cf2-auth-change', (e) => { if (e.detail && e.detail.signedIn && !cryptoKey) requestKey(e.detail.id); });
  window.addEventListener('cf2-dev-signin', devSignIn);
  window.addEventListener('cf2-gis-error', () => { if (!cryptoKey) gateMsg('Google-kirjautumista ei voitu ladata. Tarkista verkkoyhteys tai selaimen eston asetukset.', 'err'); });

  // 1) same tab, already unlocked → straight in
  let saved = null;
  try { saved = sessionStorage.getItem(KEY_SS); } catch (_) {}
  if (saved && await unlock(saved, 'session')) return;
  try { sessionStorage.removeItem(KEY_SS); } catch (_) {}

  // 2) gate
  window.CF2Auth.renderButton($('gateBtn'));
  if (CFG.devBypass) { gateMsg('Kehitystila: paikallinen avainpalvelu.'); devSignIn(); return; }
  const id = window.CF2Auth.getIdentity();
  if (id && !id.dev) requestKey(id);   // still-valid Google token from an earlier visit
})();
