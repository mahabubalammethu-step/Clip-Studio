// Clip Studio — standalone personal clipping server.
// Paste a YouTube link -> auto-fetch transcript -> score moments -> cut 9:16 MP4s.
// No API keys in this file. GEMINI_API_KEY is read from the environment only;
// without it, clip scoring uses a transparent keyword/hook heuristic.
'use strict';

const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const { DatabaseSync } = require('node:sqlite');

// yt-dlp is pip-installed into ~/.local/bin on dev machines; on Render the
// Dockerfile installs it system-wide. Make both locations visible.
for (const d of ['/home/hatch/.local/bin', '/root/.local/bin', '/usr/local/bin']) {
  if (fs.existsSync(d) && !String(process.env.PATH || '').split(':').includes(d)) {
    process.env.PATH = (process.env.PATH || '') + ':' + d;
  }
}

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = '0.0.0.0';
const DATA_DIR = path.join(__dirname, 'data');
const RENDER_DIR = path.join(__dirname, 'renders');
const SUB_DIR = path.join(DATA_DIR, 'subs');
const LOGO_PATH = path.join(__dirname, 'public', 'logo.png');
for (const d of [DATA_DIR, RENDER_DIR, SUB_DIR]) fs.mkdirSync(d, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'clipstudio.db'));
db.exec(`
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT, channel TEXT, duration_sec INTEGER, youtube_id TEXT,
  source_url TEXT, source_type TEXT DEFAULT 'youtube',
  drive_file_id TEXT, file_name TEXT, file_size_bytes INTEGER,
  thumb_url TEXT, transcript_status TEXT DEFAULT 'pending',
  transcript TEXT, traffic_json TEXT, fetch_status TEXT DEFAULT 'pending',
  fetch_error TEXT, created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS clips (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER, start_sec REAL, end_sec REAL, score INTEGER,
  hook TEXT, captions_json TEXT, hashtags TEXT, status TEXT DEFAULT 'new',
  layout TEXT DEFAULT 'full', resolution TEXT DEFAULT '720p',
  render_status TEXT DEFAULT 'idle', video_file TEXT,
  translated_hook TEXT, translated_captions_json TEXT, translated_lang TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS recipe (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  settings_json TEXT
);
CREATE TABLE IF NOT EXISTS fix_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  text TEXT NOT NULL,
  status TEXT DEFAULT 'new',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
`);
// Lightweight migrations for columns added after the first deploy.
function addColumn(table, col, def) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
}
addColumn('projects', 'live_status', "TEXT DEFAULT 'not_live'");
addColumn('projects', 'is_live', 'INTEGER DEFAULT 0');
addColumn('projects', 'storyboard_json', 'TEXT');
addColumn('projects', 'transcript_cues_json', 'TEXT');
addColumn('clips', 'caption_offset', 'REAL DEFAULT 0');
addColumn('clips', 'caption_template', "TEXT DEFAULT 'word-cut'");
addColumn('clips', 'captions_timed_json', 'TEXT');
addColumn('clips', 'live_clip', 'INTEGER DEFAULT 0');
addColumn('clips', 'render_error', 'TEXT');
addColumn('projects', 'source_id', 'TEXT');
addColumn('clips', 'checklist_json', 'TEXT');
addColumn('clips', 'ratio', "TEXT DEFAULT '9:16'");
addColumn('clips', 'duo_corner', "TEXT DEFAULT 'auto'");

const app = express();
app.use(express.json({ limit: '5mb' }));

// ---- Credits paywall (no password lock) ----
// OWNER (the user himself): unlimited, never pays, never sees a paywall.
// Owner recognition is by device: the server has an OWNER_KEY env var.
// The owner enters the key once per device ("Owner access"); the server
// sets a long-lived signed httpOnly owner cookie on that device. The
// cookie is stateless — HMAC-SHA256 of the owner key over a fixed string
// — so it survives restarts on Render's ephemeral disk, and changing the
// key invalidates old cookies. The key lives only in the environment —
// never in a file, never in GitHub, never logged, never returned.
// VISITORS (no owner cookie): creating a project, finding clips, cutting
// a clip and translating cost credits (see COSTS). Downloading a cut MP4
// is free. Everything is enforced server-side (402 when short).
// When OWNER_KEY is not set, the site stays open exactly as before —
// the paywall never locks the owner out by accident.
// BUYING CREDITS: bKash only. The panel shows a QR image (public/
// bkash-qr.png — a placeholder until the owner adds it) and never shows
// a bKash number or name as text. The visitor pays, enters the bKash
// transaction ID and picks a pack; the request is stored PENDING and the
// owner approves it manually — there is no bKash merchant API, so no
// automatic verification is possible and none is faked.
const COSTS = { createProject: 1, findClips: 1, render: 2, translate: 1, download: 0 };
const CREDIT_PACKS = [
  { credits: 5, price: 50 },
  { credits: 10, price: 100 },
  { credits: 20, price: 200 },
];
const OWNER_KEY = process.env.OWNER_KEY || '';
db.exec(`
CREATE TABLE IF NOT EXISTS device_credits (
  device_id TEXT PRIMARY KEY,
  credits INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT, pack_credits INTEGER, price INTEGER,
  txn_id TEXT, status TEXT DEFAULT 'pending',
  created_at TEXT DEFAULT (datetime('now'))
);
`);
function ownerCookieValue() {
  return crypto.createHmac('sha256', OWNER_KEY).update('clip-studio-owner').digest('hex');
}
function getCookie(req, name) {
  const m = String(req.headers.cookie || '').match(new RegExp('(?:^|;\\s*)' + name + '=([A-Za-z0-9_\\-\\.]+)'));
  return m ? m[1] : null;
}
function appendCookie(res, str) {
  const prev = res.getHeader('Set-Cookie');
  res.setHeader('Set-Cookie', prev ? [].concat(prev, str) : str);
}
function isOwner(req) {
  if (!OWNER_KEY) return false;
  const v = getCookie(req, 'clip_owner');
  if (!v) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(v, 'hex'), Buffer.from(ownerCookieValue(), 'hex'));
  } catch { return false; }
}
function visitorDevice(req) {
  return getCookie(req, 'clip_device') || req._newDevice || null;
}
// Every first visit gets a random device ID in a long-lived cookie, so a
// visitor's credits follow their device (phone, PC, Mac, Linux).
app.use((req, res, next) => {
  if (!getCookie(req, 'clip_device')) {
    const id = crypto.randomUUID().replace(/-/g, '');
    req._newDevice = id;
    appendCookie(res, `clip_device=${id}; HttpOnly; Path=/; SameSite=Lax; Max-Age=31536000`);
  }
  next();
});
function getBalance(device) {
  if (!device) return 0;
  const row = db.prepare('SELECT credits FROM device_credits WHERE device_id=?').get(device);
  return row ? row.credits : 0;
}
// Charge a visitor for a paid action. Returns true when the action may
// proceed (paywall off, owner, or enough credits — deducted now).
// Returns false after already sending a 402 when the visitor is short.
function charge(req, res, cost) {
  if (!OWNER_KEY) return true; // paywall off — site is open
  if (isOwner(req)) return true; // owner never pays
  const device = visitorDevice(req);
  const bal = getBalance(device);
  if (bal < cost) {
    res.status(402).json({ error: `Not enough credits — this costs ${cost} credit${cost > 1 ? 's' : ''} and you have ${bal}. Buy credits to continue.`, needed: cost, balance: bal });
    return false;
  }
  db.prepare(`INSERT INTO device_credits (device_id, credits) VALUES (?, ?) ON CONFLICT(device_id) DO UPDATE SET credits=credits-?`)
    .run(device, -cost, cost);
  return true;
}
function requireOwner(req, res) {
  if (!OWNER_KEY || !isOwner(req)) { res.status(403).json({ error: 'Owner only.' }); return false; }
  return true;
}
app.get('/api/youtube-auth', (req, res) => res.json({ cookies_configured: !!YT_COOKIES_FILE }));
app.get('/api/credits', (req, res) => {
  res.json({
    paywall: !!OWNER_KEY,
    owner: isOwner(req),
    credits: isOwner(req) ? null : getBalance(visitorDevice(req)),
    packs: CREDIT_PACKS,
    costs: COSTS,
  });
});
app.post('/api/owner-login', (req, res) => {
  if (!OWNER_KEY) return res.status(400).json({ error: 'Owner access is not set up — the site is open.' });
  const given = String(req.body?.key || '');
  const ok = crypto.timingSafeEqual(
    crypto.createHash('sha256').update(given).digest(),
    crypto.createHash('sha256').update(OWNER_KEY).digest());
  if (!ok) return res.status(401).json({ error: 'Wrong owner key.' });
  const secure = req.secure || req.get('x-forwarded-proto') === 'https';
  appendCookie(res, `clip_owner=${ownerCookieValue()}; HttpOnly; Path=/; SameSite=Lax; Max-Age=31536000${secure ? '; Secure' : ''}`);
  res.json({ ok: true });
});
app.post('/api/credits/buy', (req, res) => {
  if (!OWNER_KEY) return res.status(400).json({ error: 'Credit payments are off — the site is open.' });
  const device = visitorDevice(req);
  if (!device) return res.status(400).json({ error: 'No device yet — reload the page and try again.' });
  const pack = CREDIT_PACKS.find((p) => p.credits === parseInt(req.body?.pack, 10));
  const txn = String(req.body?.txn_id || '').trim().slice(0, 64);
  if (!pack) return res.status(400).json({ error: 'Pick a credit pack first.' });
  if (!txn) return res.status(400).json({ error: 'Enter the bKash transaction ID.' });
  const dup = db.prepare('SELECT id FROM payments WHERE txn_id=? AND status != ?').get(txn, 'rejected');
  if (dup) return res.status(400).json({ error: 'This transaction ID was already submitted.' });
  const r = db.prepare('INSERT INTO payments (device_id, pack_credits, price, txn_id, status) VALUES (?,?,?,?,?)')
    .run(device, pack.credits, pack.price, txn, 'pending');
  res.json({ ok: true, id: r.lastInsertRowid, note: 'Pending — the owner approves it after checking the payment.' });
});
app.get('/api/credits/mine', (req, res) => {
  const device = visitorDevice(req);
  const rows = device ? db.prepare('SELECT * FROM payments WHERE device_id=? ORDER BY id DESC').all(device) : [];
  res.json({ payments: rows });
});
app.get('/api/credits/payments', (req, res) => {
  if (!requireOwner(req, res)) return;
  res.json({ payments: db.prepare('SELECT * FROM payments ORDER BY id DESC').all() });
});
app.post('/api/credits/payments/:id/approve', (req, res) => {
  if (!requireOwner(req, res)) return;
  const row = db.prepare('SELECT * FROM payments WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Payment not found.' });
  if (row.status !== 'pending') return res.status(400).json({ error: 'Already decided.' });
  db.prepare(`INSERT INTO device_credits (device_id, credits) VALUES (?, ?) ON CONFLICT(device_id) DO UPDATE SET credits=credits+excluded.credits`)
    .run(row.device_id, row.pack_credits);
  db.prepare(`UPDATE payments SET status='approved' WHERE id=?`).run(row.id);
  res.json({ ok: true });
});
app.post('/api/credits/payments/:id/reject', (req, res) => {
  if (!requireOwner(req, res)) return;
  const row = db.prepare('SELECT * FROM payments WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Payment not found.' });
  if (row.status !== 'pending') return res.status(400).json({ error: 'Already decided.' });
  db.prepare(`UPDATE payments SET status='rejected' WHERE id=?`).run(row.id);
  res.json({ ok: true });
});

app.use(express.static(path.join(__dirname, 'public')));
app.use('/renders', express.static(RENDER_DIR));

// YouTube's bot-wall blocks datacentre IPs on the default web client.
// The Android player client uses a different API path and usually still
// works from a server, so every yt-dlp call uses it. (The TV client was
// tried and is worse: SABR-only, no downloadable video formats.)
const YT_CLIENT = ['--extractor-args', 'youtube:player_client=android'];

// YouTube login cookies — the fix for YouTube blocking this server.
// The user sets YT_COOKIES_B64 in Render as an environment variable
// (base64 of a Netscape cookies.txt exported from their own browser).
// It is decoded ONCE at startup into a file outside the repo, never
// logged, never returned by any API, never committed. Without it, every
// yt-dlp call behaves exactly as before.
let YT_COOKIES_FILE = null;
let YT_COOKIES = [];
try {
  const b64 = (process.env.YT_COOKIES_B64 || '').trim();
  if (b64) {
    const text = Buffer.from(b64, 'base64').toString('utf8');
    if (text.includes('youtube.com') || text.includes('# Netscape HTTP Cookie File')) {
      YT_COOKIES_FILE = path.join(DATA_DIR, '.yt-cookies.txt');
      fs.writeFileSync(YT_COOKIES_FILE, text, { mode: 0o600 });
      YT_COOKIES = ['--cookies', YT_COOKIES_FILE];
      console.log('YouTube cookies configured — yt-dlp will use the logged-in session.');
    } else {
      console.error('YT_COOKIES_B64 does not look like a cookies file — ignoring it.');
    }
  }
} catch (e) {
  console.error('YT_COOKIES_B64 could not be decoded — ignoring it.');
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { timeout: opts.timeout || 120000, ...opts });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', () => resolve({ code: -1, out, err: err || 'spawn failed' }));
    p.on('close', (code) => resolve({ code, out, err }));
  });
}

function youtubeId(url) {
  const m = String(url || '').match(/(?:v=|youtu\.be\/|live\/|shorts\/)([A-Za-z0-9_-]{6,})/);
  return m ? m[1] : null;
}
function twitchId(url) {
  // twitch.tv/videos/123456789, twitch.tv/<channel>/clip/<slug>, twitch.tv/clip/<slug>
  const m = String(url || '').match(/twitch\.tv\/(?:videos\/(\d+)|[^/]+\/clip\/([A-Za-z0-9_-]+)|clip\/([A-Za-z0-9_-]+))/);
  return m ? (m[1] || m[2] || m[3]) : null;
}
function kickId(url) {
  // kick.com/video/<id> only — a plain kick.com/<channel> page is not a video.
  const m = String(url || '').match(/kick\.com\/video\/([A-Za-z0-9_-]+)/);
  return m ? m[1] : null;
}
function driveFileId(url) {
  const m = String(url || '').match(/\/d\/([A-Za-z0-9_-]+)/) || String(url || '').match(/[?&]id=([A-Za-z0-9_-]+)/);
  return m ? m[1] : null;
}
function fmtTime(s) {
  s = Math.max(0, Math.round(s || 0));
  const m = Math.floor(s / 60), sec = s % 60;
  return m + ':' + String(sec).padStart(2, '0');
}
function decodeEntities(s) {
  // YouTube captions (and pasted VTT text) encode > as &gt; etc. — decode so
  // burned-in captions show the real characters, never "&gt;".
  return String(s || '').replace(/&amp;/g, '&').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}
function parseVtt(text) {
  // Returns [{start, end, text}] from a WebVTT caption file.
  const out = [];
  const blocks = String(text || '').split(/\n\s*\n/);
  for (const b of blocks) {
    const lines = b.trim().split('\n');
    const t = lines.find((l) => l.includes('-->'));
    if (!t) continue;
    const [a, c] = t.split('-->').map((x) => x.trim());
    const toSec = (v) => {
      const parts = v.split(':').map(Number);
      let s = 0; for (const p of parts) s = s * 60 + p; return s;
    };
    const body = lines.filter((l) => l !== t && !/^\d+$/.test(l.trim()))
      .join(' ').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
    if (body) out.push({ start: toSec(a), end: toSec(c), text: body });
  }
  return out;
}
function transcriptToLines(cues) {
  return cues.map((c) => `[${fmtTime(c.start)}] ${c.text}`).join('\n');
}
function cuesFromText(text) {
  // Parse [m:ss] markers anywhere in a transcript into timed cues.
  // End = next cue's start (or +5s for the last one).
  const cues = [];
  const re = /\[(\d+):(\d+)\]\s*([^\[]*)/g;
  let m;
  while ((m = re.exec(String(text || ''))) !== null) {
    const t = decodeEntities(m[3].trim());
    if (t) cues.push({ start: +m[1] * 60 + +m[2], end: +m[1] * 60 + +m[2] + 5, text: t });
  }
  for (let i = 0; i < cues.length - 1; i++) cues[i].end = Math.min(cues[i + 1].start, cues[i].start + 12);
  return cues;
}

// ---- Caption templates: 35+ named ASS styles ----
// Colours are #RRGGBB; converted to ASS &H00BBGGRR at write time.
// align: ASS alignment (1 bottom-left, 2 bottom-centre, 3 bottom-right,
// 5 middle-centre, 8 top-centre). borderStyle 1 = outline+shadow, 3 = box.
function T(id, name, desc, s) {
  return { id, name, desc, ...s };
}
const CAPTION_TEMPLATES = [
  T('word-cut', 'Word Cut', 'Classic white, black outline, bottom', { font: 'Noto Sans Bengali', size: 44, color: '#FFFFFF', outlineColor: '#000000', backColor: '#000000', bold: true, italic: false, borderStyle: 1, outline: 2, shadow: 0, align: 2, marginV: 120 }),
  T('word-cut-alt', 'Word Cut Alt', 'Thicker outline, slight shadow', { font: 'Noto Sans Bengali', size: 46, color: '#FFFFFF', outlineColor: '#000000', backColor: '#000000', bold: true, italic: false, borderStyle: 1, outline: 3, shadow: 1, align: 2, marginV: 120 }),
  T('marker-sweep', 'Marker Sweep', 'Warm yellow sweep text', { font: 'Noto Sans Bengali', size: 48, color: '#FFC24B', outlineColor: '#000000', backColor: '#000000', bold: true, italic: false, borderStyle: 1, outline: 2, shadow: 1, align: 2, marginV: 120 }),
  T('negative-keywords', 'Negative Keywords', 'Black text on a yellow box', { font: 'Noto Sans Bengali', size: 44, color: '#111111', outlineColor: '#FFC24B', backColor: '#FFC24B', bold: true, italic: false, borderStyle: 3, outline: 1, shadow: 0, align: 2, marginV: 120 }),
  T('karaoke', 'Karaoke', 'Gold words, sung word by word', { font: 'Noto Sans Bengali', size: 46, color: '#FFD60A', outlineColor: '#000000', backColor: '#000000', bold: true, italic: false, borderStyle: 1, outline: 2, shadow: 0, align: 2, marginV: 120, karaoke: true }),
  T('bold-pop', 'Bold Pop', 'Huge and loud', { font: 'Noto Sans Bengali', size: 60, color: '#FFFFFF', outlineColor: '#000000', backColor: '#000000', bold: true, italic: false, borderStyle: 1, outline: 4, shadow: 2, align: 2, marginV: 110 }),
  T('outline', 'Outline', 'Heavy black outline', { font: 'Noto Sans Bengali', size: 48, color: '#FFFFFF', outlineColor: '#000000', backColor: '#000000', bold: true, italic: false, borderStyle: 1, outline: 5, shadow: 0, align: 2, marginV: 120 }),
  T('shadow', 'Shadow', 'Long soft shadow', { font: 'Noto Sans Bengali', size: 46, color: '#FFFFFF', outlineColor: '#000000', backColor: '#000000', bold: true, italic: false, borderStyle: 1, outline: 1, shadow: 4, align: 2, marginV: 120 }),
  T('pill', 'Pill', 'White text in a dark pill box', { font: 'Noto Sans Bengali', size: 42, color: '#FFFFFF', outlineColor: '#000000', backColor: '#000000', bold: true, italic: false, borderStyle: 3, outline: 1, shadow: 0, align: 2, marginV: 100 }),
  T('neon', 'Neon', 'Glowing cyan neon', { font: 'Noto Sans Bengali', size: 46, color: '#00E5FF', outlineColor: '#3B0764', backColor: '#000000', bold: true, italic: false, borderStyle: 1, outline: 2, shadow: 2, align: 2, marginV: 120 }),
  T('minimal', 'Minimal', 'Small and quiet', { font: 'Noto Sans Bengali', size: 32, color: '#FFFFFF', outlineColor: '#000000', backColor: '#000000', bold: false, italic: false, borderStyle: 1, outline: 1, shadow: 0, align: 2, marginV: 90 }),
  T('big-centre', 'Big Centre', 'Huge text in the middle', { font: 'Noto Sans Bengali', size: 64, color: '#FFFFFF', outlineColor: '#000000', backColor: '#000000', bold: true, italic: false, borderStyle: 1, outline: 3, shadow: 1, align: 5, marginV: 0 }),
  T('bottom-bar', 'Bottom Bar', 'Yellow text on a black bar', { font: 'Noto Sans Bengali', size: 44, color: '#FFD60A', outlineColor: '#000000', backColor: '#000000', bold: true, italic: false, borderStyle: 3, outline: 1, shadow: 0, align: 2, marginV: 60 }),
  T('top-bar', 'Top Bar', 'Captions at the top', { font: 'Noto Sans Bengali', size: 44, color: '#FFFFFF', outlineColor: '#000000', backColor: '#000000', bold: true, italic: false, borderStyle: 1, outline: 2, shadow: 0, align: 8, marginV: 60 }),
  T('highlight-word', 'Highlight Word', 'Bright yellow, hard to miss', { font: 'Noto Sans Bengali', size: 48, color: '#FFD60A', outlineColor: '#000000', backColor: '#000000', bold: true, italic: false, borderStyle: 1, outline: 2, shadow: 1, align: 2, marginV: 120 }),
  T('two-line', 'Two-Line', 'Caption split over two lines', { font: 'Noto Sans Bengali', size: 40, color: '#FFFFFF', outlineColor: '#000000', backColor: '#000000', bold: true, italic: false, borderStyle: 1, outline: 2, shadow: 0, align: 2, marginV: 120, twoLine: true }),
  T('classic-white', 'Classic White', 'Plain white, thin outline', { font: 'Noto Sans Bengali', size: 40, color: '#FFFFFF', outlineColor: '#000000', backColor: '#000000', bold: false, italic: false, borderStyle: 1, outline: 1, shadow: 0, align: 2, marginV: 120 }),
  T('yellow-punch', 'Yellow Punch', 'Big yellow punch text', { font: 'Noto Sans Bengali', size: 52, color: '#FFD60A', outlineColor: '#000000', backColor: '#000000', bold: true, italic: false, borderStyle: 1, outline: 3, shadow: 1, align: 2, marginV: 120 }),
  T('red-alert', 'Red Alert', 'Urgent red text', { font: 'Noto Sans Bengali', size: 48, color: '#FF3B30', outlineColor: '#FFFFFF', backColor: '#000000', bold: true, italic: false, borderStyle: 1, outline: 2, shadow: 1, align: 2, marginV: 120 }),
  T('gold-title', 'Gold Title', 'Rich gold, like a title card', { font: 'Noto Sans Bengali', size: 54, color: '#FFC24B', outlineColor: '#000000', backColor: '#000000', bold: true, italic: false, borderStyle: 1, outline: 2, shadow: 1, align: 2, marginV: 120 }),
  T('green-screen', 'Green Screen', 'Fresh green text', { font: 'Noto Sans Bengali', size: 46, color: '#3DDC84', outlineColor: '#000000', backColor: '#000000', bold: true, italic: false, borderStyle: 1, outline: 2, shadow: 0, align: 2, marginV: 120 }),
  T('blue-glow', 'Blue Glow', 'Cool blue with a soft glow', { font: 'Noto Sans Bengali', size: 46, color: '#7DD3FC', outlineColor: '#0C2D48', backColor: '#000000', bold: true, italic: false, borderStyle: 1, outline: 2, shadow: 2, align: 2, marginV: 120 }),
  T('pink-pop', 'Pink Pop', 'Bright pink pop', { font: 'Noto Sans Bengali', size: 48, color: '#FF7AD9', outlineColor: '#000000', backColor: '#000000', bold: true, italic: false, borderStyle: 1, outline: 2, shadow: 1, align: 2, marginV: 120 }),
  T('mono-type', 'Mono Type', 'Typewriter monospace', { font: 'DejaVu Sans Mono', size: 42, color: '#FFFFFF', outlineColor: '#000000', backColor: '#000000', bold: false, italic: false, borderStyle: 1, outline: 1, shadow: 0, align: 2, marginV: 120 }),
  T('upper-case', 'Upper Case', 'All caps, bold', { font: 'Noto Sans Bengali', size: 46, color: '#FFFFFF', outlineColor: '#000000', backColor: '#000000', bold: true, italic: false, borderStyle: 1, outline: 2, shadow: 0, align: 2, marginV: 120, uppercase: true }),
  T('lower-third', 'Lower Third', 'News-style, bottom left', { font: 'Noto Sans Bengali', size: 40, color: '#FFFFFF', outlineColor: '#000000', backColor: '#000000', bold: true, italic: false, borderStyle: 3, outline: 1, shadow: 0, align: 1, marginV: 80 }),
  T('centre-box', 'Centre Box', 'Boxed text in the middle', { font: 'Noto Sans Bengali', size: 48, color: '#FFFFFF', outlineColor: '#000000', backColor: '#000000', bold: true, italic: false, borderStyle: 3, outline: 1, shadow: 0, align: 5, marginV: 0 }),
  T('edge-glow', 'Edge Glow', 'White with a glowing edge', { font: 'Noto Sans Bengali', size: 46, color: '#FFFFFF', outlineColor: '#000000', backColor: '#000000', bold: true, italic: false, borderStyle: 1, outline: 2, shadow: 3, align: 2, marginV: 120 }),
  T('soft-blur', 'Soft Blur', 'Soft italic, gentle shadow', { font: 'Noto Sans Bengali', size: 42, color: '#FFFFFF', outlineColor: '#000000', backColor: '#000000', bold: false, italic: true, borderStyle: 1, outline: 1, shadow: 2, align: 2, marginV: 120 }),
  T('comic', 'Comic', 'Loud comic-book yellow', { font: 'Noto Sans Bengali', size: 50, color: '#FFD60A', outlineColor: '#000000', backColor: '#000000', bold: true, italic: false, borderStyle: 1, outline: 3, shadow: 2, align: 2, marginV: 120 }),
  T('news-ticker', 'News Ticker', 'Small bar at the very bottom', { font: 'Noto Sans Bengali', size: 38, color: '#FFFFFF', outlineColor: '#000000', backColor: '#000000', bold: true, italic: false, borderStyle: 3, outline: 1, shadow: 0, align: 2, marginV: 40 }),
  T('story-caption', 'Story Caption', 'Higher up, like a story', { font: 'Noto Sans Bengali', size: 40, color: '#FFFFFF', outlineColor: '#000000', backColor: '#000000', bold: true, italic: false, borderStyle: 1, outline: 2, shadow: 0, align: 2, marginV: 200 }),
  T('clean-white', 'Clean White', 'No bold, no shadow, just clean', { font: 'Noto Sans Bengali', size: 44, color: '#FFFFFF', outlineColor: '#000000', backColor: '#000000', bold: false, italic: false, borderStyle: 1, outline: 1, shadow: 0, align: 2, marginV: 120 }),
  T('dark-mode', 'Dark Mode', 'Black text on a white box', { font: 'Noto Sans Bengali', size: 44, color: '#111111', outlineColor: '#FFFFFF', backColor: '#FFFFFF', bold: true, italic: false, borderStyle: 3, outline: 1, shadow: 0, align: 2, marginV: 120 }),
  T('retro-tv', 'Retro TV', 'Green terminal text', { font: 'DejaVu Sans Mono', size: 44, color: '#39FF14', outlineColor: '#000000', backColor: '#000000', bold: true, italic: false, borderStyle: 3, outline: 1, shadow: 0, align: 2, marginV: 120 }),
  T('bold-yellow', 'Bold Yellow', 'Very big yellow', { font: 'Noto Sans Bengali', size: 56, color: '#FFD60A', outlineColor: '#000000', backColor: '#000000', bold: true, italic: false, borderStyle: 1, outline: 3, shadow: 1, align: 2, marginV: 120 }),
  T('white-outline', 'White Outline', 'Thick outline, no shadow', { font: 'Noto Sans Bengali', size: 48, color: '#FFFFFF', outlineColor: '#000000', backColor: '#000000', bold: true, italic: false, borderStyle: 1, outline: 4, shadow: 0, align: 2, marginV: 120 }),
  T('black-bar', 'Black Bar', 'White on a full black bar', { font: 'Noto Sans Bengali', size: 46, color: '#FFFFFF', outlineColor: '#000000', backColor: '#000000', bold: true, italic: false, borderStyle: 3, outline: 1, shadow: 0, align: 2, marginV: 50 }),
  T('fire-text', 'Fire Text', 'Hot orange flame text', { font: 'Noto Sans Bengali', size: 52, color: '#FF6A1A', outlineColor: '#000000', backColor: '#000000', bold: true, italic: false, borderStyle: 1, outline: 2, shadow: 1, align: 2, marginV: 120 }),
  T('ice-text', 'Ice Text', 'Cold light-blue text', { font: 'Noto Sans Bengali', size: 48, color: '#B8F1FF', outlineColor: '#0C2D48', backColor: '#000000', bold: true, italic: false, borderStyle: 1, outline: 2, shadow: 2, align: 2, marginV: 120 }),
  T('small-corner', 'Small Corner', 'Tiny text, bottom right', { font: 'Noto Sans Bengali', size: 30, color: '#FFFFFF', outlineColor: '#000000', backColor: '#000000', bold: false, italic: false, borderStyle: 1, outline: 1, shadow: 0, align: 3, marginV: 60 }),
  T('big-bold', 'Big Bold', 'The biggest bold text', { font: 'Noto Sans Bengali', size: 68, color: '#FFFFFF', outlineColor: '#000000', backColor: '#000000', bold: true, italic: false, borderStyle: 1, outline: 3, shadow: 2, align: 2, marginV: 110 }),
];
function getTemplate(id) {
  return CAPTION_TEMPLATES.find((t) => t.id === id) || CAPTION_TEMPLATES[0];
}
function templatePreviewCss(t) {
  // Approximate CSS for the picker preview swatch.
  const box = t.borderStyle === 3;
  return {
    fontSize: Math.max(11, Math.round(t.size * 0.32)) + 'px',
    color: t.color,
    background: box ? (t.backColor === '#FFFFFF' ? '#ffffff' : 'rgba(0,0,0,0.75)') : 'transparent',
    fontWeight: t.bold ? 800 : 400,
    fontStyle: t.italic ? 'italic' : 'normal',
    textShadow: t.shadow > 0 ? '1px 2px 2px rgba(0,0,0,.8)' : (t.outline >= 2 ? '0 0 2px #000, 1px 1px 0 #000, -1px -1px 0 #000' : 'none'),
    fontFamily: t.font.includes('Mono') ? 'monospace' : 'system-ui',
  };
}

// ---- YouTube metadata + captions via yt-dlp (server-side, no paste needed) ----
async function fetchYouTube(url) {
  const meta = await run('yt-dlp', [...YT_CLIENT, ...YT_COOKIES, '-j', '--no-playlist', url], { timeout: 60000 });
  if (meta.code !== 0) throw new Error('yt-dlp could not read this video (it may be private, age-restricted or blocking downloads).');
  let info = {};
  try { info = JSON.parse(meta.out); } catch { throw new Error('Could not parse video info from yt-dlp.'); }

  // Auto captions (and manual subs if present), English + Bengali preferred.
  const id = info.id || youtubeId(url) || twitchId(url) || kickId(url) || crypto.randomUUID().slice(0, 8);
  const subOut = path.join(SUB_DIR, id);
  await run('yt-dlp', [...YT_CLIENT, ...YT_COOKIES, '--skip-download', '--write-auto-subs', '--write-subs',
    '--sub-format', 'vtt', '--sub-lang', 'en,bn.*', '-o', subOut, url], { timeout: 120000 });

  let cues = [];
  for (const f of fs.readdirSync(SUB_DIR)) {
    if (!f.startsWith(id)) continue;
    try { cues = cues.concat(parseVtt(fs.readFileSync(path.join(SUB_DIR, f), 'utf8'))); } catch {}
  }
  // De-duplicate by start time, keep first.
  const seen = new Set();
  cues = cues.filter((c) => { const k = Math.round(c.start); if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => a.start - b.start);

  // Most-replayed heatmap (traffic) when YouTube publishes it.
  let traffic = { peaks: [], viewCount: info.view_count || null, likeCount: info.like_count || null };
  const heat = info.heatmap;
  if (Array.isArray(heat) && heat.length) {
    const dur = info.duration || 0;
    traffic.peaks = heat
      .map((h, i) => ({ t: dur ? (i / heat.length) * dur : 0, v: h }))
      .sort((a, b) => b.v - a.v).slice(0, 5)
      .map((p) => Math.round(p.t));
  }

  // Live status: is_live / was_live / is_upcoming / not_live.
  const liveStatus = info.live_status || (info.is_live ? 'is_live' : (info.was_live ? 'was_live' : 'not_live'));
  const isLive = info.is_live === true || liveStatus === 'is_live';

  // Storyboard sprite (for the frame-select thumbnail strip), if published.
  let storyboard = null;
  const boards = (info.formats || []).filter((f) => /storyboard/i.test(String(f.format_note || '') + ' ' + String(f.format_id || '')) && f.url);
  if (boards.length) {
    const best = boards.sort((a, b) => ((b.width || 0) * (b.height || 0)) - ((a.width || 0) * (a.height || 0)))[0];
    storyboard = {
      url: best.url, width: best.width || 0, height: best.height || 0,
      rows: best.rows || 0, columns: best.columns || 0,
      fragments: (best.fragments || []).map((fr) => fr.url).filter(Boolean).slice(0, 12),
    };
  }

  return { info, cues, traffic, liveStatus, isLive, storyboard };
}

// ---- Clip scoring: Gemini when a key is set, else transparent heuristic ----
const HOOK_WORDS = ['never', 'secret', 'mistake', 'stop', 'why', 'how', 'best', 'worst', 'free', 'truth', 'nobody', 'everyone', 'warning', 'shocking', 'insane', 'crazy', 'first', 'last', 'always', 'only', 'kintu', 'keno', 'kivabe', 'kokhono', 'sotti'];
function heuristicClips(cues, wanted, durationSec, minLen, maxLen, moments) {
  const sentences = [];
  for (const c of cues) {
    for (const part of c.text.split(/(?<=[.!?।])\s+/)) {
      if (part.trim()) sentences.push({ start: c.start, end: c.end, text: part.trim() });
    }
  }
  if (!sentences.length) return [];
  // "Moments to include": words from the user's prompt boost matching
  // sentences, so the requested moments get picked first.
  const momentWords = String(moments || '').toLowerCase().split(/[^a-z0-9\u0980-\u09FF]+/).filter((w) => w.length >= 4);
  const scored = sentences.map((s, i) => {
    let score = 50;
    const low = s.text.toLowerCase();
    for (const w of HOOK_WORDS) if (low.includes(w)) score += 4;
    for (const w of momentWords) if (low.includes(w)) score += 8;
    if (/\d/.test(s.text)) score += 5;
    if (/[?!]/.test(s.text)) score += 3;
    if (s.text.length > 60 && s.text.length < 220) score += 4;
    return { ...s, score: Math.min(92, score), idx: i };
  }).sort((a, b) => b.score - a.score);

  const picked = [];
  for (const s of scored) {
    if (picked.length >= wanted) break;
    const start = Math.max(0, s.start - 2);
    const end = Math.min(durationSec || s.end + maxLen, start + maxLen);
    if (end - start < minLen) continue;
    if (picked.some((p) => Math.abs(p.start_sec - start) < 45)) continue;
    const window = cues.filter((c) => c.start >= start && c.start < end);
    picked.push({
      start_sec: Math.round(start), end_sec: Math.round(end),
      score: s.score,
      hook: s.text.slice(0, 90),
      captions: window.slice(0, 10).map((c) => c.text),
      hashtags: ['#shorts', '#viral'],
    });
  }
  return picked.sort((a, b) => b.score - a.score);
}

async function geminiClips(cues, wanted, minLen, maxLen, moments) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return null;
  const excerpt = transcriptToLines(cues).slice(0, 12000);
  const momentsLine = moments ? `Moments to include: ${moments}\n` : '';
  const prompt = `You score viral short-video moments from a transcript with [m:ss] timestamps. Return ONLY a JSON array, max ${wanted} items, each {"start_sec":number,"end_sec":number,"score":0-99,"hook":"short hook","captions":["line"],"hashtags":["#x"]}. Clips ${minLen}-${maxLen}s, non-overlapping, best hook first.\n${momentsLine}\n${excerpt}`;
  const res = await fetch(
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=' + encodeURIComponent(key),
    { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }) });
  if (!res.ok) throw new Error('Gemini returned ' + res.status);
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
  const json = text.match(/\[[\s\S]*\]/);
  if (!json) throw new Error('Gemini returned no JSON array.');
  return JSON.parse(json[0]);
}

async function scoreClips(project, wanted, minLen, maxLen, moments) {
  const cues = cuesFromText(project.transcript);
  const ai = recipeSettings();
  // Gemini only runs when the user picked it in Settings → AI. Otherwise the
  // built-in heuristic scores — and the reply says so honestly.
  if (ai.aiEngine === 'gemini') {
    if (!process.env.GEMINI_API_KEY) {
      return { engine: 'heuristic', note: 'Gemini is selected in Settings → AI but no GEMINI_API_KEY is set — used the built-in heuristic instead.', clips: heuristicClips(cues, wanted, project.duration_sec, minLen, maxLen, moments) };
    }
    try {
      const out = await geminiClips(cues, wanted, minLen, maxLen, moments);
      if (Array.isArray(out) && out.length) return { engine: 'gemini', clips: out };
    } catch (e) { /* fall through to heuristic, and say so */ }
    return { engine: 'heuristic', note: 'Gemini call failed — used the built-in heuristic instead.', clips: heuristicClips(cues, wanted, project.duration_sec, minLen, maxLen, moments) };
  }
  return { engine: 'heuristic', note: null, clips: heuristicClips(cues, wanted, project.duration_sec, minLen, maxLen, moments) };
}

// ---- Caption rendering: each cue keeps its OWN timestamp (caption sync) ----
// Timed cues for a clip come from the stored transcript cues when available;
// otherwise they are parsed from the [m:ss] markers in the transcript text.
// A plain caption list with no times at all falls back to short even slots
// only as a last resort — and that fallback is labelled in the stored data.
function getTimedCues(project, clip) {
  let cues = [];
  try { cues = JSON.parse(project.transcript_cues_json || 'null') || []; } catch {}
  if (!cues.length) cues = cuesFromText(project.transcript);
  const offset = +(clip.caption_offset || 0);
  const start = +clip.start_sec, end = +clip.end_sec;
  const clipDur = end - start;
  const inWindow = [];
  let prev = null;
  for (const c of cues) {
    if (!(c.end > start && c.start < end)) continue;
    const text = (c.text || '').trim();
    if (!text) continue;
    const cs = Math.max(0, c.start - start + offset);
    const ce = Math.min(clipDur, c.end - start + offset);
    if (ce <= cs) continue; // zero-length cue (repeated caption line) — skip
    if (prev && prev.text === text && Math.abs(prev.start - cs) < 0.5) continue; // same line repeated — keep first
    const row = { start: cs, end: ce, text };
    inWindow.push(row); prev = row;
  }
  if (inWindow.length) return { cues: inWindow, timed: true };
  // Last-resort fallback: plain caption lines, no timing data exists.
  const plain = JSON.parse(clip.captions_json || '[]');
  if (!plain.length) return { cues: [], timed: false };
  const dur = Math.max(1, end - start);
  const slot = dur / plain.length;
  return {
    cues: plain.map((t, i) => ({ start: i * slot, end: Math.min(dur, (i + 1) * slot - 0.2), text: t })),
    timed: false,
  };
}
function assColor(hex) {
  const h = String(hex || '#FFFFFF').replace('#', '');
  return '&H00' + h.slice(4, 6) + h.slice(2, 4) + h.slice(0, 2);
}
function assEscape(s) {
  return String(s || '').replace(/\\/g, '\\\\').replace(/{/g, '\\{').replace(/}/g, '\\}').replace(/\n/g, ' ');
}
function assTime(t) {
  const cs = Math.max(0, Math.round(t * 100));
  const h = Math.floor(cs / 360000), m = Math.floor(cs / 6000) % 60, s = Math.floor(cs / 100) % 60, c = cs % 100;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(c).padStart(2, '0')}`;
}
function writeAss(timedCues, file, templateId, playW, playH) {
  const t = getTemplate(templateId);
  const style = `Style: Cap,${t.font},${t.size},${assColor(t.color)},&H000000FF,${assColor(t.outlineColor)},${assColor(t.backColor)},${t.bold ? -1 : 0},${t.italic ? -1 : 0},0,0,100,100,0,0,${t.borderStyle},${t.outline},${t.shadow},${t.align},40,40,${t.marginV},1`;
  let events = '';
  for (const cue of timedCues) {
    let text = cue.text;
    if (t.uppercase) text = text.toUpperCase();
    if (t.twoLine && text.length > 34) {
      const mid = text.lastIndexOf(' ', Math.floor(text.length / 2));
      if (mid > 8) text = text.slice(0, mid) + '\\N' + text.slice(mid + 1);
    }
    if (t.karaoke) {
      // One event per word inside the cue window, so words light up in turn.
      const words = text.split(/\s+/).filter(Boolean);
      const span = Math.max(0.25, (cue.end - cue.start) / Math.max(1, words.length));
      words.forEach((w, i) => {
        events += `Dialogue: 0,${assTime(cue.start + i * span)},${assTime(cue.start + (i + 1) * span)},Cap,,0,0,0,,${assEscape(w)}\n`;
      });
    } else {
      events += `Dialogue: 0,${assTime(cue.start)},${assTime(cue.end)},Cap,,0,0,0,,${assEscape(text)}\n`;
    }
  }
  const ass = `[Script Info]\nScriptType: v4.00+\nPlayResX: ${playW}\nPlayResY: ${playH}\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n${style}\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n${events}`;
  fs.writeFileSync(file, ass);
}
function wrapHook(text, per = 26) {
  // Word-wrap a hook for a title card, ~26 chars per line.
  const words = String(text || '').split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  for (const w of words) {
    if ((cur + ' ' + w).trim().length > per && cur) { lines.push(cur.trim()); cur = w; }
    else cur = (cur + ' ' + w).trim();
  }
  if (cur) lines.push(cur);
  return lines.slice(0, 3).join('\\N');
}
function writeCardAss(text, file, playW, playH, opts = {}) {
  // A centred card (title card / end card): big text on a dark card.
  // Escape each line separately so the \N line breaks from wrapHook stay
  // real line breaks instead of printing as stray backslashes.
  const safeText = String(text || '').split('\\N').map((l) => assEscape(l)).join('\\N');
  const size = opts.size || Math.round(playW * 0.085);
  const color = opts.color || '#FFC24B';
  const sub = opts.sub || '';
  const ass = `[Script Info]\nScriptType: v4.00+\nPlayResX: ${playW}\nPlayResY: ${playH}\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Card,Noto Sans Bengali,${size},${assColor(color)},&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,2,1,5,60,60,0,1\nStyle: Brand,Noto Sans Bengali,${Math.round(playW * 0.038)},${assColor('#FFFFFF')},&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,1,0,2,40,40,${Math.round(playH * 0.05)},1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:00.00,0:00:10.00,Card,,0,0,0,,${safeText}\n${sub ? `Dialogue: 0,0:00:00.00,0:00:10.00,Brand,,0,0,0,,${assEscape(sub)}\n` : ''}`;
  fs.writeFileSync(file, ass);
}

// ---- MP4 render: yt-dlp section download + ffmpeg 9:16 with burned captions ----
// Unique formation (ON by default): logo watermark top-right, a branded
// title card (~1.5s) with the hook at the start, an end card (~1s), and a
// reframed layout (never a plain raw crop of the source).
async function probeHasAudio(file) {
  const r = await run('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type',
    '-of', 'csv=p=0', file], { timeout: 30000 });
  return r.out.includes('audio');
}
async function probeDims(file) {
  const r = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,duration', '-of', 'csv=p=0', file], { timeout: 30000 });
  const p = r.out.trim().split(',');
  return { width: parseInt(p[0], 10) || 0, height: parseInt(p[1], 10) || 0, duration: parseFloat(p[2]) || 0 };
}
// Output size: normal layouts are always 9:16; Duo follows the clip's ratio.
function outputSize(clip) {
  const big = clip.resolution === '1080p';
  if (clip.layout === 'duo') {
    const r = clip.ratio || '9:16';
    if (r === '1:1') return big ? [1080, 1080] : [720, 720];
    if (r === '4:5') return big ? [1080, 1350] : [720, 900];
    if (r === '16:9') return big ? [1920, 1080] : [1280, 720];
    return big ? [1080, 1920] : [720, 1280]; // 9:16
  }
  return big ? [1080, 1920] : [720, 1280];
}
async function pickDuoCorner(srcPath) {
  // Auto Split: sample the middle frame and measure texture (YSTDDEV) in
  // each corner — a facecam corner has far more detail than a flat HUD
  // corner. Any failure falls back to bottom-right (the usual facecam spot).
  try {
    const dims = await probeDims(srcPath);
    if (!dims.width || !dims.height) return 'bottom-right';
    const frame = path.join(RENDER_DIR, `duo-frame-${Date.now()}.png`);
    const mid = Math.max(0.5, (dims.duration || 10) / 2);
    const ex = await run('ffmpeg', ['-y', '-ss', String(mid), '-i', srcPath, '-frames:v', '1', frame], { timeout: 30000 });
    if (ex.code !== 0 || !fs.existsSync(frame)) return 'bottom-right';
    const cw = Math.round(dims.width * 0.30), ch = Math.round(cw * 9 / 16);
    const corners = {
      'top-left': [0, 0],
      'top-right': [dims.width - cw, 0],
      'bottom-left': [0, dims.height - ch],
      'bottom-right': [dims.width - cw, dims.height - ch],
    };
    let best = 'bottom-right', bestScore = -1;
    for (const [name, [x, y]] of Object.entries(corners)) {
      const st = await run('ffmpeg', ['-i', frame, '-vf', `crop=${cw}:${ch}:${x}:${y},signalstats`, '-f', 'null', '-'], { timeout: 30000 });
      const m = (st.err + st.out).match(/YSTDDEV=([\d.]+)/);
      const v = m ? parseFloat(m[1]) : 0;
      if (v > bestScore) { bestScore = v; best = name; }
    }
    try { fs.unlinkSync(frame); } catch {}
    return best;
  } catch { return 'bottom-right'; }
}
function recipeSettings() {
  const row = db.prepare('SELECT settings_json FROM recipe WHERE id=1').get();
  const saved = row ? JSON.parse(row.settings_json) : {};
  return { ...DEFAULT_RECIPE, ...saved };
}
function uniqueOn(recipe) {
  return {
    logo: recipe.uniqueLogo !== false && fs.existsSync(LOGO_PATH),
    title: recipe.uniqueTitleCard !== false,
    end: recipe.uniqueEndCard !== false,
  };
}

async function finishRender(srcPath, project, clip, recipe) {
  const [w, h] = outputSize(clip);
  const ratioSlug = (clip.ratio || '9:16').replace(':', 'x');
  const outFile = clip.layout === 'duo'
    ? `clip-${clip.id}-duo-${ratioSlug}-${clip.resolution}.mp4`
    : `clip-${clip.id}-${clip.layout}-${clip.resolution}.mp4`;
  const outPath = path.join(RENDER_DIR, outFile);
  const templateId = clip.caption_template || recipe.captionTemplate || 'word-cut';
  const { cues: timed, timed: isTimed } = getTimedCues(project, clip);
  // Store the timed captions used, so re-cuts and the editor keep them.
  db.prepare('UPDATE clips SET captions_timed_json=? WHERE id=?').run(JSON.stringify(timed), clip.id);
  const assFile = path.join(RENDER_DIR, `cap-${clip.id}.ass`);
  writeAss(timed, assFile, templateId, w, h);

  const uq = uniqueOn(recipe);
  const hasAudio = await probeHasAudio(srcPath);
  const sub = `subtitles='${assFile.replace(/'/g, "'\\''")}'`;
  const logoW = Math.round(w * 0.16);
  const inputs = ['-y', '-i', srcPath];
  if (uq.logo) inputs.push('-i', LOGO_PATH);
  const TITLE_DUR = 1.5, END_DUR = 1.0;
  if (uq.title || uq.end) {
    if (uq.title) {
      inputs.push('-f', 'lavfi', '-t', String(TITLE_DUR), '-i', `color=c=0x0b0b10:s=${w}x${h}:r=30`);
      inputs.push('-f', 'lavfi', '-t', String(TITLE_DUR), '-i', 'anullsrc=r=48000:cl=stereo');
    }
    if (uq.end) {
      inputs.push('-f', 'lavfi', '-t', String(END_DUR), '-i', `color=c=0x0b0b10:s=${w}x${h}:r=30`);
      inputs.push('-f', 'lavfi', '-t', String(END_DUR), '-i', 'anullsrc=r=48000:cl=stereo');
    }
  }
  // The -i pairs above make the lavfi inputs land at indices 2..; recompute
  // properly: count -i occurrences in order.
  const inputIdx = [];
  for (let i = 0; i < inputs.length; i++) if (inputs[i] === '-i') inputIdx.push((inputIdx.length));
  const logoIdx = uq.logo ? 1 : -1;
  const tVid = uq.title ? inputIdx[logoIdx >= 0 ? 2 : 1] : -1;
  const tAud = uq.title ? inputIdx[logoIdx >= 0 ? 3 : 2] : -1;
  const eVid = uq.end ? inputIdx[(logoIdx >= 0 ? 2 : 1) + (uq.title ? 2 : 0)] : -1;
  const eAud = uq.end ? inputIdx[(logoIdx >= 0 ? 2 : 1) + (uq.title ? 2 : 0) + 1] : -1;

  let fc = '';
  let mainLabel = '[main]';
  // Duo layout (creator + content): the content fills the frame and the
  // creator is a picture-in-picture cropped from the facecam corner of the
  // source, with a subtle white border. Corner is auto-picked (or the user's
  // override). If the source cannot be probed, fall back to the Full layout.
  let duoCorner = null;
  const base = await (async () => {
    if (clip.layout !== 'duo') return null;
    const dims = await probeDims(srcPath);
    if (!dims.width || !dims.height) return null;
    duoCorner = (clip.duo_corner && clip.duo_corner !== 'auto') ? clip.duo_corner : await pickDuoCorner(srcPath);
    const pw = Math.round(w * 0.30), ph = Math.round(pw * 9 / 16), mgn = 16;
    const cw = Math.round(dims.width * 0.30), ch = Math.round(cw * 9 / 16);
    const srcCorners = {
      'top-left': [0, 0],
      'top-right': [Math.max(0, dims.width - cw), 0],
      'bottom-left': [0, Math.max(0, dims.height - ch)],
      'bottom-right': [Math.max(0, dims.width - cw), Math.max(0, dims.height - ch)],
    };
    const [cx, cy] = srcCorners[duoCorner] || srcCorners['bottom-right'];
    const pos = {
      'top-left': [mgn, mgn],
      'top-right': [w - pw - mgn, mgn],
      'bottom-left': [mgn, h - ph - mgn],
      'bottom-right': [w - pw - mgn, h - ph - mgn],
    }[duoCorner] || [w - pw - mgn, h - ph - mgn];
    return `[0:v]split[c][p];[c]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}[content];[p]crop=${cw}:${ch}:${cx}:${cy},scale=${pw}:${ph},drawbox=x=0:y=0:w=${pw}:h=${ph}:color=white:thickness=3[pip];[content][pip]overlay=${pos[0]}:${pos[1]}`;
  })() || (clip.layout === 'spotlight'
    ? `[0:v]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}`
    : clip.layout === 'split'
      ? `[0:v]split[a][b];[a]scale=${w}:${Math.floor(h / 2)}:force_original_aspect_ratio=increase,crop=${w}:${Math.floor(h / 2)}[top];[b]scale=${w}:${Math.floor(h / 2)}:force_original_aspect_ratio=decrease,pad=${w}:${Math.floor(h / 2)}:(ow-iw)/2:(oh-ih)/2[bot];[top][bot]vstack`
      : `[0:v]split[a][b];[a]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},gblur=sigma=20[bg];[b]scale=${w}:${h}:force_original_aspect_ratio=decrease[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2`);
  fc = base + `[v0];[v0]${sub}[v1]`;
  // Logo is used on the main video and, when enabled, on the title/end
  // cards too — split into exactly as many copies as are actually used
  // (ffmpeg errors on an unconnected split output).
  const logoUses = [];
  if (uq.logo) logoUses.push('main');
  if (uq.logo && uq.title) logoUses.push('title');
  if (uq.logo && uq.end) logoUses.push('end');
  const lgName = { main: 'lg1', title: 'lg2', end: 'lg3' };
  if (uq.logo) {
    const split = logoUses.length > 1
      ? `[lg]split=${logoUses.length}${logoUses.map((u) => `[${lgName[u]}]`).join('')};`
      : '[lg]copy[lg1];';
    fc = `[1:v]scale=${logoW}:-1[lg];` + split + fc + `;[v1][lg1]overlay=W-w-24:24[v2]`;
    mainLabel = '[v2]';
  } else {
    mainLabel = '[v1]';
  }
  let vOut = mainLabel, aOut = null;
  if (uq.title || uq.end) {
    // Concat needs identical SAR + fps on every segment: the source video
    // often carries a non-square SAR, the title/end cards are 1:1 @30fps.
    fc += `;${mainLabel}setsar=1,fps=30[vm]`;
    mainLabel = '[vm]';
    const titleAss = path.join(RENDER_DIR, `title-${clip.id}.ass`);
    const endAss = path.join(RENDER_DIR, `end-${clip.id}.ass`);
    if (uq.title) writeCardAss(wrapHook(clip.translated_hook || clip.hook || ''), titleAss, w, h, { sub: 'CLIP STUDIO' });
    if (uq.end) writeCardAss('Clip Studio', endAss, w, h, { size: Math.round(w * 0.08), color: '#FFFFFF' });
    if (uq.title) {
      fc += `;[${tVid}:v]subtitles='${titleAss.replace(/'/g, "'\\''")}'[tv0]`;
      fc += uq.logo ? `;[tv0][lg2]overlay=(W-w)/2:60,setsar=1,fps=30[tv]` : `;[tv0]setsar=1,fps=30[tv]`;
    }
    if (uq.end) {
      fc += `;[${eVid}:v]subtitles='${endAss.replace(/'/g, "'\\''")}'[ev0]`;
      fc += uq.logo ? `;[ev0][lg3]overlay=(W-w)/2:60,setsar=1,fps=30[ev]` : `;[ev0]setsar=1,fps=30[ev]`;
    }
    const segs = [];
    if (uq.title) segs.push('[tv]', `[${tAud}:a]`);
    // Concat needs every audio segment at the same rate/channels — resample
    // the source audio to 48kHz stereo (YouTube audio is usually 48kHz;
    // the title/end silence is generated at 48kHz stereo too).
    if (hasAudio) fc += ';[0:a]aresample=48000[a0]';
    segs.push(mainLabel, hasAudio ? '[a0]' : '[sil:a]');
    if (uq.end) segs.push('[ev]', `[${eAud}:a]`);
    if (!hasAudio) fc += `;anullsrc=r=48000:cl=stereo:d=${Math.max(1, clip.end_sec - clip.start_sec)}[sil]`;
    fc += `;${segs.join('')}concat=n=${segs.length / 2}:v=1:a=1[vout][aout]`;
    vOut = '[vout]'; aOut = '[aout]';
  }
  const args = [...inputs, '-filter_complex', fc, '-map', vOut];
  if (aOut) args.push('-map', aOut);
  else if (hasAudio) args.push('-map', '0:a?');
  args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
    '-c:a', 'aac', '-shortest', outPath);
  const ff = await run('ffmpeg', args, { timeout: 600000 });
  if (ff.code !== 0 || !fs.existsSync(outPath)) {
    throw new Error('ffmpeg failed to build the clip.' + (ff.err ? ' ' + ff.err.slice(-300) : ''));
  }
  return { file: outFile, timed: isTimed, template: templateId, unique: uq, ratio: clip.ratio || '9:16', duo_corner: duoCorner };
}

async function renderClipJob(project, clip) {
  const srcBase = path.join(RENDER_DIR, `src-${clip.id}`);
  const dl = await run('yt-dlp', [...YT_CLIENT, ...YT_COOKIES, '-f', 'bestvideo[height<=720]+bestaudio/best/best',
    '--download-sections', `*${clip.start_sec}-${clip.end_sec}`,
    '-o', srcBase + '.%(ext)s', project.source_url], { timeout: 300000 });
  // yt-dlp names the file by actual container (.webm/.mp4/.mkv) — find it.
  const srcPath = fs.readdirSync(RENDER_DIR)
    .filter((f) => f.startsWith(`src-${clip.id}.`))
    .map((f) => path.join(RENDER_DIR, f))[0];
  if (dl.code !== 0 || !srcPath) throw new Error('Download failed — YouTube blocked this video or the section is unavailable.');
  try {
    return await finishRender(srcPath, project, clip, recipeSettings());
  } finally {
    try { fs.unlinkSync(srcPath); } catch {}
  }
}

async function renderLiveClipJob(project, clip) {
  // Live stream: record from the start of the stream and cut the range.
  const srcBase = path.join(RENDER_DIR, `live-${clip.id}`);
  const dl = await run('yt-dlp', [...YT_CLIENT, ...YT_COOKIES, '-f', 'bestvideo[height<=720]+bestaudio/best/best',
    '--live-from-start', '--download-sections', `*${clip.start_sec}-${clip.end_sec}`,
    '-o', srcBase + '.%(ext)s', project.source_url], { timeout: 600000 });
  const srcPath = fs.readdirSync(RENDER_DIR)
    .filter((f) => f.startsWith(`live-${clip.id}.`))
    .map((f) => path.join(RENDER_DIR, f))[0];
  if (dl.code !== 0 || !srcPath) throw new Error('Could not record the live stream — it may have ended, or the section is not available yet.');
  try {
    return await finishRender(srcPath, project, clip, recipeSettings());
  } finally {
    try { fs.unlinkSync(srcPath); } catch {}
  }
}

// ---- API ----
app.get('/health', (req, res) => res.json({ ok: true, service: 'clip-studio', time: new Date().toISOString() }));

// Caption templates: the full 35+ list, with picker preview CSS.
app.get('/api/caption-templates', (req, res) => {
  res.json({
    count: CAPTION_TEMPLATES.length,
    templates: CAPTION_TEMPLATES.map((t) => ({
      id: t.id, name: t.name, desc: t.desc, preview: templatePreviewCss(t),
    })),
  });
});

app.get('/api/projects', (req, res) => {
  const rows = db.prepare('SELECT * FROM projects ORDER BY id DESC').all();
  for (const r of rows) {
    r.clip_count = db.prepare('SELECT COUNT(*) c FROM clips WHERE project_id=?').get(r.id).c;
    r.top_score = db.prepare('SELECT MAX(score) m FROM clips WHERE project_id=?').get(r.id).m || 0;
    try { r.storyboard = JSON.parse(r.storyboard_json || 'null'); } catch { r.storyboard = null; }
    delete r.transcript_cues_json;
  }
  res.json({ projects: rows });
});

app.post('/api/projects', async (req, res) => {
  try {
    if (!charge(req, res, COSTS.createProject)) return; // creating a project costs 1 credit
    const { url, sourceType, driveUrl, fileName, fileSizeBytes, durationSec } = req.body || {};
    if (sourceType === 'drive') {
      const fid = driveFileId(driveUrl || url || '');
      if (!fid) return res.status(400).json({ error: 'That is not a Google Drive share link. Paste the link from Share > Copy link.' });
      const r = db.prepare(`INSERT INTO projects (title, channel, source_url, source_type, drive_file_id, transcript_status, fetch_status)
        VALUES (?,?,?,'drive',?,'needs_paste','ready')`).run(fileName || 'Google Drive video', 'Google Drive', driveUrl || url, fid);
      return res.json({ project: db.prepare('SELECT * FROM projects WHERE id=?').get(r.lastInsertRowid) });
    }
    if (sourceType === 'upload') {
      if (fileSizeBytes && fileSizeBytes > 15 * 1024 * 1024 * 1024)
        return res.status(400).json({ error: 'That file is over the 15 GB maximum upload size.' });
      const r = db.prepare(`INSERT INTO projects (title, channel, source_type, file_name, file_size_bytes, duration_sec, transcript_status, fetch_status)
        VALUES (?,?, 'upload', ?, ?, ?, 'needs_paste','ready')`).run(fileName || 'Uploaded video', 'Uploaded file', fileName || '', fileSizeBytes || 0, durationSec || null);
      return res.json({ project: db.prepare('SELECT * FROM projects WHERE id=?').get(r.lastInsertRowid), note: 'The video itself stays on your device — this project stores its name, size and length only.' });
    }
    const link = url || '';
    // YouTube stays primary; Twitch video/clip and Kick video links also work
    // (yt-dlp already supports them). Twitch VODs usually have no captions,
    // so the fetch honestly falls back to "needs_paste".
    const ytId = youtubeId(link), twId = twitchId(link), kId = kickId(link);
    if (!ytId && !twId && !kId) return res.status(400).json({ error: 'Paste a YouTube, Twitch or Kick video link (watch, youtu.be, live, Shorts, twitch.tv/videos, twitch clip, kick.com/video).' });
    const srcType = ytId ? 'youtube' : twId ? 'twitch' : 'kick';
    const srcId = ytId || twId || kId;
    const srcLabel = srcType === 'youtube' ? 'YouTube' : srcType === 'twitch' ? 'Twitch' : 'Kick';
    const r = db.prepare(`INSERT INTO projects (title, channel, source_url, source_type, youtube_id, source_id, transcript_status, fetch_status)
      VALUES ('Loading…',?,?,?, ?, ?, 'pending','fetching')`).run(srcLabel, link, srcType, ytId || null, srcId);
    const id = r.lastInsertRowid;
    // Auto-fetch in the background: metadata + captions + traffic + live status,
    // no paste needed.
    fetchYouTube(link).then(({ info, cues, traffic, liveStatus, isLive, storyboard }) => {
      db.prepare(`UPDATE projects SET title=?, channel=?, duration_sec=?, thumb_url=?, transcript=?, transcript_cues_json=?, transcript_status=?, traffic_json=?, fetch_status=?, live_status=?, is_live=?, storyboard_json=? WHERE id=?`)
        .run(info.title || 'YouTube video', info.channel || info.uploader || 'YouTube',
          info.duration || null, info.thumbnail || null,
          transcriptToLines(cues), JSON.stringify(cues),
          cues.length ? 'ready' : 'needs_paste',
          JSON.stringify(traffic), cues.length ? 'ready' : 'needs_paste',
          liveStatus, isLive ? 1 : 0, storyboard ? JSON.stringify(storyboard) : null, id);
    }).catch((e) => {
      db.prepare(`UPDATE projects SET title=?, fetch_status='failed', fetch_error=?, transcript_status='needs_paste' WHERE id=?`)
        .run('YouTube video', String(e.message || e), id);
    });
    res.json({ project: db.prepare('SELECT * FROM projects WHERE id=?').get(id) });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

app.get('/api/projects/:id', (req, res) => {
  const p = db.prepare('SELECT * FROM projects WHERE id=?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Project not found.' });
  p.clips = db.prepare('SELECT * FROM clips WHERE project_id=? ORDER BY score DESC').all(p.id);
  try { p.storyboard = JSON.parse(p.storyboard_json || 'null'); } catch { p.storyboard = null; }
  res.json({ project: p });
});

// Storyboard sprite for the frame-select thumbnail strip.
app.get('/api/projects/:id/storyboard', (req, res) => {
  const p = db.prepare('SELECT * FROM projects WHERE id=?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Project not found.' });
  let sb = null;
  try { sb = JSON.parse(p.storyboard_json || 'null'); } catch {}
  if (!sb) return res.json({ storyboard: null, note: 'YouTube did not publish a storyboard for this video — use the player frames instead.' });
  res.json({ storyboard: sb, duration_sec: p.duration_sec });
});

// Timed captions for one clip (the exact times that will be burned in).
app.get('/api/projects/:id/clips/:clipId/captions', (req, res) => {
  const p = db.prepare('SELECT * FROM projects WHERE id=?').get(req.params.id);
  const c = db.prepare('SELECT * FROM clips WHERE id=? AND project_id=?').get(req.params.clipId, req.params.id);
  if (!p || !c) return res.status(404).json({ error: 'Project or clip not found.' });
  const { cues, timed } = getTimedCues(p, c);
  res.json({ clip_id: c.id, template: c.caption_template || 'word-cut', offset_sec: +(c.caption_offset || 0), timed, cues });
});

app.post('/api/projects/:id/transcript', (req, res) => {
  const p = db.prepare('SELECT * FROM projects WHERE id=?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Project not found.' });
  const text = String(req.body?.transcript || '').trim();
  if (text.length < 50) return res.status(400).json({ error: 'Paste the full transcript first — it looks too short.' });
  const cues = cuesFromText(text);
  db.prepare(`UPDATE projects SET transcript=?, transcript_cues_json=?, transcript_status='ready', fetch_status='ready' WHERE id=?`)
    .run(text, JSON.stringify(cues), p.id);
  res.json({ ok: true, cues: cues.length });
});

app.post('/api/projects/:id/find-clips', async (req, res) => {
  try {
    const p = db.prepare('SELECT * FROM projects WHERE id=?').get(req.params.id);
    if (!p) return res.status(404).json({ error: 'Project not found.' });
    if (!p.transcript || p.transcript.length < 50)
      return res.status(400).json({ error: 'No transcript yet — wait for the automatic fetch, or paste one.' });
    // Clip count: the user chooses any number (1, 2, 5, 10, …). No fixed
    // small limit — capped at 50 only to keep one request sane.
    const wanted = Math.max(1, Math.min(50, parseInt(req.body?.count || 5, 10) || 5));
    // Clip length range (PeakCut first-test standard: 15–45s). Clamped so the
    // range is always sane: min 5–120s, max min–180s.
    const minLen = Math.max(5, Math.min(120, parseInt(req.body?.min_sec ?? req.body?.minSec ?? 15, 10) || 15));
    const maxLen = Math.max(minLen, Math.min(180, parseInt(req.body?.max_sec ?? req.body?.maxSec ?? 45, 10) || 45));
    const moments = String(req.body?.moments || '').slice(0, 200);
    if (!charge(req, res, COSTS.findClips)) return; // finding clips costs 1 credit
    const { engine, note, clips } = await scoreClips(p, wanted, minLen, maxLen, moments);
    const ins = db.prepare(`INSERT INTO clips (project_id, start_sec, end_sec, score, hook, captions_json, hashtags) VALUES (?,?,?,?,?,?,?)`);
    const created = [];
    for (const c of clips) {
      const r = ins.run(p.id, c.start_sec, c.end_sec, c.score || 60, c.hook || '', JSON.stringify(c.captions || []), (c.hashtags || []).join(' '));
      created.push(db.prepare('SELECT * FROM clips WHERE id=?').get(r.lastInsertRowid));
    }
    res.json({ engine, note: note || null, requested: wanted, found: created.length, min_sec: minLen, max_sec: maxLen, created });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

app.post('/api/projects/:id/clips', (req, res) => {
  const p = db.prepare('SELECT * FROM projects WHERE id=?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Project not found.' });
  const { start_sec, end_sec, hook } = req.body || {};
  if (!(end_sec > start_sec)) return res.status(400).json({ error: 'End time must be after start time.' });
  const r = db.prepare(`INSERT INTO clips (project_id, start_sec, end_sec, score, hook, captions_json, hashtags) VALUES (?,?,?,?,?,'[]','')`)
    .run(p.id, start_sec, end_sec, 0, hook || 'Added manually.');
  res.json({ clip: db.prepare('SELECT * FROM clips WHERE id=?').get(r.lastInsertRowid) });
});

app.patch('/api/projects/:id/clips/:clipId', (req, res) => {
  const c = db.prepare('SELECT * FROM clips WHERE id=? AND project_id=?').get(req.params.clipId, req.params.id);
  if (!c) return res.status(404).json({ error: 'Clip not found.' });
  const fields = ['hook', 'status', 'layout', 'resolution'];
  const sets = [], vals = [];
  for (const f of fields) if (req.body?.[f] !== undefined) { sets.push(`${f}=?`); vals.push(req.body[f]); }
  if (req.body?.score !== undefined) { sets.push('score=?'); vals.push(Math.max(0, Math.min(100, parseInt(req.body.score, 10) || 0))); }
  if (req.body?.captions) { sets.push('captions_json=?'); vals.push(JSON.stringify(req.body.captions)); }
  if (req.body?.hashtags) { sets.push('hashtags=?'); vals.push(req.body.hashtags); }
  if (req.body?.caption_offset !== undefined) {
    const off = Math.max(-5, Math.min(5, Math.round(parseFloat(req.body.caption_offset) * 10) / 10 || 0));
    sets.push('caption_offset=?'); vals.push(off);
  }
  if (req.body?.caption_template !== undefined) {
    sets.push('caption_template=?'); vals.push(getTemplate(req.body.caption_template).id);
  }
  if (req.body?.checklist !== undefined) {
    // Pre-post checklist: {hook, ending, captions, face} booleans. Ticking
    // never blocks anything — it is only a checklist.
    const cl = req.body.checklist || {};
    const clean = {
      hook: !!cl.hook, ending: !!cl.ending, captions: !!cl.captions, face: !!cl.face,
    };
    sets.push('checklist_json=?'); vals.push(JSON.stringify(clean));
  }
  if (req.body?.ratio !== undefined) {
    const ok = ['9:16', '1:1', '4:5', '16:9'].includes(String(req.body.ratio)) ? String(req.body.ratio) : '9:16';
    sets.push('ratio=?'); vals.push(ok);
  }
  if (req.body?.duo_corner !== undefined) {
    const ok = ['auto', 'top-left', 'top-right', 'bottom-left', 'bottom-right'].includes(String(req.body.duo_corner)) ? String(req.body.duo_corner) : 'auto';
    sets.push('duo_corner=?'); vals.push(ok);
  }
  if (!sets.length) return res.json({ clip: c });
  db.prepare(`UPDATE clips SET ${sets.join(',')} WHERE id=?`).run(...vals, c.id);
  res.json({ clip: db.prepare('SELECT * FROM clips WHERE id=?').get(c.id) });
});

app.post('/api/projects/:id/clips/:clipId/translate', async (req, res) => {
  // Bengali <-> English only. Uses Gemini when a key is set; otherwise returns
  // an honest error instead of a fake translation.
  const c = db.prepare('SELECT * FROM clips WHERE id=? AND project_id=?').get(req.params.clipId, req.params.id);
  if (!c) return res.status(404).json({ error: 'Clip not found.' });
  if (!process.env.GEMINI_API_KEY) return res.status(400).json({ error: 'Translation needs GEMINI_API_KEY — set it in the environment, or keep the original captions.' });
  if (!charge(req, res, COSTS.translate)) return; // translating costs 1 credit
  const caps = JSON.parse(c.captions_json || '[]');
  const text = [c.hook, ...caps].join('\n');
  const isBn = /[\u0980-\u09FF]/.test(text);
  const target = isBn ? 'English' : 'Bengali';
  const prompt = `Translate each line below to ${target}. Keep the same number of lines, one per line, no extra text.\n\n${text}`;
  try {
    const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=' + encodeURIComponent(process.env.GEMINI_API_KEY),
      { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }) });
    if (!r.ok) throw new Error('Gemini returned ' + r.status);
    const d = await r.json();
    const out = (d?.candidates?.[0]?.content?.parts?.map((x) => x.text || '').join('') || '').split('\n').filter(Boolean);
    if (out.length < 1) throw new Error('Empty translation.');
    db.prepare(`UPDATE clips SET translated_hook=?, translated_captions_json=?, translated_lang=? WHERE id=?`)
      .run(out[0], JSON.stringify(out.slice(1)), isBn ? 'en' : 'bn', c.id);
    res.json({ clip: db.prepare('SELECT * FROM clips WHERE id=?').get(c.id), lang: isBn ? 'en' : 'bn' });
  } catch (e) { res.status(500).json({ error: 'Translation failed: ' + String(e.message || e) }); }
});

app.post('/api/projects/:id/clips/:clipId/render', async (req, res) => {
  const p = db.prepare('SELECT * FROM projects WHERE id=?').get(req.params.id);
  const c = db.prepare('SELECT * FROM clips WHERE id=? AND project_id=?').get(req.params.clipId, req.params.id);
  if (!p || !c) return res.status(404).json({ error: 'Project or clip not found.' });
  if (p.source_type !== 'youtube' && p.source_type !== 'twitch' && p.source_type !== 'kick')
    return res.status(400).json({ error: 'Auto-cut works from YouTube, Twitch and Kick links only — Drive and uploaded videos preview in their own app instead.' });
  if (c.render_status === 'rendering') return res.json({ clip: c, note: 'Already cutting.' });
  if (!charge(req, res, COSTS.render)) return; // cutting a clip costs 2 credits
  db.prepare(`UPDATE clips SET render_status='rendering', render_error=NULL WHERE id=?`).run(c.id);
  renderClipJob(p, c).then((info) => {
    db.prepare(`UPDATE clips SET render_status='ready', video_file=? WHERE id=?`).run(info.file, c.id);
  }).catch((e) => {
    db.prepare(`UPDATE clips SET render_status='failed', render_error=? WHERE id=?`).run(String(e.message || e).slice(0, 500), c.id);
    console.error('render failed', e.message);
  });
  res.json({ clip: db.prepare('SELECT * FROM clips WHERE id=?').get(c.id) });
});

// Rename a project / fix its channel (used when the YouTube fetch is blocked
// and the title would otherwise stay as "YouTube video").
app.patch('/api/projects/:id', (req, res) => {
  const p = db.prepare('SELECT * FROM projects WHERE id=?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Project not found.' });
  const sets = [], vals = [];
  if (req.body?.title !== undefined) { sets.push('title=?'); vals.push(String(req.body.title).slice(0, 200)); }
  if (req.body?.channel !== undefined) { sets.push('channel=?'); vals.push(String(req.body.channel).slice(0, 200)); }
  if (!sets.length) return res.json({ project: p });
  db.prepare(`UPDATE projects SET ${sets.join(',')} WHERE id=?`).run(...vals, p.id);
  res.json({ project: db.prepare('SELECT * FROM projects WHERE id=?').get(p.id) });
});

// ---- Live-stream clipping ----
app.post('/api/projects/:id/live-clip', async (req, res) => {
  const p = db.prepare('SELECT * FROM projects WHERE id=?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Project not found.' });
  if (p.source_type !== 'youtube')
    return res.status(400).json({ error: 'Live clipping works from YouTube only.' });
  if (p.live_status === 'is_upcoming' || p.live_status === 'post_live')
    return res.status(400).json({ error: 'This stream has not started yet — try again once it is live.' });
  if (p.live_status === 'was_live')
    return res.status(400).json({ error: 'This stream has ended — it is a normal video now, use the Cut button on a clip (VOD).' });
  if (p.live_status !== 'is_live' || !p.is_live)
    return res.status(400).json({ error: 'This video is not a live stream right now.' });
  const { start_sec, end_sec, hook } = req.body || {};
  if (!(end_sec > start_sec)) return res.status(400).json({ error: 'End time must be after start time.' });
  if (!charge(req, res, COSTS.render)) return; // cutting a live clip costs 2 credits
  const r = db.prepare(`INSERT INTO clips (project_id, start_sec, end_sec, score, hook, captions_json, hashtags, live_clip) VALUES (?,?,?,?,?,'[]','',1)`)
    .run(p.id, start_sec, end_sec, 0, hook || 'Clipped from live.');
  const clip = db.prepare('SELECT * FROM clips WHERE id=?').get(r.lastInsertRowid);
  db.prepare(`UPDATE clips SET render_status='rendering', render_error=NULL WHERE id=?`).run(clip.id);
  renderLiveClipJob(p, clip).then((info) => {
    db.prepare(`UPDATE clips SET render_status='ready', video_file=? WHERE id=?`).run(info.file, clip.id);
  }).catch((e) => {
    db.prepare(`UPDATE clips SET render_status='failed', render_error=? WHERE id=?`).run(String(e.message || e).slice(0, 500), clip.id);
    console.error('live render failed', e.message);
  });
  res.json({ clip: db.prepare('SELECT * FROM clips WHERE id=?').get(clip.id), note: 'Recording the live stream from its start and cutting your range — this takes a few minutes.' });
});

const DEFAULT_RECIPE = {
  recipe: 'Clip long video', brandKit: 'No brand kit',
  clipping: true, aiPicks: 'Auto', clipLength: 'auto',
  // Opus-style create flow: AI picks range and clip-length range map onto
  // the existing clip count and min/max length (see PICKS_MAP / LEN_MAP).
  aiPicksRange: 'Auto', clipLengthRange: 'auto', customMin: 15, customMax: 45,
  momentsPrompt: '', hookType: 'Headline',
  aiEngine: 'heuristic', // Settings → AI: 'heuristic' (built-in, always ready) or 'gemini'
  captions: true, captionStyle: 'Word Cut', captionTemplate: 'word-cut',
  autoHook: true, hookTemplate: 'Classic',
  motionGraphics: false, aiEmojis: false, autoBroll: false,
  speechCleanup: true, enhanceAudio: false, autoSfx: false,
  autoZoom: false, autoTransitions: false, autoColor: false,
  eyeContact: false, voiceDubbing: false,
  captionTranslation: false, translationLang: 'bn-en',
  // Copyright-safe unique formation — ON by default.
  uniqueLogo: true, uniqueTitleCard: true, uniqueEndCard: true, uniqueReframe: true,
  captionOffset: 0,
};
app.get('/api/recipe', (req, res) => {
  const row = db.prepare('SELECT settings_json FROM recipe WHERE id=1').get();
  const saved = row ? JSON.parse(row.settings_json) : {};
  res.json({ settings: { ...DEFAULT_RECIPE, ...saved } });
});

// ---- Settings → AI: engine choice + an honest test ----
// The engine choice is stored in the recipe settings. The test never fakes
// a ready state: heuristic is always ready; Gemini reports plainly when no
// key is set, and does a real tiny call when one is.
app.get('/api/ai-settings', (req, res) => {
  const s = recipeSettings();
  const engine = s.aiEngine === 'gemini' ? 'gemini' : 'heuristic';
  res.json({
    engine,
    model: engine === 'gemini' ? 'gemini-2.0-flash' : 'built-in heuristic',
    gemini_key_set: !!process.env.GEMINI_API_KEY,
  });
});
app.post('/api/ai-settings', (req, res) => {
  const engine = req.body?.engine === 'gemini' ? 'gemini' : 'heuristic';
  const s = recipeSettings();
  s.aiEngine = engine;
  db.prepare(`INSERT INTO recipe (id, settings_json) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET settings_json=excluded.settings_json`)
    .run(JSON.stringify(s));
  res.json({ ok: true, engine, model: engine === 'gemini' ? 'gemini-2.0-flash' : 'built-in heuristic', gemini_key_set: !!process.env.GEMINI_API_KEY });
});
app.get('/api/ai-settings/test', async (req, res) => {
  const s = recipeSettings();
  const engine = s.aiEngine === 'gemini' ? 'gemini' : 'heuristic';
  if (engine === 'heuristic') {
    return res.json({ ready: true, engine, model: 'built-in heuristic', message: 'Built-in heuristic is ready — no key needed. It scores moments from the transcript by hooks, numbers and questions.' });
  }
  if (!process.env.GEMINI_API_KEY) {
    return res.json({ ready: false, engine, model: 'gemini-2.0-flash', message: 'No GEMINI_API_KEY is set on the server — Gemini is not available. The built-in heuristic is being used instead.' });
  }
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 15000);
    const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=' + encodeURIComponent(process.env.GEMINI_API_KEY),
      { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: 'Reply with exactly: OK' }] }] }), signal: ctrl.signal });
    clearTimeout(t);
    if (!r.ok) return res.json({ ready: false, engine, model: 'gemini-2.0-flash', message: 'Gemini key is set but the test call failed (HTTP ' + r.status + ') — the built-in heuristic is being used instead.' });
    return res.json({ ready: true, engine, model: 'gemini-2.0-flash', message: 'Gemini is ready — the test call answered OK.' });
  } catch (e) {
    return res.json({ ready: false, engine, model: 'gemini-2.0-flash', message: 'Gemini test call failed (' + String(e.message || e).slice(0, 120) + ') — the built-in heuristic is being used instead.' });
  }
});
app.post('/api/recipe', (req, res) => {
  db.prepare(`INSERT INTO recipe (id, settings_json) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET settings_json=excluded.settings_json`)
    .run(JSON.stringify(req.body || {}));
  res.json({ ok: true });
});

// ---- Fix requests: real, server-stored ----
app.get('/api/fix-requests', (req, res) => {
  res.json({ requests: db.prepare('SELECT * FROM fix_requests ORDER BY id DESC').all() });
});
app.post('/api/fix-requests', (req, res) => {
  const text = String(req.body?.text || '').trim();
  if (!text) return res.status(400).json({ error: 'Write what to fix first.' });
  const r = db.prepare(`INSERT INTO fix_requests (text, status) VALUES (?, 'new')`).run(text);
  res.json({ request: db.prepare('SELECT * FROM fix_requests WHERE id=?').get(r.lastInsertRowid) });
});
app.patch('/api/fix-requests/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM fix_requests WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Request not found.' });
  const sets = [], vals = [];
  if (req.body?.text !== undefined) { sets.push('text=?'); vals.push(String(req.body.text)); }
  if (req.body?.status !== undefined) {
    if (!['new', 'working', 'done'].includes(req.body.status)) return res.status(400).json({ error: 'Status must be new, working or done.' });
    sets.push('status=?'); vals.push(req.body.status);
  }
  if (sets.length) { sets.push("updated_at=datetime('now')"); db.prepare(`UPDATE fix_requests SET ${sets.join(',')} WHERE id=?`).run(...vals, row.id); }
  res.json({ request: db.prepare('SELECT * FROM fix_requests WHERE id=?').get(row.id) });
});
app.delete('/api/fix-requests/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM fix_requests WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Request not found.' });
  db.prepare('DELETE FROM fix_requests WHERE id=?').run(row.id);
  res.json({ ok: true });
});

// ---- Clip pack export: one pack per project, with layout / size / translation ----
app.get('/api/projects/:id/pack', (req, res) => {
  const p = db.prepare('SELECT * FROM projects WHERE id=?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Project not found.' });
  const clips = db.prepare('SELECT * FROM clips WHERE project_id=? ORDER BY score DESC').all(p.id);
  res.json({
    project: { id: p.id, title: p.title, channel: p.channel, source_url: p.source_url, source_type: p.source_type, duration_sec: p.duration_sec },
    exported_at: new Date().toISOString(),
    clips: clips.map((c) => ({
      id: c.id, start_sec: c.start_sec, end_sec: c.end_sec, score: c.score,
      hook: c.hook, captions: JSON.parse(c.captions_json || '[]'), hashtags: c.hashtags,
      status: c.status, layout: c.layout, resolution: c.resolution,
      render_status: c.render_status, video_file: c.video_file || null,
      translated_hook: c.translated_hook || null,
      translated_captions: c.translated_captions_json ? JSON.parse(c.translated_captions_json) : null,
      translated_lang: c.translated_lang || null,
      caption_template: c.caption_template || 'word-cut',
      caption_offset: +(c.caption_offset || 0),
      ratio: c.ratio || '9:16',
      duo_corner: c.duo_corner || 'auto',
      checklist: c.checklist_json ? JSON.parse(c.checklist_json) : null,
      timed_captions: c.captions_timed_json ? JSON.parse(c.captions_timed_json) : null,
      live_clip: !!c.live_clip,
    })),
  });
});

// ---- Delete a clip / a project ----
app.delete('/api/projects/:id/clips/:clipId', (req, res) => {
  const c = db.prepare('SELECT * FROM clips WHERE id=? AND project_id=?').get(req.params.clipId, req.params.id);
  if (!c) return res.status(404).json({ error: 'Clip not found.' });
  if (c.video_file) { try { fs.unlinkSync(path.join(RENDER_DIR, c.video_file)); } catch {} }
  db.prepare('DELETE FROM clips WHERE id=?').run(c.id);
  res.json({ ok: true });
});
app.delete('/api/projects/:id', (req, res) => {
  const p = db.prepare('SELECT * FROM projects WHERE id=?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Project not found.' });
  db.prepare('DELETE FROM clips WHERE project_id=?').run(p.id);
  db.prepare('DELETE FROM projects WHERE id=?').run(p.id);
  res.json({ ok: true });
});

// ---- New hooks: 3 fresh variants built from the clip's own words ----
app.post('/api/projects/:id/clips/:clipId/hooks', (req, res) => {
  const c = db.prepare('SELECT * FROM clips WHERE id=? AND project_id=?').get(req.params.clipId, req.params.id);
  if (!c) return res.status(404).json({ error: 'Clip not found.' });
  const caps = JSON.parse(c.captions_json || '[]');
  const firstLine = (caps[0] || c.hook || '').trim();
  const hook = (c.hook || firstLine).trim();
  // Hook type (from the create flow): "Viral hook" leans on a question and
  // a "watch till the end" nudge; "Headline" keeps clean statements.
  const viral = (recipeSettings().hookType || 'Headline') === 'Viral hook';
  const variants = [
    hook,
    firstLine && firstLine !== hook ? firstLine : hook + ' — watch till the end.',
    viral
      ? (/[?]$/.test(hook) ? hook : hook.replace(/[.!।]?$/, '') + '?')
      : hook.replace(/[?]+$/, '.'),
  ].filter((v, i, a) => v && a.indexOf(v) === i).slice(0, 3);
  res.json({ hooks: variants });
});

app.listen(PORT, HOST, () => console.log(`Clip Studio listening on http://${HOST}:${PORT}`));
