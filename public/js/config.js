// SINC2026 frontend configuration.
//
// If this frontend is served BY the same Node server as the backend
// (the normal "npm start" setup), leave API_BASE_URL blank — everything
// will use relative "/api" paths automatically.
//
// If this frontend is deployed SEPARATELY (e.g. uploaded to Netlify) while
// the backend (server/ folder) runs elsewhere — Render, Railway, a VPS —
// set API_BASE_URL to that backend's full URL, ending in /api. Example:
//
//   API_BASE_URL: 'https://sinc2026-backend.onrender.com/api'
//
// After setting this, also set ALLOWED_ORIGIN on the backend to this
// site's exact Netlify URL so cross-site admin login works correctly.

window.SINC_CONFIG = {
  API_BASE_URL: 'https://sinc2026-backend.onrender.com/api'
};
