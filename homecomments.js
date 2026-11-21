/* homecomments.js — comments on the Calculus Fennicus II home page.
 *
 * The same pipeline as the PDF reader's comments: POST to MyPublicAnalytics /collect
 * (event 'feedback', site CFG.site) → Telegram notification → kommentit-hae / -analysoi /
 * -toteuta skills. Each comment carries:
 *   extra.doc = 'etusivu', extra.book = 'cf2'
 *   extra.section  id of the home-page section (top, lue, osat, niteet, tekijat, alatunniste)
 *   extra.key      content.src.json path of the commented element when known
 *                  (e.g. "parts.XV", "docs.kirja", "authorsText"), set with data-key in app.js
 *   extra.quote    selected text (kind 'selection'), or none (kind 'section' / 'page')
 *   extra.anchor   {dest: 'home:<section>'}  → shown as "kotisivu § <section>" in Telegram
 *   extra.url      deep link to the section
 * Signed-in only (the whole site is), so every comment has a verified Google identity.
 * Local/dev builds (CFG.devBypass) do not send anything.
 */
const $ = (id) => document.getElementById(id);
let CFG = {}, flash = () => {}, sel = null, built = false;

const SECTION_NAMES = {
  fi: { top: 'Alku', lue: 'Lue verkossa', osat: 'Osat', niteet: 'Kaksi nidettä', vertailu: 'Vertailu', tekijat: 'Tekijä ja lisenssi', alatunniste: 'Alatunniste' },
  en: { top: 'Top', lue: 'Read online', osat: 'Parts', niteet: 'Two volumes', vertailu: 'Comparison', tekijat: 'Author and licence', alatunniste: 'Footer' },
};
const T = {
  fi: { fab: 'Kommentoi sivua', bubble: 'Kommentoi', title: 'Kommentoi kotisivua', where: 'Kohta', ph: 'Mitä tähän pitäisi muuttaa? Virhe, ehdotus tai kysymys…',
        cat: { general: 'Yleinen', error: 'Virhe', suggestion: 'Ehdotus', question: 'Kysymys' }, send: 'Lähetä', cancel: 'Peruuta',
        sending: 'Lähetetään…', thanks: 'Kiitos! Kommentti välitettiin kirjoittajalle.', fail: 'Lähetys epäonnistui: ', empty: 'Kirjoita kommentti.',
        dev: 'Kehitystila: kommenttia ei lähetetty.', whole: 'koko sivu' },
  en: { fab: 'Comment on this page', bubble: 'Comment', title: 'Comment on the home page', where: 'Location', ph: 'What should change here? An error, a suggestion or a question…',
        cat: { general: 'General', error: 'Error', suggestion: 'Suggestion', question: 'Question' }, send: 'Send', cancel: 'Cancel',
        sending: 'Sending…', thanks: 'Thank you! Your comment was sent to the author.', fail: 'Sending failed: ', empty: 'Please write a comment.',
        dev: 'Development mode: the comment was not sent.', whole: 'whole page' },
};
const lang = () => { try { return localStorage.getItem(CFG.langKey || 'cf2-lang') === 'en' ? 'en' : 'fi'; } catch (_) { return 'fi'; } };
const t = () => T[lang()];

function el(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c != null) e.append(c instanceof Node ? c : String(c));
  return e;
}

/** section id + content key + human label for a node inside #home */
function locate(node) {
  const n = node && (node.nodeType === 1 ? node : node.parentElement);
  const keyEl = n && n.closest('[data-key]');
  const secEl = n && n.closest('#home section[id], #home footer');
  const section = secEl ? (secEl.id || 'alatunniste') : 'top';
  const key = keyEl ? keyEl.dataset.key : '';
  const label = (SECTION_NAMES[lang()][section] || section) + (keyEl && keyEl.dataset.label ? ' · ' + keyEl.dataset.label : '');
  return { section, key, label };
}

function build() {
  if (built) return;
  built = true;
  const fab = el('button', { id: 'hcFab', class: 'hc-fab', type: 'button', onclick: () => openComposer(null) }, '💬 ', el('span', { id: 'hcFabTxt' }));
  const bubble = el('button', { id: 'hcBubble', class: 'hc-bubble', type: 'button', hidden: true,
    onmousedown: (e) => e.preventDefault(), onclick: () => openComposer(sel) }, '💬 ', el('span', { id: 'hcBubbleTxt' }));
  const dlg = el('dialog', { id: 'hcDlg', class: 'hc-dlg' },
    el('form', { method: 'dialog', id: 'hcForm' },
      el('h3', { id: 'hcTitle' }),
      el('p', { class: 'hc-where' }, el('b', { id: 'hcWhereL' }), ' ', el('span', { id: 'hcWhere' })),
      el('blockquote', { id: 'hcQuote', class: 'hc-quote', hidden: true }),
      el('textarea', { id: 'hcText', rows: 5, maxlength: 4000 }),
      el('div', { class: 'hc-row' },
        el('select', { id: 'hcCat' }),
        el('span', { class: 'hc-sp' }),
        el('button', { type: 'button', class: 'btn', id: 'hcCancel', onclick: () => $('hcDlg').close() }),
        el('button', { type: 'submit', class: 'btn primary', id: 'hcSend' }))));
  document.body.append(fab, bubble, dlg);
  $('hcForm').addEventListener('submit', (e) => { e.preventDefault(); submit(); });

  const onSel = () => setTimeout(() => {
    const s = window.getSelection();
    const home = $('home');
    if (!s || s.isCollapsed || !home || home.hidden || !home.contains(s.anchorNode)) { bubble.hidden = true; return; }
    const quote = s.toString().replace(/\s+/g, ' ').trim();
    if (quote.length < 2) { bubble.hidden = true; return; }
    const r = s.getRangeAt(0).getBoundingClientRect();
    sel = { quote: quote.slice(0, 600), ...locate(s.anchorNode) };
    $('hcBubbleTxt').textContent = t().bubble;
    bubble.style.left = Math.max(8, Math.min(window.innerWidth - 140, r.left + r.width / 2 - 55)) + 'px';
    bubble.style.top = Math.max(8, r.top - 46) + 'px';
    bubble.hidden = false;
  }, 10);
  document.addEventListener('mouseup', onSel);
  document.addEventListener('touchend', onSel);
  document.addEventListener('scroll', () => { bubble.hidden = true; }, { passive: true });
}

function openComposer(s) {
  $('hcBubble').hidden = true;
  const L = t();
  const target = s || { quote: '', ...locateFromScroll() };
  $('hcDlg').dataset.ctx = JSON.stringify(target);
  $('hcTitle').textContent = L.title;
  $('hcWhereL').textContent = L.where + ':';
  $('hcWhere').textContent = target.label || L.whole;
  $('hcQuote').hidden = !target.quote; $('hcQuote').textContent = target.quote || '';
  $('hcText').value = ''; $('hcText').placeholder = L.ph;
  $('hcCat').innerHTML = '';
  for (const [v, l] of Object.entries(L.cat)) $('hcCat').append(el('option', { value: v }, l));
  $('hcCancel').textContent = L.cancel; $('hcSend').textContent = L.send; $('hcSend').disabled = false;
  $('hcDlg').showModal();
  setTimeout(() => $('hcText').focus(), 30);
}

/** FAB without a selection: the section nearest the top of the viewport */
function locateFromScroll() {
  const secs = [...document.querySelectorAll('#home section[id], #home footer')];
  let best = secs[0];
  for (const s of secs) if (s.getBoundingClientRect().top <= 120) best = s;
  return best ? locate(best) : { section: 'top', key: '', label: '' };
}

async function submit() {
  const L = t();
  const message = $('hcText').value.trim();
  if (!message) { flash(L.empty); return; }
  const ctx = JSON.parse($('hcDlg').dataset.ctx || '{}');
  const id = window.CF2Auth && window.CF2Auth.getIdentity();
  const base = location.origin + location.pathname;
  const extra = {
    book: 'cf2', doc: 'etusivu', kind: ctx.quote ? 'selection' : 'section', page: null,
    section: ctx.section, key: ctx.key || undefined, label: ctx.label, quote: ctx.quote || undefined,
    message, category: $('hcCat').value, lang: lang(), v: CFG.buildVersion,
    url: base + '#' + (ctx.section || 'top'), anchor: { dest: 'home:' + (ctx.section || 'top') },
  };
  if (CFG.devBypass || !CFG.collectEndpoint) { flash(L.dev); $('hcDlg').close(); return; }
  const send = $('hcSend'); send.disabled = true; send.textContent = L.sending;
  try {
    const resp = await fetch(CFG.collectEndpoint, {
      method: 'POST', mode: 'cors', keepalive: true, headers: { 'content-type': 'text/plain;charset=UTF-8' },
      body: JSON.stringify({ site: CFG.site, path: location.pathname, event: 'feedback', extra,
        user: id ? { email: id.email, name: id.name, sub: id.sub } : undefined, idToken: id ? id.idToken : undefined }),
    });
    if (!resp.ok && resp.status !== 204 && resp.status !== 0) throw new Error('HTTP ' + resp.status);
    $('hcDlg').close();
    flash(L.thanks);
  } catch (e) {
    flash(L.fail + (e.message || e));
    send.disabled = false; send.textContent = L.send;
  }
}

/** called after every home render (language switch re-renders) */
export function initHomeComments(cfg, flashFn) {
  CFG = cfg || {}; flash = flashFn || flash;
  build();
  $('hcFabTxt').textContent = t().fab;
  $('hcFab').hidden = false;
}
export function hideHomeComments() {
  if ($('hcFab')) $('hcFab').hidden = true;
  if ($('hcBubble')) $('hcBubble').hidden = true;
}
