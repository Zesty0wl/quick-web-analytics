# Quick Web Analytics for iOS: product requirements

Status: **draft for review** · Owner: Neil · Last updated: 2026-10-09

Companion documents: [API.md](API.md) (the mobile API and how it's secured).

## 1. Summary

A native iPhone app (and later iPad) for Quick Web Analytics. It's for checking your sites at a glance, getting alerts
when something unusual happens, and digging into a site when you need to. It connects to any QWA instance, your own or
one you've been given access to. It's read-only in version 1; setup and administration stay in the web dashboard.

The web dashboard already works on a phone. The app is worth building for three things the web can't do well:

1. **Glanceable numbers without opening anything:** Home Screen and Lock Screen widgets, and a Live Activity during a spike.
2. **Alerts that reach you:** push notifications for spikes, drops and outages, instead of email.
3. **Instant, signed-in access:** no Cloudflare Access sign-in every day, with Face ID instead.

## 2. Goals and non-goals

### Goals (v1)
- See every site's visitors today and live, at a glance, within two seconds of opening the app.
- Open any site and see the same core picture as the dashboard:
  - the nine metrics, with change against the comparison period, and the chart
  - top sources, pages, countries and devices
  - realtime
  - Google Search and Speed, when connected
- See the unusual days and bursts the anomaly check finds, and choose which sites alert you.
- Widgets for live visitors and today's visitors, for one site or all.
- Connect to more than one QWA instance (e.g. your own and a client's), and switch between them.
- Be secure enough for analytics data:
  - nothing stored outside the Keychain
  - every device revocable from the dashboard
  - read-only tokens

### Not in v1
- Administration: adding sites, users or Google credentials, installing the tracker, changing caps. Those stay on the web, and the app links to it.
- Filters beyond a single dimension value: tapping a row drills into it (e.g. one page), but there's no filter builder.
- iPad-specific layout, Mac (Catalyst or native), Apple Watch. The iPad gets the iPhone layout scaled up; a proper iPad layout comes in v1.2.
- Android.
- Any analytics, tracking or third-party SDK inside the app itself.

## 3. Who it's for

| Person | What they want from the app |
|---|---|
| **Site owner** (Neil, and anyone running QWA for their own sites) | "How are my sites doing today?" in one glance; to know immediately when a site breaks or takes off. |
| **Client / viewer** (given access to one or two sites by an admin) | Their site's numbers without learning a dashboard; a widget on their Home Screen. |
| **Agency / multi-instance user** | Several QWA instances in one app, each with its own sites. |

## 4. Experience

### 4.1 First run and connecting

The person needs the address of a QWA instance and an account on it. Two ways to connect, both ending in the same
device token (see [API.md §2](API.md#2-authentication)):

1. **Enter the address and sign in (the main way).**
   - The person types the instance address (e.g. `analytics.example.com`). The app opens the instance's sign-in page in a secure browser sheet (`ASWebAuthenticationSession`), and they sign in with their credentials for that instance, exactly as on the web (Cloudflare Access: email code, Google…). The app never sees the credentials.
   - QWA asks them to approve "QWA for iOS on Neil's iPhone", then the sheet closes and they're in.
2. **Scan from the dashboard (a shortcut).**
   - In the web dashboard, the person opens **Your devices → Connect a phone**. It shows a QR code (and a link to tap on the phone).
   - They scan it with the app or the iPhone camera. The app opens, names itself after the device ("Neil's iPhone"), and is signed in with nothing to type.

Then:
- **Notifications:** asked once, after the first site list loads, with a sentence on why ("Get an alert when a site spikes, drops or goes quiet").
- **Face ID lock:** optional, off by default, offered in Settings.
- **Try without an account:** a **Try the demo** button on the first screen loads synthetic sites bundled with the app, the same generator as `npm run demo`. App Review needs it, and it's a good first impression.

### 4.2 Screens

**Sites (home)**
- The instance's sites as cards:
  - name and favicon
  - visitors today and the change against the same time last week
  - a sparkline for the period
  - the live visitor count with a pulsing dot
  - an alarm badge if there's an unusual day or burst
- A summary strip at the top: all sites' visitors, visits and pageviews today, and live now.
- Sort by visitors, growth or decline (same as the dashboard).
- Pull to refresh; it auto-refreshes every 30 seconds while open. Period picker: Today, 7 days, 30 days, 12 months.
- With several instances, a switcher in the navigation bar.

**Site**
- **Header:** site name, live count, period picker, comparison (previous period or last year).
- **Metric tiles** (swipeable row): visitors, visits, pageviews, views per visit, bounce rate, visit duration, time on page, scroll depth, events. Tapping one changes the chart.
- **Chart** (Swift Charts):
  - the comparison period dashed
  - alarm marks on unusual days
  - drag to scrub, tap a day to drill into it
- **Sections** (each a card, "See all" opens a full list):
  - Realtime: live visitors per minute, active pages, arriving from
  - Sources: channels and top sources
  - Pages: top, entry and exit
  - Countries: with flags
  - Devices: device, browser and OS
  - Events: custom and automatic
  - Google Search: clicks, impressions, CTR, position, top queries (when connected)
  - Speed: Core Web Vitals verdict and lab score (when connected)
- **Drilling in:** tapping a row (a page, a source, a country) drills in. The whole site screen re-renders filtered to that value, shown as a removable chip.

**Alerts**
- Unusual days and bursts across all sites, newest first, each with the dashboard's plain-English description ("A burst: 1,875 visits between 08:00 and 11:00, 10.7× a usual Friday…"). Tapping one opens the site at that day.
- **Per-site toggles** for push alerts, plus **Every site**. These are the same subscriptions as the email ones, with push as an extra channel.

**Settings**
- **Instances:** add, remove, switch.
- **This device:** name, revoke ("Sign out"), and a link to manage all devices on the web.
- **Notifications:** on/off, quiet hours.
- **Face ID lock.**
- **Appearance:** system, light or dark; accent colour, matching the dashboard's five palettes.
- About, privacy, licences, and a link to the GitHub project.

### 4.3 Widgets and system integration

| Feature | Version | Content |
|---|---|---|
| Small widget | v1 | One site: live visitors, today's visitors with change |
| Medium widget | v1 | One site: today's visitors with sparkline, top source and page |
| Large widget | v1.1 | Up to six sites: today's visitors and change each |
| Lock Screen widgets | v1 | Live visitors (circular), today's visitors (rectangular) |
| Live Activity / Dynamic Island | v1.1 | During a burst alert: live visitors and the multiple vs usual, for an hour |
| App Shortcuts / Siri | v1.1 | "How's issinfo.net doing?", "Live visitors on…" |
| Control Center control | later | Opens a chosen site |

- **Data source:** widgets use the same token through a shared Keychain access group, and refresh on the system's timeline budget, roughly every 15 minutes.
- **Freshness:** widgets show "as of" times rather than pretending to be live.

### 4.4 Notifications

- **What triggers them:** the same events as the email alerts. That's the hourly check (spikes, drops, bursts, possible outages) and the nightly check (unusual whole days), plus "recording paused" when a site hits its daily cap.
- **Example:** "📈 issinfo.net: a burst. 1,875 visits 08:00–11:00, 10.7× a usual Friday." Tapping opens the site at that time.
- **Grouping:** by instance and site, with the time-sensitive interruption level for outages only.
- **Delivery for self-hosted instances is the hard part.** APNs needs the app publisher's signing key, which a self-hosted instance doesn't have. Design, in v1.1:
  1. A small push relay Cloudflare Worker run by the publisher (`apps/push-relay` in this repo). It was checked on 2026-10-09: a Worker's `fetch` reaches APNs over HTTP/2.
  2. Each instance sends it the device's push token and an encrypted payload.
  3. A Notification Service Extension on the phone decrypts the payload with a key that only the phone and its instance hold.
  4. The relay sees only ciphertext and a device token.

  Details are in [API.md §6](API.md#6-push-notifications-v11). Until then, v1 uses background refresh plus local notifications as a best effort, and says so.

## 5. Requirements

### 5.1 Functional
- **F1** Connect to an instance by entering its address and signing in (or by scanning a QR code from the dashboard); several instances; switch and remove.
- **F2** Sites list with today's numbers, sparkline, live count and anomaly badge; sort; period picker.
- **F3** Site screen with the nine metrics, chart with comparison and anomaly marks, and the breakdown sections in §4.2.
- **F4** Drill into a single dimension value from any list; clear it.
- **F5** Alerts list across sites; per-site push subscription and "Every site".
- **F6** Small, medium and Lock Screen widgets, configurable per site.
- **F7** Settings: device name and sign-out, Face ID lock, appearance, notifications.
- **F8** Demo mode with bundled synthetic data, no network.
- **F9** Deep links: `qwa://pair?...` (pairing) and `qwa://site/<instance>/<site>?day=...` (open a site, used by notifications and widgets).

### 5.2 Quality
- **Speed:** cold start to a populated Sites screen in under 2 seconds on a recent iPhone with a warm cache. Show the cached data first, then refresh.
- **Offline:** the last loaded data stays readable, marked with its time.
- **Accessibility:**
  - Dynamic Type up to the accessibility sizes
  - VoiceOver labels on every chart (summary plus per-point values)
  - no information by colour alone, with the same rule as the dashboard: status always has a label or icon
  - Reduce Motion respected
- **Localisation:** English (UK) first. All strings in a String Catalog, numbers and dates formatted by locale.
- **Privacy:**
  - The app collects nothing; the App Store privacy label is "Data Not Collected".
  - No third-party SDKs.
  - Tokens only in the Keychain (`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`), never in UserDefaults, backups or logs.
- **Security:** see [API.md §5](API.md#5-security). The app never sees a Cloudflare Access cookie or the person's password.

### 5.3 Technical
- **Language and frameworks:** Swift 6, SwiftUI, Swift Charts, WidgetKit, App Intents. Swift concurrency throughout, no Combine. No third-party dependencies in v1.
- **Minimum OS:** iOS 18. It gives interactive widgets, Swift Charts' scrolling and selection APIs, and the newer Observation tools.
- **Networking:** `URLSession` with async/await, one `APIClient` per instance, typed models generated from (or checked against) the shared schema in `packages/shared`. Background refresh via `BGAppRefreshTask`.
- **Storage:** SwiftData (or plain JSON files) for the cache; Keychain for tokens, shared with the widget extension through an access group.
- **Project:** `apps/ios` in this monorepo, so an API change and its app change land in one pull request.
  - Bundle ID `uk.co.bzwrd.qwa`, on Neil's team.
  - Builds go to TestFlight, then the App Store, signed with the existing App Store Connect API key.
- **Tests:** unit tests for the API client and models (against recorded JSON fixtures), snapshot tests for key screens in light and dark, and a UI test of the pairing flow against the local demo (`npm run demo`).

## 6. API dependencies

The app needs a token-authenticated, read-only API that bypasses Cloudflare Access. It's specified in [API.md](API.md).
In brief:

- `/api/m/v1/*`, mirroring the dashboard's existing endpoints (overview, query, realtime, anomalies, search, speed, alerts), with the same JSON shapes.
- Device tokens issued by QR pairing or an OAuth-style sign-in (authorization code with PKCE). Each is listed and revocable in a new **Your devices** page in the dashboard.
- Push registration endpoints, for v1.1.

Server work comes first (milestone M0). The app can be built against `npm run demo`, which will serve the mobile API too.

## 7. Milestones

| Milestone | Scope | Exit criteria |
|---|---|---|
| **M0: Mobile API** | Device tokens, pairing and sign-in flows, `/api/m/v1` read endpoints, Your devices page, Access bypass for `/api/m/*`, docs and agent runbook updates | API tests pass; a device can pair, read, refresh and be revoked; the deploy guide and AGENTS.md cover the new bypass path |
| **M1: App skeleton** | Pairing, Sites list, Site screen (metrics, chart, sources, pages), demo mode | TestFlight build used daily by Neil for a week |
| **M2: Full v1** | All sections, drill-in, Alerts list and subscriptions, widgets, Settings, Face ID, multiple instances, local-notification fallback | Accessibility and privacy review done; App Store submission |
| **M3: v1.1** | Push relay and push alerts, large widget, Live Activity during bursts, App Shortcuts | Push delivered end to end within a minute of an hourly check, with an encrypted payload |
| **M4: v1.2** | iPad layout, Mac (Designed for iPad), Control Center control | — |

## 8. Success measures

The app has no analytics, so success is judged from the server side and from people:

- Devices connected per instance, and devices active in the last 7 days (from `last_used_at`, visible to admins on the Your devices page).
- Alerts opened from a notification versus email.
- App Store rating and reviews; GitHub issues labelled `ios`.

## 9. Decisions

Agreed with Neil on 2026-10-09:

| # | Question | Decision |
|---|---|---|
| 1 | Distribution | **One public App Store app.** You enter your instance's address and sign in with your credentials for it. Demo mode covers App Review. |
| 2 | Push for self-hosted instances | **A relay on a Cloudflare Worker** (`apps/push-relay`), run by the publisher, with end-to-end encrypted payloads, in v1.1. A Worker reaching APNs over HTTP/2 was checked. Background refresh is the v1 fallback. The relay URL is an instance setting, so self-builders can run their own. |
| 3 | Where the app lives | **`apps/ios` in this repo.** |
| 4 | Minimum iOS | **iOS 18.** |
| 5 | Name and bundle ID | **"Quick Web Analytics", `uk.co.bzwrd.qwa`.** |
| 6 | Permissions in the app | **Read-only for everyone in v1.** |

## 10. Risks

- **Cloudflare Access and the sign-in flow.**
  - Each instance must add `/api/m/*` to its Access bypass application, a one-time change covered by the updated docs and runbook.
  - Instances that skip it will fail at the token step. The app detects the Access redirect and explains the fix.
- **Self-hosted push.** It depends on a relay someone runs. Mitigations: encrypted payloads, a relay that's simple to self-host, and a clear v1 fallback.
- **App Review.** The app needs a server to be useful. Demo mode, plus review notes with a pairing code for a demo instance, covers it.
- **API drift.** The app and dashboard read the same endpoints. Mitigations: the mobile routes are versioned (`/v1`), changes are additive, and fixtures are checked in CI.
