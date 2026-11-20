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

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = '0.0.0.0';
const DATA_DIR = path.join(__dirname, 'data');
const RENDER_DIR = path.join(__dirname, 'renders');
const SUB_DIR = path.join(DATA_DIR, 'subs');
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
`);

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/renders', express.static(RENDER_DIR));

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

function esc(s) { return String(s ?? '').replace(/'/g, "''"); }
function youtubeId(url) {
  const m = String(url || '').match(/(?:v=|youtu\.be\/|live\/|shorts\/)([A-Za-z0-9_-]{6,})/);
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

// ---- YouTube metadata + captions via yt-dlp (server-side, no paste needed) ----
async function fetchYouTube(url) {
  const meta = await run('yt-dlp', ['-j', '--no-playlist', url], { timeout: 60000 });
  if (meta.code !== 0) throw new Error('yt-dlp could not read this video (it may be private, age-restricted or blocking downloads).');
  let info = {};
  try { info = JSON.parse(meta.out); } catch { throw new Error('Could not parse video info from yt-dlp.'); }

  // Auto captions (and manual subs if present), English + Bengali preferred.
  const id = info.id || youtubeId(url) || crypto.randomUUID().slice(0, 8);
  const subOut = path.join(SUB_DIR, id);
  await run('yt-dlp', ['--skip-download', '--write-auto-subs', '--write-subs',
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
  return { info, cues, traffic };
}

// ---- Clip scoring: Gemini when a key is set, else transparent heuristic ----
const HOOK_WORDS = ['never', 'secret', 'mistake', 'stop', 'why', 'how', 'best', 'worst', 'free', 'truth', 'nobody', 'everyone', 'warning', 'shocking', 'insane', 'crazy', 'first', 'last', 'always', 'only', 'kintu', 'kintu', 'keno', 'kivabe', 'kokhono', 'sotti'];
function heuristicClips(cues, wanted, durationSec) {
  const sentences = [];
  for (const c of cues) {
    for (const part of c.text.split(/(?<=[.!?।])\s+/)) {
      if (part.trim()) sentences.push({ start: c.start, end: c.end, text: part.trim() });
    }
  }
  if (!sentences.length) return [];
  const scored = sentences.map((s, i) => {
    let score = 50;
    const low = s.text.toLowerCase();
    for (const w of HOOK_WORDS) if (low.includes(w)) score += 4;
    if (/\d/.test(s.text)) score += 5;
    if (/[?!]/.test(s.text)) score += 3;
    if (s.text.length > 60 && s.text.length < 220) score += 4;
    // Prefer moments near a traffic peak is handled by the caller; here spread out.
    return { ...s, score: Math.min(92, score), idx: i };
  }).sort((a, b) => b.score - a.score);

  const picked = [];
  for (const s of scored) {
    if (picked.length >= wanted) break;
    const start = Math.max(0, s.start - 2);
    const end = Math.min(durationSec || s.end + 30, start + 45);
    if (end - start < 12) continue;
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

async function geminiClips(cues, wanted) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return null;
  const excerpt = transcriptToLines(cues).slice(0, 12000);
  const prompt = `You score viral short-video moments from a transcript with [m:ss] timestamps. Return ONLY a JSON array, max ${wanted} items, each {"start_sec":number,"end_sec":number,"score":0-99,"hook":"short hook","captions":["line"],"hashtags":["#x"]}. Clips 15-60s, non-overlapping, best hook first.\n\n${excerpt}`;
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

async function scoreClips(project, wanted) {
  // Parse every [m:ss] marker in the text, wherever it appears (auto-fetch
  // stores one cue per line; a pasted transcript may be one long line).
  const cues = [];
  const re = /\[(\d+):(\d+)\]\s*([^\[]*)/g;
  let m;
  while ((m = re.exec(String(project.transcript || ''))) !== null) {
    const text = m[3].trim();
    if (text) cues.push({ start: +m[1] * 60 + +m[2], end: +m[1] * 60 + +m[2] + 5, text });
  }
  if (process.env.GEMINI_API_KEY) {
    try {
      const out = await geminiClips(cues, wanted);
      if (Array.isArray(out) && out.length) return { engine: 'gemini', clips: out };
    } catch (e) { /* fall through to heuristic, and say so */ }
  }
  return { engine: 'heuristic', note: 'No AI key set (or AI call failed) — moments scored with the built-in hook/keyword heuristic, not an LLM.', clips: heuristicClips(cues, wanted, project.duration_sec) };
}

// ---- MP4 render: yt-dlp section download + ffmpeg 9:16 with burned captions ----
function assEscape(s) {
  return String(s || '').replace(/\\/g, '\\\\').replace(/{/g, '\\{').replace(/}/g, '\\}').replace(/\n/g, ' ');
}
function writeAss(captions, startSec, file) {
  const fmt = (t) => {
    const cs = Math.max(0, Math.round(t * 100));
    const h = Math.floor(cs / 360000), m = Math.floor(cs / 6000) % 60, s = Math.floor(cs / 100) % 60, c = cs % 100;
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(c).padStart(2, '0')}`;
  };
  let events = '';
  const lines = (captions || []).map((c, i) => {
    const t0 = i * 3, t1 = t0 + 2.8;
    return `Dialogue: 0,${fmt(t0)},${fmt(t1)},Default,,0,0,0,,${assEscape(c)}`;
  }).join('\n');
  const ass = `[Script Info]\nScriptType: v4.00+\nPlayResX: 720\nPlayResY: 1280\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,Noto Sans Bengali,44,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,2,0,2,40,40,120,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n${lines}\n`;
  fs.writeFileSync(file, ass);
}

async function renderClipJob(project, clip) {
  const w = clip.resolution === '1080p' ? 1080 : 720;
  const h = clip.resolution === '1080p' ? 1920 : 1280;
  const outFile = `clip-${clip.id}-${clip.layout}-${clip.resolution}.mp4`;
  const outPath = path.join(RENDER_DIR, outFile);
  const srcBase = path.join(RENDER_DIR, `src-${clip.id}`);
  const dl = await run('yt-dlp', ['-f', 'bestvideo[height<=720]+bestaudio/best/best',
    '--download-sections', `*${clip.start_sec}-${clip.end_sec}`,
    '-o', srcBase + '.%(ext)s', project.source_url], { timeout: 300000 });
  // yt-dlp names the file by actual container (.webm/.mp4/.mkv) — find it.
  const srcPath = fs.readdirSync(RENDER_DIR)
    .filter((f) => f.startsWith(`src-${clip.id}.`))
    .map((f) => path.join(RENDER_DIR, f))[0];
  if (dl.code !== 0 || !srcPath) throw new Error('Download failed — YouTube blocked this video or the section is unavailable.');
  const caps = clip.translated_captions_json ? JSON.parse(clip.translated_captions_json) : JSON.parse(clip.captions_json || '[]');
  const assFile = path.join(RENDER_DIR, `cap-${clip.id}.ass`);
  writeAss(caps, clip.start_sec, assFile);
  const hookFile = path.join(RENDER_DIR, `hook-${clip.id}.ass`);
  const hookText = clip.translated_hook || clip.hook || '';
  writeAss([hookText], clip.start_sec, hookFile);

  const sub = `subtitles='${assFile.replace(/'/g, "'\\''")}'`;
  const fc = clip.layout === 'spotlight'
    ? `[0:v]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},${sub}[v]`
    : clip.layout === 'split'
      ? `[0:v]split[a][b];[a]scale=${w}:${Math.floor(h / 2)}:force_original_aspect_ratio=increase,crop=${w}:${Math.floor(h / 2)}[top];[b]scale=${w}:${Math.floor(h / 2)}:force_original_aspect_ratio=decrease,pad=${w}:${Math.floor(h / 2)}:(ow-iw)/2:(oh-ih)/2[bot];[top][bot]vstack,${sub}[v]`
      : `[0:v]split[a][b];[a]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},gblur=sigma=20[bg];[b]scale=${w}:${h}:force_original_aspect_ratio=decrease[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2,${sub}[v]`;
  const ff = await run('ffmpeg', ['-y', '-i', srcPath, '-filter_complex', fc,
    '-map', '[v]', '-map', '0:a?', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
    '-c:a', 'aac', '-shortest', outPath], { timeout: 600000 });
  try { fs.unlinkSync(srcPath); } catch {}
  if (ff.code !== 0 || !fs.existsSync(outPath)) throw new Error('ffmpeg failed to build the clip.');
  return outFile;
}

// ---- API ----
app.get('/health', (req, res) => res.json({ ok: true, service: 'clip-studio', time: new Date().toISOString() }));

app.get('/api/projects', (req, res) => {
  const rows = db.prepare('SELECT * FROM projects ORDER BY id DESC').all();
  for (const r of rows) {
    r.clip_count = db.prepare('SELECT COUNT(*) c FROM clips WHERE project_id=?').get(r.id).c;
    r.top_score = db.prepare('SELECT MAX(score) m FROM clips WHERE project_id=?').get(r.id).m || 0;
  }
  res.json({ projects: rows });
});

app.post('/api/projects', async (req, res) => {
  try {
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
    if (!youtubeId(link)) return res.status(400).json({ error: 'Paste a YouTube link (watch, youtu.be, live or Shorts).' });
    const r = db.prepare(`INSERT INTO projects (title, channel, source_url, source_type, youtube_id, transcript_status, fetch_status)
      VALUES ('Loading…','YouTube',?,'youtube',?,'pending','fetching')`).run(link, youtubeId(link));
    const id = r.lastInsertRowid;
    // Auto-fetch in the background: metadata + captions + traffic, no paste needed.
    fetchYouTube(link).then(({ info, cues, traffic }) => {
      db.prepare(`UPDATE projects SET title=?, channel=?, duration_sec=?, thumb_url=?, transcript=?, transcript_status=?, traffic_json=?, fetch_status=? WHERE id=?`)
        .run(info.title || 'YouTube video', info.channel || info.uploader || 'YouTube',
          info.duration || null, info.thumbnail || null,
          transcriptToLines(cues), cues.length ? 'ready' : 'needs_paste',
          JSON.stringify(traffic), cues.length ? 'ready' : 'needs_paste', id);
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
  res.json({ project: p });
});

app.post('/api/projects/:id/transcript', (req, res) => {
  const p = db.prepare('SELECT * FROM projects WHERE id=?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Project not found.' });
  const text = String(req.body?.transcript || '').trim();
  if (text.length < 50) return res.status(400).json({ error: 'Paste the full transcript first — it looks too short.' });
  db.prepare(`UPDATE projects SET transcript=?, transcript_status='ready', fetch_status='ready' WHERE id=?`).run(text, p.id);
  res.json({ ok: true });
});

app.post('/api/projects/:id/find-clips', async (req, res) => {
  try {
    const p = db.prepare('SELECT * FROM projects WHERE id=?').get(req.params.id);
    if (!p) return res.status(404).json({ error: 'Project not found.' });
    if (!p.transcript || p.transcript.length < 50)
      return res.status(400).json({ error: 'No transcript yet — wait for the automatic fetch, or paste one.' });
    const wanted = Math.max(1, Math.min(20, parseInt(req.body?.count || 5, 10)));
    const { engine, note, clips } = await scoreClips(p, wanted);
    const ins = db.prepare(`INSERT INTO clips (project_id, start_sec, end_sec, score, hook, captions_json, hashtags) VALUES (?,?,?,?,?,?,?)`);
    const created = [];
    for (const c of clips) {
      const r = ins.run(p.id, c.start_sec, c.end_sec, c.score || 60, c.hook || '', JSON.stringify(c.captions || []), (c.hashtags || []).join(' '));
      created.push(db.prepare('SELECT * FROM clips WHERE id=?').get(r.lastInsertRowid));
    }
    res.json({ engine, note: note || null, created });
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
  if (req.body?.captions) { sets.push('captions_json=?'); vals.push(JSON.stringify(req.body.captions)); }
  if (req.body?.hashtags) { sets.push('hashtags=?'); vals.push(req.body.hashtags); }
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
  if (p.source_type !== 'youtube')
    return res.status(400).json({ error: 'Auto-cut works from YouTube only — Drive and uploaded videos preview in their own app instead.' });
  if (c.render_status === 'rendering') return res.json({ clip: c, note: 'Already cutting.' });
  db.prepare(`UPDATE clips SET render_status='rendering' WHERE id=?`).run(c.id);
  renderClipJob(p, c).then((file) => {
    db.prepare(`UPDATE clips SET render_status='ready', video_file=? WHERE id=?`).run(file, c.id);
  }).catch((e) => {
    db.prepare(`UPDATE clips SET render_status='failed' WHERE id=?`).run(c.id);
    console.error('render failed', e.message);
  });
  res.json({ clip: db.prepare('SELECT * FROM clips WHERE id=?').get(c.id) });
});

app.get('/api/recipe', (req, res) => {
  const row = db.prepare('SELECT settings_json FROM recipe WHERE id=1').get();
  res.json({ settings: row ? JSON.parse(row.settings_json) : { captions: 'Word Cut', autoHook: 'Classic', speechCleanup: true, clipLength: 'auto' } });
});
app.post('/api/recipe', (req, res) => {
  db.prepare(`INSERT INTO recipe (id, settings_json) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET settings_json=excluded.settings_json`)
    .run(JSON.stringify(req.body || {}));
  res.json({ ok: true });
});

app.get('/api/fix-requests', (req, res) => res.json({ requests: [] }));

app.listen(PORT, HOST, () => console.log(`Clip Studio listening on http://${HOST}:${PORT}`));
