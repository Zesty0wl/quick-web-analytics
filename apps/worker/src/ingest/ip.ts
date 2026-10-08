// Client IP and blocklist matching (exact IPs and CIDR ranges, IPv4 and IPv6).

export function clientIp(req: Request): string {
  // A site that proxies events through its own Cloudflare Worker forwards the visitor's IP
  // in X-Forwarded-For; Cloudflare marks such subrequests with the CF-Worker header.
  const viaWorker = req.headers.get("cf-worker");
  const xff = req.headers.get("x-forwarded-for");
  if (viaWorker && xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.headers.get("cf-connecting-ip") ?? "0.0.0.0";
}

function parseIp(ip: string): { v: 4 | 6; bits: bigint } | null {
  if (ip.includes(".") && !ip.includes(":")) {
    const parts = ip.split(".").map(Number);
    if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return null;
    return { v: 4, bits: parts.reduce((acc, p) => (acc << 8n) | BigInt(p), 0n) };
  }
  if (ip.includes(":")) {
    const [head, tail = ""] = ip.split("::");
    const h = head ? head.split(":") : [];
    const t = ip.includes("::") ? (tail ? tail.split(":") : []) : [];
    if (!ip.includes("::") && h.length !== 8) return null;
    const groups = [...h, ...Array(8 - h.length - t.length).fill("0"), ...t];
    if (groups.length !== 8) return null;
    let bits = 0n;
    for (const g of groups) {
      const n = parseInt(g || "0", 16);
      if (!Number.isFinite(n) || n < 0 || n > 0xffff) return null;
      bits = (bits << 16n) | BigInt(n);
    }
    return { v: 6, bits };
  }
  return null;
}

export function ipMatches(ip: string, rule: string): boolean {
  const [base, prefixStr] = rule.trim().split("/");
  const a = parseIp(ip);
  const b = parseIp(base);
  if (!a || !b || a.v !== b.v) return false;
  const width = a.v === 4 ? 32 : 128;
  const prefix = prefixStr === undefined ? width : Number(prefixStr);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > width) return false;
  const shift = BigInt(width - prefix);
  return a.bits >> shift === b.bits >> shift;
}

export function ipBlocked(ip: string, blocklist: string[]): boolean {
  return blocklist.some((rule) => ipMatches(ip, rule));
}

export function hostnameAllowed(hostname: string, allowed: string[]): boolean {
  if (allowed.length === 0) return true;
  const h = hostname.toLowerCase();
  return allowed.some((pattern) => {
    const p = pattern.toLowerCase();
    return p.startsWith("*.") ? h === p.slice(2) || h.endsWith(p.slice(1)) : h === p;
  });
}
