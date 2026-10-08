# Security

Please report vulnerabilities privately through GitHub's **Report a vulnerability** button (Security tab) rather than in a public issue. You'll get a reply within a few days.

## Design notes

- **Sign-in** is delegated to Cloudflare Access. The Worker verifies Access's JWT signature, issuer and audience on every API request, and maps the email to a QWA user. Unknown emails get no data.
- **Authorisation** is per site: viewers can only query sites they've been granted. Admin routes check the admin role.
- **Write requests** must be same-origin and JSON (blocks cross-site form posts).
- **Local-only switches:**
  - `DEV_USER_EMAIL` (skip Access) and `DEMO` (seed synthetic data) only take effect on `localhost`.
  - Never set either in a deployed Worker.
- **No personal data at rest:**
  - visitors are a salted hash that changes daily, and old salts are deleted
  - IP addresses and user agents are used during ingestion and then discarded
