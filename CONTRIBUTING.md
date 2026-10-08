# Contributing

Thanks for helping! Bug reports, ideas and pull requests are all welcome.

## Getting set up

```sh
npm install
npm run demo        # both Workers locally, with synthetic sites and live traffic: http://localhost:8787
```

The demo signs you in as an admin and stores its data under `apps/worker/.wrangler/demo`. `npm run demo -- --fresh` starts over.

To run against your own Cloudflare data instead, see [docs/DEPLOY.md](docs/DEPLOY.md). Locally, `DEV_USER_EMAIL` in `apps/worker/.dev.vars` stands in for Cloudflare Access (it only works on `localhost`).

## Before opening a pull request

```sh
npm run typecheck
npm test
npm run build
```

CI runs the same three commands.

## Guidelines

- **Small surface area.** QWA tries to do a few things well. For a big new feature, please open an issue first so we can agree on the shape.
- **Privacy first.** No cookies, no storing IPs or user agents, nothing that identifies a person across days.
- **Clean room.** Don't copy code or data files from Plausible's server or dashboard (AGPL-3.0). Its tracker (MIT) is fine, with attribution.
- **Dependencies.** Prefer none. If you add one, pin an exact version and check its licence is MIT-compatible.
- **Storage layout** (`packages/shared/src/tables.ts`) is a contract with existing data in R2. Changes need a migration path.
- **Screenshots.** If you change the UI, regenerate them with the demo running: `npm i --no-save playwright-core && node scripts/screenshots.mjs`.

By contributing you agree your work is released under the MIT licence.
