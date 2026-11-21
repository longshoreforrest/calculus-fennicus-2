/* Calculus Fennicus II — Google Sign-In (Google Identity Services).
 *
 * Ported from ../phd/auth.js. Stores the identity under CFG.identityKey
 * ('unitas:identity', the localStorage key the MyPublicAnalytics beacon and
 * Worker already read), so analytics + feedback carry {user,idToken} and the
 * Worker stamps user_verified=1.
 *
 * Exposes window.CF2Auth: { getIdentity(), signOut(), prompt(), renderButton(el), setDevIdentity(id) }
 * and fires 'cf2-auth-change' on window whenever the sign-in state changes.
 * The access gate (app.js) listens to that event and trades the ID token for
 * the content key.
 */
let CFG = {};
let gisReady = false;
const buttonHosts = new Set();

export function initAuth(cfg) {
  CFG = cfg || {};
  window.CF2Auth = {
    getIdentity, signOut, prompt: () => promptSignIn(), isReady: () => gisReady,
    renderButton, setDevIdentity, renderWho,
  };
  renderWho();
  if (!CFG.devBypass) loadGis();
  return window.CF2Auth;
}

function loadGis() {
  if (document.getElementById('gis-sdk')) return;
  const s = document.createElement('script');
  s.id = 'gis-sdk';
  s.src = 'https://accounts.google.com/gsi/client';
  s.async = true;
  s.onload = onGisLoad;
  s.onerror = () => { gisReady = false; renderAllButtons(); window.dispatchEvent(new CustomEvent('cf2-gis-error')); };
  document.head.appendChild(s);
}

function onGisLoad() {
  if (!window.google || !google.accounts || !google.accounts.id) return;
  try {
    google.accounts.id.initialize({
      client_id: CFG.googleClientId,
      callback: onCredential,
      auto_select: true,
      use_fedcm_for_prompt: true,
      cancel_on_tap_outside: false,
    });
    gisReady = true;
    renderAllButtons();
    renderWho();
    // One Tap / automatic re-sign-in when there is no valid identity yet.
    if (!getIdentity()) { try { google.accounts.id.prompt(); } catch (_) {} }
  } catch (e) { console.warn('GIS init failed', e); }
}

function onCredential(resp) {
  if (!resp || !resp.credential) return;
  const claims = decodeJwt(resp.credential);
  if (!claims) return;
  const id = {
    email: claims.email || '',
    name: claims.name || claims.email || '',
    sub: claims.sub || '',
    picture: claims.picture || '',
    idToken: resp.credential,
    exp: claims.exp || 0,
    t: Date.now(),
  };
  try { localStorage.setItem(CFG.identityKey || 'unitas:identity', JSON.stringify(id)); } catch (_) {}
  renderWho();
  window.dispatchEvent(new CustomEvent('cf2-auth-change', { detail: { signedIn: true, id } }));
}

/* Dev bypass (local builds only — app.js enforces the localhost check). */
function setDevIdentity(id) {
  try { localStorage.setItem(CFG.identityKey || 'unitas:identity', JSON.stringify(id)); } catch (_) {}
  renderWho();
  window.dispatchEvent(new CustomEvent('cf2-auth-change', { detail: { signedIn: true, id, dev: true } }));
}

export function getIdentity() {
  try {
    const raw = localStorage.getItem(CFG.identityKey || 'unitas:identity');
    if (!raw) return null;
    const id = JSON.parse(raw);
    if (id && id.exp && id.exp * 1000 < Date.now() - 5000) return null; // token expired
    return id && id.email ? id : null;
  } catch (_) { return null; }
}

export function signOut() {
  try { if (window.google && google.accounts) google.accounts.id.disableAutoSelect(); } catch (_) {}
  try { localStorage.removeItem(CFG.identityKey || 'unitas:identity'); } catch (_) {}
  renderWho();
  window.dispatchEvent(new CustomEvent('cf2-auth-change', { detail: { signedIn: false } }));
}

function promptSignIn() {
  if (!gisReady) { loadGis(); return; }
  try { google.accounts.id.prompt(); } catch (e) { console.warn(e); }
}

/* ---- buttons ---- */
function renderButton(el, opts) {
  if (!el) return;
  buttonHosts.add([el, opts || {}]);
  drawButton(el, opts || {});
}
function renderAllButtons() { for (const [el, o] of buttonHosts) drawButton(el, o); }
function drawButton(el, o) {
  el.innerHTML = '';
  if (gisReady && window.google) {
    try {
      google.accounts.id.renderButton(el, Object.assign({ type: 'standard', theme: 'outline', size: 'large', text: 'signin_with', shape: 'pill', locale: 'fi' }, o));
      return;
    } catch (_) {}
  }
  const b = document.createElement('button');
  b.className = 'btn primary';
  b.type = 'button';
  b.textContent = CFG.devBypass ? 'Kirjaudu (kehitystila)' : 'Kirjaudu Google-tilillä';
  b.onclick = () => (CFG.devBypass ? window.dispatchEvent(new CustomEvent('cf2-dev-signin')) : promptSignIn());
  el.appendChild(b);
}

/* Reader top bar: who am I + sign-out, or a sign-in button when the token expired. */
function renderWho() {
  const who = document.getElementById('who');
  const gbtn = document.getElementById('gbtn');
  if (!who || !gbtn) return;
  const id = getIdentity();
  if (id) {
    gbtn.style.display = 'none';
    who.innerHTML = '';
    if (id.picture) { const img = document.createElement('img'); img.src = id.picture; img.alt = ''; img.referrerPolicy = 'no-referrer'; who.appendChild(img); }
    const span = document.createElement('span'); span.className = 'hide-sm'; span.textContent = id.name || id.email; who.appendChild(span);
    const out = document.createElement('button'); out.className = 'btn'; out.textContent = 'Kirjaudu ulos'; out.title = 'Kirjaudu ulos ja lukitse sisältö';
    out.onclick = () => window.dispatchEvent(new CustomEvent('cf2-signout-request'));
    who.appendChild(out);
    who.style.display = 'flex';
  } else {
    who.style.display = 'none';
    gbtn.style.display = '';
    gbtn.title = 'Kirjautuminen vanhentui — kirjaudu uudelleen kommentoidaksesi';
    drawButton(gbtn, { size: 'medium' });
  }
}

function decodeJwt(t) {
  try {
    const p = t.split('.')[1];
    const json = atob(p.replace(/-/g, '+').replace(/_/g, '/'));
    return JSON.parse(decodeURIComponent(escape(json)));
  } catch (_) { return null; }
}
