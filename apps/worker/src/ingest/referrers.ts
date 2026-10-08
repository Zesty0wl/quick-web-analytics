// Referrer → source name and channel. Our own compact table; extend as needed.

type Category = "search" | "social" | "video" | "ai" | "email";

interface Known {
  name: string;
  category: Category;
}

// Matched against the referrer host and each parent domain (e.g. "m.facebook.com" → "facebook.com").
// Keys starting with "*" match any label at that position (e.g. "google.*" for ccTLDs).
const KNOWN: Record<string, Known> = {
  "google.*": { name: "Google", category: "search" },
  "bing.com": { name: "Bing", category: "search" },
  "duckduckgo.com": { name: "DuckDuckGo", category: "search" },
  "yahoo.com": { name: "Yahoo", category: "search" },
  "search.yahoo.com": { name: "Yahoo", category: "search" },
  "yandex.*": { name: "Yandex", category: "search" },
  "baidu.com": { name: "Baidu", category: "search" },
  "ecosia.org": { name: "Ecosia", category: "search" },
  "search.brave.com": { name: "Brave Search", category: "search" },
  "startpage.com": { name: "Startpage", category: "search" },
  "qwant.com": { name: "Qwant", category: "search" },
  "kagi.com": { name: "Kagi", category: "search" },
  "naver.com": { name: "Naver", category: "search" },
  "seznam.cz": { name: "Seznam", category: "search" },
  "facebook.com": { name: "Facebook", category: "social" },
  "fb.me": { name: "Facebook", category: "social" },
  "instagram.com": { name: "Instagram", category: "social" },
  "t.co": { name: "X", category: "social" },
  "twitter.com": { name: "X", category: "social" },
  "x.com": { name: "X", category: "social" },
  "linkedin.com": { name: "LinkedIn", category: "social" },
  "lnkd.in": { name: "LinkedIn", category: "social" },
  "reddit.com": { name: "Reddit", category: "social" },
  "news.ycombinator.com": { name: "Hacker News", category: "social" },
  "pinterest.*": { name: "Pinterest", category: "social" },
  "threads.net": { name: "Threads", category: "social" },
  "threads.com": { name: "Threads", category: "social" },
  "bsky.app": { name: "Bluesky", category: "social" },
  "mastodon.social": { name: "Mastodon", category: "social" },
  "tiktok.com": { name: "TikTok", category: "social" },
  "discord.com": { name: "Discord", category: "social" },
  "web.whatsapp.com": { name: "WhatsApp", category: "social" },
  "t.me": { name: "Telegram", category: "social" },
  "web.telegram.org": { name: "Telegram", category: "social" },
  "youtube.com": { name: "YouTube", category: "video" },
  "youtu.be": { name: "YouTube", category: "video" },
  "vimeo.com": { name: "Vimeo", category: "video" },
  "twitch.tv": { name: "Twitch", category: "video" },
  "chatgpt.com": { name: "ChatGPT", category: "ai" },
  "chat.openai.com": { name: "ChatGPT", category: "ai" },
  "perplexity.ai": { name: "Perplexity", category: "ai" },
  "claude.ai": { name: "Claude", category: "ai" },
  "gemini.google.com": { name: "Gemini", category: "ai" },
  "copilot.microsoft.com": { name: "Copilot", category: "ai" },
  "chat.deepseek.com": { name: "DeepSeek", category: "ai" },
  "mail.google.com": { name: "Gmail", category: "email" },
  "outlook.live.com": { name: "Outlook", category: "email" },
  "outlook.office.com": { name: "Outlook", category: "email" },
  "mail.yahoo.com": { name: "Yahoo Mail", category: "email" },
};

const UTM_SOURCE_ALIASES: Record<string, string> = {
  google: "Google", bing: "Bing", facebook: "Facebook", fb: "Facebook", ig: "Instagram", instagram: "Instagram",
  twitter: "X", x: "X", linkedin: "LinkedIn", reddit: "Reddit", youtube: "YouTube", tiktok: "TikTok",
  newsletter: "Newsletter", chatgpt: "ChatGPT", "chatgpt.com": "ChatGPT", perplexity: "Perplexity",
  bluesky: "Bluesky", mastodon: "Mastodon", hn: "Hacker News", hackernews: "Hacker News",
};

export function lookupHost(host: string): Known | null {
  const h = host.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
  const labels = h.split(".");
  for (let i = 0; i < labels.length - 1; i++) {
    const candidate = labels.slice(i).join(".");
    if (KNOWN[candidate]) return KNOWN[candidate];
    // wildcard TLD, e.g. "google.*" matches google.co.uk / google.de
    for (let j = i + 1; j < labels.length; j++) {
      const wild = labels.slice(i, j).join(".") + ".*";
      if (KNOWN[wild]) return KNOWN[wild];
    }
  }
  return null;
}

const PAID_MEDIUMS = /^(cpc|ppc|paid|paidsearch|paid_search|paid-search|cpm|cpv|display|banner|retargeting|paidsocial|paid_social|paid-social)$/i;

export interface SourceInfo {
  referrer: string; // referrer host + path, "" for none
  source: string;
  channel: string;
}

export function classify(opts: {
  referrer: string | null;
  pageHost: string;
  utm: { source: string; medium: string };
  clickId: string | null;
}): SourceInfo {
  let refHost = "";
  let referrer = "";
  if (opts.referrer) {
    try {
      const r = new URL(opts.referrer);
      refHost = r.hostname.toLowerCase().replace(/^www\./, "");
      referrer = (refHost + (r.pathname === "/" ? "" : r.pathname)).slice(0, 300);
    } catch {
      // ignore malformed referrers
    }
  }
  // Internal navigation is not a referral.
  const pageHost = opts.pageHost.toLowerCase().replace(/^www\./, "");
  if (refHost && (refHost === pageHost || refHost.endsWith("." + pageHost) || pageHost.endsWith("." + refHost))) {
    refHost = "";
    referrer = "";
  }

  const known = refHost ? lookupHost(refHost) : null;
  const utmSource = opts.utm.source.trim();
  const source = utmSource
    ? UTM_SOURCE_ALIASES[utmSource.toLowerCase()] ?? lookupHost(utmSource)?.name ?? utmSource
    : known?.name ?? (refHost || "Direct");

  const medium = opts.utm.medium.toLowerCase();
  const category = known?.category ?? (utmSource ? lookupHost(utmSource)?.category ?? categoryForAlias(utmSource) : undefined);
  let channel: string;
  if (PAID_MEDIUMS.test(medium) || opts.clickId) {
    channel = category === "social" ? "Paid Social" : category === "video" ? "Paid Video" : "Paid Search";
  } else if (medium === "email" || medium === "newsletter" || category === "email") {
    channel = "Email";
  } else if (category === "search") {
    channel = "Organic Search";
  } else if (category === "social") {
    channel = "Organic Social";
  } else if (category === "video") {
    channel = "Organic Video";
  } else if (category === "ai") {
    channel = "AI Assistants";
  } else if (refHost || utmSource) {
    channel = "Referral";
  } else {
    channel = "Direct";
  }
  return { referrer, source, channel };
}

function categoryForAlias(utmSource: string): Category | undefined {
  const name = UTM_SOURCE_ALIASES[utmSource.toLowerCase()];
  if (!name) return undefined;
  for (const k of Object.values(KNOWN)) if (k.name === name) return k.category;
  return name === "Newsletter" ? "email" : undefined;
}
