# Deploying this frontend to Netlify

Netlify hosts static files only — it can't run the Node/Express backend. So the setup is: **backend on Render/Railway (or similar), frontend (this folder) on Netlify**, pointed at each other.

## Step 1 — Deploy the backend first

From the project root (not this `public/` folder), deploy the `server/` app to a Node host — Render and Railway both work well:

1. Push the whole project to a GitHub repo (or use the host's manual/CLI deploy).
2. Create a new Web Service pointing at it. Build command: `npm install`. Start command: `npm start`.
3. Add a **persistent disk** mounted so it covers `server/data` and `public/uploads` — otherwise your database and uploaded media get wiped on redeploy.
4. Set environment variables:
   - `ADMIN_USER`, `ADMIN_PASSWORD` — your real admin login (don't leave the defaults)
   - `ALLOWED_ORIGIN` — set this **after** step 2 below, once you know your Netlify URL (e.g. `https://sinc2026.netlify.app`)
5. Deploy, then note the backend's public URL, e.g. `https://sinc2026-backend.onrender.com`.

## Step 2 — Point this frontend at the backend

Open `js/config.js` in this folder and set:

```js
window.SINC_CONFIG = {
  API_BASE_URL: 'https://sinc2026-backend.onrender.com/api'
};
```

(use your actual backend URL, keep the `/api` suffix).

## Step 3 — Upload to Netlify

Only the contents of **this `public/` folder** go to Netlify — not the `server/` folder, not `package.json`, not `node_modules`.

Files to upload (everything in `public/`):
```
index.html
admin.html
netlify.toml
css/styles.css
js/config.js
js/dashboard.js
js/admin.js
uploads/            (can be left empty — media is served from the backend, not from Netlify)
```

Easiest method — drag and drop:
1. Go to https://app.netlify.com/drop
2. Drag this entire `public` folder onto the page
3. Netlify gives you a live URL immediately (e.g. `https://random-name-123.netlify.app`) — you can rename the site later in Netlify's dashboard

Alternative — Netlify CLI:
```bash
cd public
npx netlify-cli deploy --prod --dir=.
```

## Step 4 — Close the loop

Go back to your backend host and set `ALLOWED_ORIGIN` to the exact Netlify URL from step 3 (including `https://`, no trailing slash), then redeploy the backend. This is what allows the admin login to work correctly across the two different domains.

## Verifying it worked

- Visit your Netlify URL — the dashboard should load stats (confirms the frontend can reach the backend and CORS is fine).
- Visit `<netlify-url>/admin.html`, try saving a club — the browser should prompt for the admin username/password. If you get a network/CORS error in the browser console instead, double-check `API_BASE_URL` in `config.js` and `ALLOWED_ORIGIN` on the backend match exactly.

## Note on admin.html security

Because Netlify just serves static files, it can't gate `admin.html` behind a login the way the old all-in-one setup did — anyone with the URL can *view* the admin page. They still can't save, edit, delete, or upload anything without the correct admin credentials, since that's enforced by the backend itself. If you want the page itself hidden too, Netlify's paid plans offer site-wide password protection you can turn on in the site's settings.
