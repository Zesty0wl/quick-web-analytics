# To do

Planned work, roughly in order. Tick items off as they land (with the commit or PR), and move finished milestones to
[CHANGELOG.md](CHANGELOG.md) at release time.

## iOS app

Plan: [docs/mobile/PRD.md](docs/mobile/PRD.md) · API: [docs/mobile/API.md](docs/mobile/API.md).

Decided:
- one public App Store app; you enter your instance's address and sign in
- push relay on a Cloudflare Worker
- `apps/ios` in this repo
- iOS 18
- bundle ID `uk.co.bzwrd.qwa`
- read-only in v1

### M0: Mobile API (server)
- [ ] Migration `0009_devices`: `devices` and `device_grants` tables
- [ ] Device tokens:
  - [ ] issue (`qwa_at_` / `qwa_rt_`, stored hashed)
  - [ ] refresh with rotation, and revoke the device if an old refresh token is reused
  - [ ] revoke
  - [ ] expire after 60 days unused, from the nightly job
- [ ] Bearer-token middleware for `/api/m/v1`, with a 60-second per-isolate cache and site-access checks on every request
- [ ] Move the dashboard's read handlers into a shared router mounted at `/api` (Access) and `/api/m/v1` (tokens), with an allow-list of read routes
- [ ] Sign in on the phone: `/app/authorize` consent page, `POST /api/devices/authorize`, `POST /api/m/v1/auth/token` (authorization code + PKCE, exact redirect URI)
- [ ] QR pairing: `POST /api/devices/pairing`, `POST /api/m/v1/auth/pair`, and the `https://<host>/app/pair#code` hand-off page
- [ ] `GET /api/m/v1/me` with device and instance info (version, features)
- [ ] Alert subscriptions with channels (`email`, `push`)
- [ ] Rate limits on `auth/*` (Durable Object counter); per-device limit on reads
- [ ] **Your devices** page in the dashboard (list, rename, revoke, Connect a phone); devices column in Admin → Users
- [ ] Move the dashboard's response types to `packages/shared` so the iOS models can be checked against them
- [ ] `npm run demo` serves `/api/m/v1` (for building the app locally)
- [ ] Tests:
  - [ ] token lifecycle
  - [ ] PKCE
  - [ ] reuse detection
  - [ ] every `/api/admin` route returns 404 under `/api/m`
  - [ ] viewer site access
  - [ ] the pairing flow end to end
- [ ] Docs:
  - [ ] DEPLOY.md and AGENTS.md: add `/api/m/*` to the Access bypass application
  - [ ] the install check flags it if it's missing
  - [ ] CHANGELOG upgrade note
- [ ] Production: add `/api/m/*` to the bypass application on our own instance

### M1: App skeleton
- [ ] `apps/ios` Xcode project (SwiftUI, Swift 6, iOS 18), bundle ID `uk.co.bzwrd.qwa`, App Store Connect app record
- [ ] `APIClient` per instance; Keychain token store shared with extensions
- [ ] Connect by address and sign-in (`ASWebAuthenticationSession`, PKCE) and by QR
- [ ] Sites screen (today, sparkline, live count, anomaly badge, sort, period picker)
- [ ] Site screen: metric tiles, chart with comparison and anomaly marks, sources, pages
- [ ] Demo mode with bundled synthetic data
- [ ] TestFlight build; a week of daily use

### M2: v1
- [ ] All site sections: realtime, countries, devices, events, Google Search, Speed
- [ ] Drill into a dimension value, shown as a removable chip
- [ ] Alerts list and per-site subscriptions (including Every site)
- [ ] Widgets: small, medium, Lock Screen
- [ ] Settings: instances, device name, sign out, Face ID lock, appearance, notifications
- [ ] Multiple instances and the switcher
- [ ] Background refresh with local notifications (the push fallback)
- [ ] Accessibility pass (Dynamic Type, VoiceOver for charts, Reduce Motion), privacy label "Data Not Collected"
- [ ] App Store submission (review notes with demo mode and a demo instance pairing code)

### M3: v1.1
- [ ] `apps/push-relay`: a Cloudflare Worker with the APNs `.p8` key; ES256 JWT via WebCrypto; per-token and per-instance rate limits
- [ ] Instance side: `PUSH_RELAY_URL`, `PUT/DELETE /api/m/v1/devices/this/push`, AES-256-GCM payloads per device
- [ ] Notification Service Extension that decrypts and deep-links
- [ ] Large widget, Live Activity during a burst, App Shortcuts

### M4: v1.2
- [ ] iPad layout, Mac (Designed for iPad), Control Center control

## Deployment and setup
- [ ] End-to-end test of AGENTS.md: have an agent deploy a throwaway instance on a spare hostname, then delete it
- [ ] Run the `gcloud` commands in AGENTS.md Phase 7 for real and fix anything that differs
- [ ] Optional `npm run setup` for people deploying by hand without an agent

## Release
- [ ] Publish v0.3.0 (Google Search and Speed, guided Google setup, agent-first deployment, Scheduler, burst alerts)
