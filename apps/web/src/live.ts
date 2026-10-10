// Live updates for a site's page: the site's Durable Object pushes realtime snapshots over a WebSocket as events
// arrive, and reports that include today refresh themselves when the data version moves on. No refresh button needed.
import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { staleLiveQueries, type Realtime, type SiteRef } from "./api";

/** "open": pushed live. "connecting": first attempt in progress. "down": can't connect, so the page polls instead. */
export type LiveState = "connecting" | "open" | "down";

/** Ask for a fresh snapshot when nothing has arrived for this long, so "visitors now" falls when traffic stops. */
const QUIET_REFRESH_MS = 25_000;
const MAX_BACKOFF_MS = 30_000;
const CHECK_MS = 2_000;

export function useLiveUpdates(site: SiteRef): LiveState {
  const qc = useQueryClient();
  const [state, setState] = useState<LiveState>("connecting");

  // The connection: open while the tab is visible, closed while it's hidden (the server side then sleeps).
  useEffect(() => {
    let ws: WebSocket | null = null;
    let stopped = false;
    let failures = 0;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let lastMessage = 0;
    setState("connecting");

    const connect = () => {
      clearTimeout(retry);
      if (stopped || ws || document.hidden) return;
      let opened = false;
      try {
        ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/sites/${site.id}/live`);
      } catch {
        setState("down");
        return;
      }
      ws.onopen = () => {
        opened = true;
        failures = 0;
        setState("open");
      };
      ws.onmessage = (e) => {
        lastMessage = Date.now();
        try {
          const { type, ...snap } = JSON.parse(String(e.data)) as Realtime & { type?: string };
          if (type === "live") qc.setQueryData(["realtime", site.id], snap);
        } catch {
          // ignore a malformed message
        }
      };
      ws.onerror = () => ws?.close();
      ws.onclose = () => {
        ws = null;
        if (stopped) return;
        // Closed because the tab was hidden: reconnect (not poll) when it's back.
        if (document.hidden) {
          setState("connecting");
          return;
        }
        // Poll meanwhile; reconnect with backoff (quickly after a working connection drops, e.g. a deploy).
        if (!opened) failures++;
        setState("down");
        retry = setTimeout(connect, Math.min(MAX_BACKOFF_MS, 1000 * 2 ** failures));
      };
    };

    const quiet = setInterval(() => {
      if (ws?.readyState === WebSocket.OPEN && Date.now() - lastMessage > QUIET_REFRESH_MS) {
        lastMessage = Date.now();
        ws.send("refresh");
      }
    }, 5_000);
    const onVisibility = () => {
      if (document.hidden) ws?.close();
      else connect();
    };
    document.addEventListener("visibilitychange", onVisibility);
    connect();
    return () => {
      stopped = true;
      clearTimeout(retry);
      clearInterval(quiet);
      document.removeEventListener("visibilitychange", onVisibility);
      ws?.close();
    };
  }, [site.id, qc]);

  // Refresh on-screen reports that include today once the data version has moved past what they show.
  useEffect(() => {
    let baseline: string | undefined;
    const check = () => {
      if (document.hidden) return;
      const version = qc.getQueryData<Realtime>(["realtime", site.id])?.version;
      baseline ??= version;
      const active = qc.getQueryCache().findAll({ queryKey: ["stats", site.id], type: "active" });
      for (const q of staleLiveQueries(active, site.timezone, version, baseline)) {
        void qc.refetchQueries({ queryKey: q.queryKey, exact: true, type: "active" });
      }
    };
    const t = setInterval(check, CHECK_MS);
    document.addEventListener("visibilitychange", check);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", check);
    };
  }, [site.id, site.timezone, qc]);

  return state;
}
