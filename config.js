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
  },
  defaultDoc: 'kirja',

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
  audioEndpoint: '',

  // Overwritten by publish2.mjs.
  buildVersion: 'dev',
  docVersions: {},
};

/* publish2.mjs 20261121-1528 */
Object.assign(window.CF2_CONFIG, {
  "buildVersion": "20261121-1528",
  "docVersions": {
    "kirja": "4e3e8fe2db05",
    "ratkaisut": "c1d607a794f4",
    "lukukartta": "43c5d072277b"
  }
});
