// /oauth/authorize: an MCP client (Claude Desktop, a claude.ai connector…) asks to read this person's analytics.
// The person is already signed in (Cloudflare Access protects this page); they approve, optionally for some sites only.
import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { api, type Me } from "../api";

export function OAuthConsent({ me }: { me: Me }) {
  const params = new URLSearchParams(location.search);
  const info = useQuery({
    queryKey: ["oauth-client", location.search],
    queryFn: () => api<{ client_name: string; redirect_host: string; user: string }>(`/oauth/client${location.search}`),
    retry: false,
  });
  const [limit, setLimit] = useState(false);
  const [sites, setSites] = useState<number[]>([]);
  const allow = useMutation({
    mutationFn: () => api<{ redirect: string }>("/oauth/approve", { method: "POST", body: JSON.stringify({ ...Object.fromEntries(params), sites: limit ? sites : null }) }),
    onSuccess: (r) => location.assign(r.redirect),
  });
  const deny = () => {
    // The redirect address was checked against the app's registration before this page offered a choice.
    const url = new URL(params.get("redirect_uri") ?? "");
    url.searchParams.set("error", "access_denied");
    if (params.get("state")) url.searchParams.set("state", params.get("state")!);
    location.assign(url.toString());
  };

  return (
    <div className="center consent">
      <div className="kicker">Quick Web Analytics</div>
      {info.isLoading && <p className="hint">Loading…</p>}
      {info.isError && (
        <>
          <h2>Can't connect this app</h2>
          <p>{(info.error as Error).message}</p>
        </>
      )}
      {info.data && (
        <>
          <h2>Connect {info.data.client_name}?</h2>
          <p>
            <b>{info.data.client_name}</b> <span className="muted">({info.data.redirect_host})</span> wants to read your analytics as <b>{info.data.user}</b>:
            summaries, pages, sources, trends, realtime, unusual days, Search Console and speed data. It <b>can't change anything</b>.
          </p>
          <div className="site-settings">
            <label className="check"><input type="checkbox" checked={limit} onChange={(e) => setLimit(e.target.checked)} /> Only some of my sites</label>
            {limit && (
              <div className="token-sites">
                {me.sites.map((s) => (
                  <label key={s.id} className="check"><input type="checkbox" checked={sites.includes(s.id)} onChange={(e) => setSites(e.target.checked ? [...sites, s.id] : sites.filter((x) => x !== s.id))} /> {s.domain}</label>
                ))}
              </div>
            )}
          </div>
          <div className="install" style={{ marginTop: "var(--space-6)" }}><div className="row">
            <button onClick={() => allow.mutate()} disabled={allow.isPending || (limit && !sites.length)}>{allow.isPending ? "Connecting…" : "Allow"}</button>
            <button className="btn btn-secondary" onClick={deny} disabled={allow.isPending}>Cancel</button>
          </div></div>
          {allow.isError && <p className="error">{(allow.error as Error).message}</p>}
          <p className="hint" style={{ marginTop: "var(--space-6)" }}>You can disconnect it at any time under Account → Agent access.</p>
        </>
      )}
    </div>
  );
}
