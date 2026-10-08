#!/usr/bin/env node
// `npm run demo`: run Quick Web Analytics locally with synthetic sites and traffic. No Cloudflare account needed.
//
// Builds the dashboard if needed, starts both Workers with `wrangler dev` (local D1, R2 and Durable Objects,
// stored under apps/worker/.wrangler/demo), seeds 8 fictional sites with about 13 months of history, then keeps
// adding live traffic so the realtime panels move. Open http://localhost:8787 (you're signed in as an admin).
// Options: --port 8787, --fresh (wipe the demo data first).
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const worker = `${root}apps/worker`;
const args = process.argv.slice(2);
const port = Number(args[args.indexOf("--port") + 1]) || 8787;
const base = `http://localhost:${port}`;
const persist = ".wrangler/demo";
const log = (...a) => console.log("\x1b[36m[demo]\x1b[0m", ...a);

if (args.includes("--fresh")) rmSync(`${worker}/${persist}`, { recursive: true, force: true });

if (!existsSync(`${worker}/public/index.html`)) {
  log("building the dashboard and tracker…");
  if (spawnSync("npm", ["run", "build"], { cwd: root, stdio: "inherit" }).status !== 0) process.exit(1);
}

// Demo config: the example config without routes or crons, plus the demo flags.
const example = readFileSync(`${worker}/wrangler.example.jsonc`, "utf8")
  .replace(/^\s*\/\/.*$/gm, "")
  .replace(/,(\s*[}\]])/g, "$1");
const config = JSON.parse(example);
delete config.routes;
delete config.triggers;
config.vars = { ...config.vars, DEMO: "1", DEV_USER_EMAIL: "demo@example.com", BOOTSTRAP_ADMINS: "demo@example.com", COMPAT_ENDPOINT: `${base}/api/event` };
writeFileSync(`${worker}/.demo.wrangler.jsonc`, JSON.stringify(config, null, 2));

const wrangler = (a, opts = {}) => spawnSync("npx", ["wrangler", ...a], { cwd: worker, stdio: "inherit", ...opts });
log("applying database migrations…");
if (wrangler(["d1", "migrations", "apply", "qwa", "--local", "-c", ".demo.wrangler.jsonc", "--persist-to", persist]).status !== 0) process.exit(1);

log(`starting the Workers on ${base}…`);
const dev = spawn("npx", ["wrangler", "dev", "-c", ".demo.wrangler.jsonc", "-c", "../query/wrangler.jsonc", "--port", String(port), "--persist-to", persist], {
  cwd: worker,
  stdio: ["ignore", "pipe", "pipe"],
});
// Keep wrangler's request log quiet, but always show errors.
const out = (chunk) => {
  const s = chunk.toString();
  if (/error|✘|exception|uncaught/i.test(s)) process.stderr.write(s);
};
dev.stdout.on("data", out);
dev.stderr.on("data", out);
dev.on("exit", (code) => {
  log(`wrangler exited (${code})`);
  process.exit(code ?? 1);
});
const stop = () => {
  dev.kill("SIGINT");
  setTimeout(() => process.exit(0), 1500);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

const call = async (path, body) => {
  const res = await fetch(`${base}/api${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path}: ${res.status} ${json.error ?? ""}`);
  return json;
};

const retry = async (what, fn) => {
  try {
    return await fn();
  } catch (e) {
    // The local runtime occasionally restarts under heavy load; data is persisted, so wait and try again.
    log(`${what} failed (${e.message}); retrying…`);
    await new Promise((r) => setTimeout(r, 5000));
    return fn();
  }
};

try {
  for (let i = 0; ; i++) {
    try {
      await call("/me");
      break;
    } catch {
      if (i > 180) throw new Error("the Workers didn't start; see the output above");
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  const { sites } = await call("/admin/demo/sites", {});
  for (const s of sites) {
    const t = Date.now();
    const r = await retry(s.domain, () => call(`/admin/demo/seed/${s.id}`, {}));
    log(r.skipped ? `${s.domain}: already seeded` : `${s.domain}: ${r.sessions.toLocaleString()} visits of history, ${r.todayEvents.toLocaleString()} events today (${((Date.now() - t) / 1000).toFixed(1)}s)`);
  }
  log("rolling up daily totals…");
  await retry("rollup", () => call("/admin/rollup", {}));
  // Fill the 30-minute realtime window (not fatal if it fails; the regular ticks catch up).
  await retry("live traffic", () => call("/admin/demo/tick", { seconds: 1800 })).catch((e) => log(`live traffic skipped: ${e.message}`));
} catch (e) {
  log(`setup failed: ${e.message}`);
  stop();
  await new Promise(() => {}); // wait for the exit in stop()
}
log(`ready: open ${base}  (Ctrl-C to stop; live traffic is added every 20 seconds)`);
setInterval(() => call("/admin/demo/tick", { seconds: 20 }).catch((e) => log("tick failed:", e.message)), 20_000);
