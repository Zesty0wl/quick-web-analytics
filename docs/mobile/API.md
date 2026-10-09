# Mobile API

Status: **draft for review** · Companion to [PRD.md](PRD.md)

The API the iOS app (and any future native client) uses to read a QWA instance. It mirrors the dashboard's own API, with
the same JSON shapes, under `/api/m/v1`. It's authenticated with device tokens that QWA issues and can revoke, instead
of Cloudflare Access cookies.

## 1. Why a separate API path

The dashboard API (`/api/*`) sits behind Cloudflare Access. A browser signs in once and carries the `CF_Authorization`
cookie. A native app can't use that well:

- The cookie expires (24 hours by default).
- It belongs to a browser session.
- Access can't be told to let a request through just because it carries a bearer token.

So:
- **Path:** native clients use `/api/m/v1/*`, which the instance's Access bypass application lets through (like `/t.js` and `/e`).
- **Auth:** the Worker authenticates every request on that path itself, with a device token.
- **Scope:** the path only ever exposes read endpoints plus the device's own settings. No admin endpoint is reachable with a device token.

Deployment change: add `<hostname>/api/m/*` to the public-paths (bypass) Access application. The deploy guide, AGENTS.md
and the Admin → Sites install check will say so; an app that hits the Access login page reports exactly this.

## 2. Authentication

### 2.1 Tokens

| Token | Format | Lifetime | Stored by the server as |
|---|---|---|---|
| Access token | `qwa_at_` + 43 chars (256 random bits, base64url) | 1 hour | SHA-256 hash |
| Refresh token | `qwa_rt_` + 43 chars | 60 days since last use (sliding); rotated on every use | SHA-256 hash, with a family ID |
| Pairing code | 128 random bits, base64url, in a QR code / link | 10 minutes, single use | SHA-256 hash |
| Authorization code | 128 random bits | 2 minutes, single use, bound to a PKCE challenge | SHA-256 hash |

- **Opaque tokens.** They're random strings rather than signed JWTs, so revocation takes effect on the next request.
- **Lookup cost:** one D1 read by hash, cached in the isolate for up to 60 seconds. A revoked token can therefore work for at most a minute in an isolate that cached it. Revocation also deletes the row, so new isolates refuse it at once.
- **Prefixes** make tokens recognisable to secret scanners (GitHub secret scanning can be asked to recognise `qwa_rt_`).
- **Binding:** every token belongs to one **device** row, which belongs to one **user**. A device token can do exactly what its user can see: an admin sees every site, a viewer only their sites. It's limited to the read scope in §3.

### 2.2 Getting tokens: pairing (QR, a shortcut)

For when the person is signed in to the dashboard on a computer.

1. In the dashboard: **Your devices → Connect a phone**. The browser, signed in through Access, calls
   `POST /api/devices/pairing` and gets `{ code, expiresAt }`. It shows a QR code for
   `qwa://pair?host=<hostname>&code=<code>`, also offered as a tappable `https://<hostname>/app/pair#<code>` link for
   someone already on the phone. That page hands off to the app.
2. The app sends:
   ```http
   POST /api/m/v1/auth/pair
   { "code": "…", "device": { "name": "Neil's iPhone", "platform": "ios", "model": "iPhone17,1", "appVersion": "1.0 (12)" } }
   ```
   and gets:
   ```json
   { "accessToken": "qwa_at_…", "refreshToken": "qwa_rt_…", "expiresIn": 3600, "device": { "id": 42, "name": "Neil's iPhone" }, "user": { "email": "…", "role": "admin" } }
   ```
3. The dashboard, polling `GET /api/devices`, shows the new device straight away.

The code is single-use and expires in 10 minutes. A wrong or used code returns `400 invalid_grant` and counts towards
the rate limit (§5.3).

### 2.3 Getting tokens: sign in on the phone (authorization code + PKCE, the main way)

What happens when the person enters their instance's address in the app and signs in with their credentials for it. This is OAuth 2.0's authorization code flow with PKCE (RFC 7636), with QWA as the
authorization server and Cloudflare Access doing the sign-in.

1. The app generates `code_verifier` (64 random chars) and `state`, and opens an `ASWebAuthenticationSession` at:
   ```
   https://<hostname>/app/authorize?client_id=qwa-ios&redirect_uri=qwa://auth&response_type=code
     &code_challenge=<BASE64URL(SHA256(verifier))>&code_challenge_method=S256&state=<state>&device_name=Neil%27s%20iPhone
   ```
   `/app/authorize` is an ordinary dashboard page behind Access. The person signs in as on the web, using the session
   browser's cookies, so it's often instant.
2. The page shows a consent screen: "**QWA for iOS** on *Neil's iPhone* wants to view the sites you can see on this
   QWA. It can't change anything." When they approve, the page calls `POST /api/devices/authorize`
   (Access-authenticated) with the parameters. The server:
   - checks `client_id` and that `redirect_uri` is exactly one of the registered app URIs (`qwa://auth`)
   - stores the code with the challenge
   - redirects to `qwa://auth?code=<code>&state=<state>`
3. The session closes; the app checks `state` and exchanges the code:
   ```http
   POST /api/m/v1/auth/token
   { "grant_type": "authorization_code", "code": "…", "code_verifier": "…", "redirect_uri": "qwa://auth", "device": { … } }
   ```
   It gets the same response as pairing.

### 2.4 Refreshing and signing out

```http
POST /api/m/v1/auth/token
{ "grant_type": "refresh_token", "refresh_token": "qwa_rt_…" }
```

- **Refresh** returns a new access token **and a new refresh token**; the old refresh token stops working.
- **Reuse detection:** if an old refresh token is ever presented again, someone has a copy. The whole device (its token family) is revoked, and the user sees "Signed out for security" with a prompt to reconnect.
- **Sign out:** `POST /api/m/v1/auth/revoke` with the refresh token, or the device's access token, revokes the device. It returns `204`.
- **From the dashboard:** the user can revoke any of their devices on **Your devices**; admins can revoke anyone's, from Admin → Users.
- **Lifetime:** devices unused for 60 days expire and are deleted by the nightly job. Deleting a user deletes their devices.

### 2.5 Using the access token

```http
GET /api/m/v1/me
Authorization: Bearer qwa_at_…
```

| Status | Body | App's response |
|---|---|---|
| `401` | `{ "error": "token_expired" }` | Refresh once and retry |
| `401` | `{ "error": "invalid_token" }` | The device was revoked or expired. Discard tokens; show "Reconnect" |
| `403` | `{ "error": "forbidden" }` | A site the user can no longer see |
| `429` | `{ "error": "rate_limited" }`, with `Retry-After` | Back off |

## 3. Endpoints (`/api/m/v1`)

Every endpoint takes `Authorization: Bearer <access token>` except the `auth/*` ones. Responses use the same shapes as
the dashboard API (types in `apps/web/src/api.ts`, to move to `packages/shared` so the iOS models can be checked
against them).

| Method and path | Same as dashboard | Notes |
|---|---|---|
| `POST auth/pair` | — | §2.2 |
| `POST auth/token` | — | §2.3, §2.4 |
| `POST auth/revoke` | — | §2.4 |
| `GET me` | `GET /api/me` | Adds `device` (id, name) and `instance` (name, version, features: `{ search, speed, push }`) |
| `GET overview?from&to&cfrom&cto` | `GET /api/overview` | Sites with daily totals, live count, per-minute series, anomalies, cap status |
| `POST sites/:site/query` | `POST /api/sites/:site/query` | The dashboard's query spec (metrics, groupBy, filters, limit); same validation and limits |
| `GET sites/:site/realtime` | `GET /api/sites/:site/realtime` | |
| `GET sites/:site/anomalies?from&to` | `GET /api/sites/:site/anomalies` | |
| `GET sites/:site/search?from&to&cfrom&cto&page&query` | `GET /api/sites/:site/search` | `status: not-connected / no-property / ok` |
| `GET sites/:site/search/rows?dim&…` | `GET /api/sites/:site/search/rows` | |
| `GET sites/:site/speed` | `GET /api/sites/:site/speed` | Read only; "Test now" stays on the web |
| `GET alerts` | `GET /api/alerts` | The user's subscriptions; adds `push: boolean` per channel |
| `PUT alerts` | `PUT /api/alerts` | `{ all, sites, channels: { email, push } }`: the user's own subscriptions |
| `GET devices/this` | — | This device's name and push status |
| `PATCH devices/this` | — | Rename |
| `PUT devices/this/push` | — | v1.1: register an APNs token and encryption key (§6) |
| `DELETE devices/this/push` | — | v1.1: stop push to this device |

**Not available with a device token:**
- everything under `/api/admin/*`
- `alerts/test`
- `speed/test`
- creating sites or users
- Google credentials

There's no route for them under `/api/m`, so there's nothing to misconfigure.

### Implementation sketch

The dashboard's route handlers move into a shared router that takes the authenticated user from context. It's mounted
twice:

- at `/api` behind the Access middleware (as today)
- at `/api/m/v1` behind a bearer-token middleware, with an allow-list of the read routes above

That means no duplicated query logic: the mobile API can't drift from the dashboard's numbers.

New tables (migration `0009_devices`):

```sql
CREATE TABLE devices (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  platform TEXT NOT NULL,                 -- ios
  model TEXT, app_version TEXT,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL,
  family TEXT NOT NULL,                   -- refresh-token family; reuse revokes the device
  refresh_hash TEXT NOT NULL UNIQUE,
  refresh_expires_at INTEGER NOT NULL,
  access_hash TEXT UNIQUE,
  access_expires_at INTEGER,
  push_token TEXT, push_key TEXT, push_env TEXT   -- v1.1
);
CREATE TABLE device_grants (                  -- pairing and authorization codes
  code_hash TEXT PRIMARY KEY,
  kind TEXT NOT NULL,                     -- pairing | authorization_code
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_challenge TEXT,                    -- PKCE (authorization_code only)
  redirect_uri TEXT,
  expires_at INTEGER NOT NULL
);
```

Dashboard additions:
- A **Your devices** page for every user: list, rename, revoke, and **Connect a phone** with its QR code.
- A devices column in Admin → Users.

## 4. Conventions

- **Format:** JSON, UTF-8. Dates are `YYYY-MM-DD` in the site's timezone; timestamps are Unix seconds (as in the dashboard API).
- **Errors:** `{ "error": "<code>", "message": "<human text>" }`.
- **Versioning:** the `v1` path is additive-only. New fields may appear; clients ignore unknown fields. A breaking change means `/api/m/v2` alongside `v1` for at least two app releases.
- **Version header:** the server sends `QWA-Version: <server version>`. The app sends `User-Agent: QWA-iOS/<version> (<model>; iOS <version>)`.
- **Caching:** responses carry `Cache-Control: private, no-store`. The app keeps its own cache; there's no shared caching of user data.

## 5. Security

### 5.1 Threat model

| Threat | Mitigation |
|---|---|
| A lost or stolen phone | Tokens live in the Keychain, accessible only when unlocked on that device (`…ThisDeviceOnly`), so they're excluded from backups. Optional Face ID lock. The user or an admin revokes the device from the dashboard. Device tokens are read-only. |
| Token leaked from logs or a screenshot | Tokens are never logged by the Worker; request logging excludes the `Authorization` header. Access tokens last an hour. Refresh rotation plus reuse detection means a leaked refresh token kills the device as soon as either copy is used twice. |
| Brute-forcing codes or tokens | 128-bit codes, 256-bit tokens. Per-IP rate limits on `auth/*`. Failed attempts are counted and logged at warn level. |
| Stolen authorization code (custom-scheme hijack) | PKCE: the code is useless without the verifier, which never leaves the app. `redirect_uri` is checked exactly; `state` is checked by the app. |
| Cross-site request forgery on the dashboard's pairing and authorize endpoints | These are Access-authenticated, same-origin JSON only (the existing check on non-GET requests). The consent page requires an explicit click. |
| The mobile path exposing more than intended | An allow-list of read routes; admin routes aren't mounted under `/api/m`. Site access checks are the same functions the dashboard uses. |
| A viewer's access removed while their phone is signed in | Every request re-checks site access against D1 (the per-isolate cache lasts at most 60 seconds). Deleting the user deletes their devices. |
| Downgrade to plain HTTP | Cloudflare serves the hostname over HTTPS only. The app refuses non-HTTPS instance URLs, except `localhost` in debug builds. |

### 5.2 What the app stores
- **Per instance, in the Keychain:** the hostname, the refresh token and the access token, shared with the widget extension through an access-group entitlement.
- **Cached responses** in the app container, which iOS encrypts at rest (Data Protection, complete until first user authentication).
- **Nothing else:** no email address in UserDefaults, no analytics, no crash-reporting SDK. MetricKit can be used, since it stays on the device unless the user shares it.

### 5.3 Rate limits
- **`auth/*`:** 10 requests a minute per IP, and 5 failed attempts per IP per 10 minutes, then `429` for 10 minutes. Enforced in the Worker with a Durable Object counter; also recommended as a zone rate-limit rule in AGENTS.md.
- **Read endpoints:** 120 requests a minute per device. The app's normal use is a few requests a minute; widgets are a few an hour.

## 6. Push notifications (v1.1)

APNs only accepts pushes signed with the app publisher's key, which self-hosted instances don't have. Design:

1. **Registration.** The app registers for remote notifications. It also generates a 256-bit key and stores it in a Keychain group shared with its Notification Service Extension. It sends both the APNs token and the key to its own instance with `PUT /api/m/v1/devices/this/push`. The instance stores them on the device row.
2. **When an alert fires**, the instance:
   - builds the notification text (the same text as the email subject and first line)
   - encrypts it with AES-256-GCM using the device's key
   - sends it to the **push relay**: `POST https://<relay>/v1/push` with the APNs token, the ciphertext and an instance ID
3. **The relay** (`apps/push-relay`), a Cloudflare Worker run by the app publisher, holds the APNs key (a `.p8` signing key, as a secret). It signs APNs's ES256 JWT with WebCrypto and sends the alert over HTTP/2, with `mutable-content: 1` (on 2026-10-09 a Worker's `fetch` was checked to reach APNs over HTTP/2). The visible fallback text is just "New alert from Quick Web Analytics".
4. **On the phone**, the Notification Service Extension decrypts the payload and replaces the text and the deep link.

The relay never sees site names or numbers. It rate-limits per device token and per instance, and keeps no logs of
payloads. The relay URL is an instance setting (`PUSH_RELAY_URL`), so anyone who builds their own app can run their own
relay. Until v1.1, the app uses background refresh (`BGAppRefreshTask`) to check `overview` for new anomalies and posts
local notifications: best effort, and the app says so.

## 7. Testing

- **Worker unit tests:** token generation and hashing, rotation and reuse detection, PKCE verification, expiry, the route allow-list (every `/api/admin` route returns `404` under `/api/m`), and site-access checks for viewers.
- **Integration:** the local demo (`npm run demo`) serves `/api/m/v1`, and a test pairs a fake device and walks through every read endpoint. The same flow is the iOS UI test.
- **Before launch:** a manual review of the auth endpoints, plus the checklist in this section.
