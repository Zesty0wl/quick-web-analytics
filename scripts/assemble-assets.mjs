// Builds apps/worker/public: the dashboard SPA, the QWA tracker (served at /t.js from /_tracker)
// and the Plausible-compat tracker files (under /_compat).
import { cpSync, mkdirSync, rmSync } from "node:fs";
const out = new URL("../apps/worker/public/", import.meta.url);
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(new URL("../apps/web/dist/", import.meta.url), out, { recursive: true });
cpSync(new URL("../packages/tracker-compat/scripts/", import.meta.url), new URL("_compat/", out), { recursive: true });
cpSync(new URL("../packages/tracker/dist/t.js", import.meta.url), new URL("_tracker/t.js", out));
console.log("assembled", out.pathname);
