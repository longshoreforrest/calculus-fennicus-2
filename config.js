/* Calculus Fennicus II — runtime config (classic script, loaded first in <head>).
 *
 * The ONE place to tune the site. publish2.mjs copies this file into the build
 * and overwrites buildVersion / docVersions (and, with --local, gateEndpoint +
 * analytics). Nothing secret belongs here: the content key comes from the
 * cf2-gate Worker after a verified Google sign-in, never from this file.
 */
window.CF2_CONFIG = {
  title: 'Calculus Fennicus II — Oppimisen matematiikka',

  // ---- Access gate (Cloudflare Worker cf2-gate) ----
  // POST {idToken} → 200 {key (base64, 32 bytes), email, owner} | 403 {error:'not_allowed'} | 401 {error:'bad_token'}
  gateEndpoint: 'https://cf2-gate.longshoreforrest.workers.dev/key',
  // Encrypted assets (12-byte IV ‖ AES-256-GCM ciphertext+tag), relative to index.html.
  encDir: './enc/',

  // ---- Documents in the reader ----
  docs: {
    kirja:      { label: 'Kirja',      short: 'Kirja' },
    ratkaisut:  { label: 'Ratkaisut',  short: 'Ratk.' },
    lukukartta: { label: 'Lukukartta', short: 'Kartta' },
    'kirja-en':     { label: 'Book (EN)',      short: 'EN' },
    'ratkaisut-en': { label: 'Solutions (EN)', short: 'EN sol.' },
  },
  defaultDoc: 'kirja',
  // Language switch (FI / EN): a document id with the suffix '-en' is the English edition of the base id.
  langKey: 'cf2-lang',
  flags: {
    fi: '<svg viewBox="0 0 18 11" width="18" height="11" aria-hidden="true"><rect width="18" height="11" fill="#fff"/><rect x="5" width="3" height="11" fill="#003580"/><rect y="4" width="18" height="3" fill="#003580"/></svg>',
    en: '<svg viewBox="0 0 60 36" width="18" height="11" aria-hidden="true" preserveAspectRatio="none"><rect width="60" height="36" fill="#012169"/><path d="M0,0 L60,36 M60,0 L0,36" stroke="#fff" stroke-width="7"/><path d="M0,0 L60,36 M60,0 L0,36" stroke="#C8102E" stroke-width="2.5"/><path d="M30,0 v36 M0,18 h60" stroke="#fff" stroke-width="12"/><path d="M30,0 v36 M0,18 h60" stroke="#C8102E" stroke-width="7"/></svg>',
  },

  // Links inside the PDFs that point at these bases open IN the reader (no reload).
  siteBaseUrls: ['https://longshoreforrest.github.io/calculus-fennicus-2/'],
  // Volume 1 (public site) — links there open in a new tab.
  volume1Url: 'https://longshoreforrest.github.io/calculus-fennicus/',

  // false → no download button, Cmd/Ctrl+S and Cmd/Ctrl+P blocked, print shows nothing,
  // the decrypted PDF never becomes an object URL.
  allowDownload: false,

  // ---- Google Sign-In (Google Identity Services) ----
  // Same client as ../phd and the MyPA Worker. Authorized JS origins include
  // https://longshoreforrest.github.io and http://localhost:8732.
  googleClientId: '605639423178-s3pu2m6mkf9r50u69709u0mhchf0ha97.apps.googleusercontent.com',
  identityKey: 'unitas:identity',   // shared localStorage key (read by the MyPA beacon)
  requireSignIn: true,

  // ---- MyPublicAnalytics: analytics + comments ----
  site: 'calculus-fennicus-2',
  collectEndpoint: 'https://mypa.longshoreforrest.workers.dev/collect',
  feedbackEndpoint: 'https://mypa.longshoreforrest.workers.dev/feedback',
  analytics: true,
  ownerEmails: ['longshoreforrest@gmail.com'],
  dictationLang: 'fi-FI',
  audioEndpoint: 'https://mypa.longshoreforrest.workers.dev/audio',   // MyPA KV-äänitallenne, liitetään Telegram-ilmoitukseen

  // Overwritten by publish2.mjs.
  buildVersion: 'dev',
  docVersions: {},
};

/* publish2.mjs 20261122-0905 */
Object.assign(window.CF2_CONFIG, {
  "buildVersion": "20261122-0905",
  "docVersions": {
    "kirja": "0b8380c04ce6",
    "ratkaisut": "e0c1bbebd713",
    "lukukartta": "0a64c0ae6345",
    "kirja-en": "4fae9c30bbab",
    "ratkaisut-en": "8935701b09ee"
  }
});
