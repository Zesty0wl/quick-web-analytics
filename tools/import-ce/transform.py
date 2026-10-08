"""Transform a Plausible CE export (export.sh) into QWA's Parquet layout.

Usage: python -I transform.py <export-dir> <out-dir>
Writes <out-dir>/sites/<site_id>/<table>/import/<YYYY-MM>.parquet. Site ids are kept from CE
(QWA's D1 `sites` table is seeded with the same ids).
"""
import os
import sys

import duckdb

src, out = sys.argv[1], sys.argv[2]
con = duckdb.connect()
con.execute(f"CREATE VIEW s AS SELECT * FROM read_parquet('{src}/sessions.parquet')")
con.execute(f"CREATE VIEW e AS SELECT * FROM read_parquet('{src}/events.parquet')")

# CE leaves `channel` empty (it derives channels at query time), and names some sources differently
# from QWA. Rename sources to QWA's names and derive channels with the same categories as live ingestion.
RENAME = {
    "": "Direct", "twitter": "X", "youtube": "YouTube", "yahoo!": "Yahoo", "brave": "Brave Search",
    "chatgpt.com": "ChatGPT", "openai": "ChatGPT", "copilot.com": "Copilot", "copilot.microsoft.com": "Copilot",
    "go.bsky.app": "Bluesky", "l.threads.com": "Threads", "startpage.com": "Startpage", "kagi.com": "Kagi",
    "ig_text_feed_timeline": "Instagram", "perplexity": "Perplexity",
}
CATEGORY = {
    "Organic Search": ["google", "bing", "duckduckgo", "yahoo", "ecosia", "qwant", "yandex", "brave search", "startpage", "kagi", "baidu", "aol", "naver", "seznam"],
    "Organic Social": ["reddit", "facebook", "hacker news", "linkedin", "x", "instagram", "bluesky", "threads", "tiktok", "pinterest", "mastodon", "discord", "telegram", "whatsapp", "wykop.pl", "vk"],
    "Organic Video": ["youtube", "vimeo", "twitch"],
    "AI Assistants": ["chatgpt", "copilot", "perplexity", "claude", "gemini", "deepseek"],
    "Email": ["gmail", "outlook", "yahoo mail", "convertkit", "newsletter"],
}

def q(v):
    return "'" + v.replace("'", "''") + "'"

source_sql = "CASE lower(source) " + " ".join(f"WHEN {q(k)} THEN {q(v)}" for k, v in RENAME.items()) + " ELSE source END"
cat_cases = " ".join(f"WHEN lower({source_sql}) IN ({', '.join(q(x) for x in names)}) THEN {q(ch)}" for ch, names in CATEGORY.items())
channel_sql = (
    "CASE WHEN regexp_matches(lower(utm_medium), '^(cpc|ppc|paid|paidsearch|paid_search|paid-search|cpm|cpv|display|banner|retargeting|paidsocial|paid_social|paid-social)$') THEN 'Paid Search' "
    "WHEN lower(utm_medium) IN ('email', 'newsletter') THEN 'Email' "
    f"{cat_cases} "
    f"WHEN source = '' AND utm_source = '' THEN 'Direct' ELSE 'Referral' END"
)

TABLES = {
    # table: (source, time column, select list, extra where)
    "sessions": ("s", "start", """session, visitor, start, last, hostname, entry_page, exit_page,
        pageviews::INTEGER AS pageviews, events::INTEGER AS events, bounce, duration, referrer,
        {SOURCE} AS source,
        {CHANNEL} AS channel,
        utm_source, utm_medium, utm_campaign, utm_content, utm_term, country, region, '' AS city,
        browser, browser_version, os, os_version, device""", "TRUE"),
    "pageviews": ("e", "ts", "ts, session, visitor, hostname, path, props", "name = 'pageview'"),
    "engagement": ("e", "ts", "ts, session, visitor, path, scroll_depth, engaged_ms", "name = 'engagement'"),
    "custom": ("e", "ts", "ts, session, visitor, name, path, props", "name NOT IN ('pageview', 'engagement')"),
}

TABLES["sessions"] = (TABLES["sessions"][0], TABLES["sessions"][1], TABLES["sessions"][2].replace("{SOURCE}", source_sql).replace("{CHANNEL}", channel_sql), TABLES["sessions"][3])

written = 0
for table, (view, tcol, cols, where) in TABLES.items():
    parts = con.execute(
        f"SELECT DISTINCT site_id, strftime(to_timestamp({tcol}), '%Y-%m') m FROM {view} WHERE {where} ORDER BY 1, 2"
    ).fetchall()
    for site_id, month in parts:
        d = f"{out}/sites/{site_id}/{table}/import"
        os.makedirs(d, exist_ok=True)
        con.execute(
            f"""COPY (SELECT {cols} FROM {view}
                      WHERE site_id = {site_id} AND {where} AND strftime(to_timestamp({tcol}), '%Y-%m') = '{month}'
                      ORDER BY {tcol})
                TO '{d}/{month}.parquet' (FORMAT parquet, COMPRESSION zstd, ROW_GROUP_SIZE 262144)"""
        )
        written += 1
print(f"wrote {written} files")
