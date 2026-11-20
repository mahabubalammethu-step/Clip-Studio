# Clip Studio — standalone app for Render Free

Personal AI clipping app. Paste a YouTube link and it detects the video,
fetches the transcript itself, analyses viewer traffic (YouTube most-replayed
data when published), scores the best moments, and cuts real 9:16 MP4s with
burned-in captions — no transcript paste needed.

This is a **scaffold + working core**, not a copy of the Muse artifact. It is
meant to be pushed to GitHub and deployed to Render Free.

## Run locally

```bash
npm install
npm start
# open http://localhost:3000
curl http://localhost:3000/health
```

Needs `ffmpeg` on the machine for MP4 cutting, and `yt-dlp` for YouTube
metadata / captions / section downloads. The Dockerfile installs both.
Without them, the app still boots and serves the UI; YouTube fetch and
rendering return an honest error instead of a fake success.

## Environment variables

| Variable | Required? | What it does |
|---|---|---|
| `PORT` | No (Render sets it) | Port the server listens on. |
| `GEMINI_API_KEY` | No | If set, clip scoring and Bengali↔English caption translation use Gemini. Without it, scoring uses a transparent keyword/hook heuristic and the API says so in its response. Translation returns an honest error without a key. Never commit a key — set it in the Render dashboard. |

## Endpoints

- `GET /health` — `{ok:true}`
- `POST /api/projects` — `{url}` YouTube, `{sourceType:'drive', driveUrl}`, or `{sourceType:'upload', fileName, fileSizeBytes, durationSec}` (15 GB max; uploaded files stay on the device — only metadata is stored)
- `GET /api/projects`, `GET /api/projects/:id`
- `POST /api/projects/:id/transcript` — paste fallback if auto-fetch fails
- `POST /api/projects/:id/find-clips` — `{count}` (1–20, your choice, no fixed limit)
- `POST /api/projects/:id/clips` — add a clip by hand
- `PATCH /api/projects/:id/clips/:clipId` — hook / status / layout (`full`|`split`|`spotlight`) / resolution (`720p`|`1080p`)
- `POST /api/projects/:id/clips/:clipId/translate` — Bengali↔English only
- `POST /api/projects/:id/clips/:clipId/render` — yt-dlp section download + ffmpeg 9:16 MP4, served under `/renders/`
- `GET/POST /api/recipe` — Recipe settings

Data lives in `data/clipstudio.db` (SQLite) and rendered MP4s in `renders/`.
Both are git-ignored.

## Deploy to Render Free

1. Push this folder to GitHub, e.g. `mahabubalammethu-step/clip-studio`.
2. Render dashboard → **New + → Web Service** → connect the repo.
3. Runtime **Node**, plan **Free**, region **Oregon**, build `npm install`, start `npm start`.
   Or apply `render.yaml` as a Blueprint. Via the API you also need the
   workspace ID (`ownerId`) — it is **not** the API key.
4. Optional: set `GEMINI_API_KEY` in the dashboard (Environment).
5. Wait for the first build, then open the `onrender.com` URL.

## Free-tier limits (honest)

- **$0, no card.** 750 instance-hours/month.
- Sleeps after **15 minutes idle** — first load takes ~30–60s to wake.
- **512 MB RAM / 0.1 CPU** — clip cutting is slow; keep clips short.
- **5 GB bandwidth/month.**
- **Disk is ephemeral** — `data/clipstudio.db` and `renders/` are wiped when
  the service restarts. For a personal tool this is acceptable; for anything
  durable, attach a persistent disk (paid) or re-create projects after a restart.
- YouTube sometimes blocks server-side downloads/captions. The app then shows
  the real error and offers the paste-transcript backup instead of pretending
  it worked.
