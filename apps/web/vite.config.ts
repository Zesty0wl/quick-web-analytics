import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Stamped into the dashboard's footer: the release, the commit it was built from, and when.
const version = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version as string;
const git = (cmd: string) => {
  try {
    return execSync(`git ${cmd}`, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return ""; // not a git checkout (e.g. a downloaded zip)
  }
};
const commit = git("rev-parse --short HEAD");
// Built with uncommitted changes, so the commit alone doesn't describe it.
const modified = commit !== "" && git("status --porcelain --untracked-files=no") !== "";

export default defineConfig({
  plugins: [react()],
  define: {
    __QWA_BUILD__: JSON.stringify({ version, commit, modified, builtAt: new Date().toISOString() }),
  },
  build: { outDir: "dist", emptyOutDir: true, sourcemap: true },
  server: { proxy: { "/api": { target: "http://localhost:8787", ws: true } } },
});
