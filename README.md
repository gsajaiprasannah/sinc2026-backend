# SINC2026 — Skål Club Congress Dashboard

A mobile-first, responsive congress dashboard with a real backend (Node.js + Express + built-in SQLite) and an admin panel for managing all event data.

## What's included

**Public dashboard** (`/`, mobile-first, auto-refreshes every 30s)
- Total members nationwide, total clubs, total registrations, single vs double registration counts, amount collected
- Club-wise members vs registrations chart + table
- Nation-wise (state-wise) member breakdown chart
- Looping video reel
- Looping poster / event material display
- Live "happenings" feed (announcements/timeline)

**Admin panel** (`/admin.html`, password protected)
- Clubs & members: add one at a time or bulk-upload via CSV
- Registrations & payments: single/double type, amount paid/due, payment status, reference — one at a time or CSV
- Participants: full profile — name, phone, WhatsApp, address, club, registration link, arrival & departure travel (flight/train number + time), pickup driver/vehicle/phone, SPOC name/phone, notes — one at a time or CSV, with search
- Media: upload videos and posters, toggle which ones are active in the public loop, delete
- Happenings: post timestamped updates that appear on the public feed
- Voice agent export: downloads a structured JSON (facts + Q&A pairs + raw tables) built from live data, ready to feed into a voice agent's knowledge base or retrieval pipeline

## Requirements

- **Node.js 22.5 or newer** (the database uses Node's built-in `node:sqlite` module — no native compiling, no separate database server to install)

## Running it locally

```bash
cd sinc2026
npm install
npm start
```

Then open:
- Dashboard: http://localhost:3000
- Admin: http://localhost:3000/admin.html

On first run, the app creates `server/data/sinc2026.db` and seeds it with sample clubs/registrations/participants so you can see the dashboard working immediately. Delete that file (or the whole `server/data` folder) to start with a clean database.

## Admin login

The admin page and every data-changing request (add/edit/delete/upload) require a username and password (browser will prompt). Defaults:

- Username: `admin`
- Password: `sinc2026admin`

**Change these before the real event** by setting environment variables when you start the server:

```bash
ADMIN_USER=congressadmin ADMIN_PASSWORD=your-strong-password npm start
```

The public dashboard itself needs no login — it only reads data.

## Loading your real Phase 1 data

Use the CSV templates in `sample-data/` as a starting point — column headers must match:

- `clubs-template.csv` → Admin → Clubs & Members → Bulk upload
- `registrations-template.csv` → Admin → Registrations & Payments → Bulk upload (club must already exist by exact name)
- `participants-template.csv` → Admin → Participants → Bulk upload (club and registration should already exist)

Re-uploading a CSV with the same club name or registration number updates that record rather than duplicating it.

## Media for the loop displays

Upload directly from Admin → Media. Files are stored in `public/uploads/videos` and `public/uploads/posters` and served straight to the dashboard. Large video files are supported (up to 500MB per file by default — adjust the limit in `server/routes/media.js` if needed). Use "Hide" to pull something out of the loop without deleting it.

## Hosting it for the actual congress

This is a real Node.js app, so it needs to run somewhere reachable by attendee phones — not just your laptop. Options, roughly easiest to most control:

1. **Render / Railway / Fly.io** — connect the repo, set the start command to `npm start`, add a persistent disk mounted at `server/data` and `public/uploads` (otherwise uploaded media and new data can be wiped on redeploy). Set `ADMIN_PASSWORD` as an environment variable there.
2. **Your own VPS** (DigitalOcean, AWS EC2, etc.) — clone the repo, run `npm install && npm start` behind a process manager like `pm2`, put Nginx in front for HTTPS.
3. **On-site laptop only** — if the dashboard is just for a screen at the venue and doesn't need to be reachable off-site, running it locally is enough; skip hosting entirely.
4. **Frontend on Netlify + backend elsewhere** — Netlify only serves static files, so the `public/` folder can be deployed there on its own while `server/` runs on Render/Railway/a VPS as in option 1. See **`public/NETLIFY-DEPLOY.md`** for the exact steps (backend env vars, `config.js`, which files to upload, CORS setup).

Whichever you pick, make sure `server/data/` and `public/uploads/` persist across restarts/redeploys — that's where all your data and media live.

## Exporting data for your voice agent

Admin → Voice Agent Export → "Download voice-agent-data.json", or hit `GET /api/export/voice-agent` directly. It returns:
- A summary of key numbers
- A list of natural-language Q&A pairs generated from current clubs, registrations, payment statuses, travel/pickup/SPOC info, and happenings
- The raw underlying tables

This is meant as a ready-to-ingest knowledge base for your voice agent's retrieval or fine-tuning step — it doesn't train a model itself, since that depends on which voice agent platform you're using.

## Project structure

```
sinc2026/
├── server/
│   ├── index.js          # Express app, auth, static file serving
│   ├── db.js              # schema + seed data (node:sqlite)
│   └── routes/
│       ├── clubs.js
│       ├── registrations.js
│       ├── participants.js
│       ├── media.js
│       ├── happenings.js
│       ├── stats.js
│       └── export.js
├── public/
│   ├── index.html          # public dashboard
│   ├── admin.html          # admin panel
│   ├── css/styles.css
│   ├── js/dashboard.js
│   ├── js/admin.js
│   └── uploads/            # video + poster files land here
├── sample-data/            # CSV templates
└── package.json
```

## Known limitations / good next steps

- Single shared admin login (no per-person accounts or roles yet) — fine for a small organizing team, less so for a large volunteer crew.
- No SMS/WhatsApp automation yet for confirming registrations or sending pickup details — the data model supports it, integration would be a follow-up.
- No authentication on the public dashboard by design (it's meant for open display), so don't put anything sensitive there beyond aggregate numbers.
- The "happenings" feed is manual entry — no auto-import from photos/social media yet.
