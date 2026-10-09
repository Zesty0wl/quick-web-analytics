// Your account: personal access tokens for AI agents (the MCP server at /mcp). Every user can create their own;
// a token can read what its user can see, optionally limited to some sites, and nothing can be changed with it.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type Me } from "../api";
import { ago } from "../format";

interface Token {
  id: number;
  name: string;
  hint: string;
  sites: number[] | null;
  created_at: number;
  last_used_at: number | null;
  expires_at: number | null;
}

function Copy({ text, label = "Copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button className="btn btn-secondary" onClick={() => navigator.clipboard.writeText(text).then(() => { setDone(true); setTimeout(() => setDone(false), 1500); })}>
      {done ? "Copied" : label}
    </button>
  );
}

export function Account({ me }: { me: Me }) {
  const qc = useQueryClient();
  const tokens = useQuery({ queryKey: ["tokens"], queryFn: () => api<{ tokens: Token[] }>("/tokens") });
  const [name, setName] = useState("");
  const [limit, setLimit] = useState(false);
  const [sites, setSites] = useState<number[]>([]);
  const [expires, setExpires] = useState<string>("never");
  const create = useMutation({
    mutationFn: () =>
      api<Token & { token: string }>("/tokens", {
        method: "POST",
        body: JSON.stringify({ name, sites: limit ? sites : null, expiresInDays: expires === "never" ? null : Number(expires) }),
      }),
    onSuccess: () => {
      setName("");
      qc.invalidateQueries({ queryKey: ["tokens"] });
    },
  });
  const revoke = useMutation({ mutationFn: (id: number) => api(`/tokens/${id}`, { method: "DELETE", body: "{}" }), onSuccess: () => qc.invalidateQueries({ queryKey: ["tokens"] }) });
  const grants = useQuery({ queryKey: ["oauth-grants"], queryFn: () => api<{ grants: { id: number; client_name: string; redirect_host: string; sites: number[] | null; created_at: number; last_used_at: number | null }[] }>("/oauth/grants") });
  const disconnect = useMutation({ mutationFn: (id: number) => api(`/oauth/grants/${id}`, { method: "DELETE", body: "{}" }), onSuccess: () => qc.invalidateQueries({ queryKey: ["oauth-grants"] }) });
  const endpoint = `${location.origin}/mcp`;
  const siteName = (id: number) => me.sites.find((s) => s.id === id)?.domain ?? `#${id}`;
  const fresh = create.data?.token;

  return (
    <div className="admin">
      <header className="pagehead">
        <div className="titles">
          <div className="kicker">Your account</div>
          <h1 style={{ margin: 0 }}>Agent access</h1>
          <div className="sub">Let AI agents (Claude Code, Claude Desktop, Cursor, Codex…) read your analytics through MCP. Signed in as {me.user.email}.</div>
        </div>
      </header>

      <section className="cell">
        <header className="panel-head"><h3>How it works</h3></header>
        <p>
          QWA runs an <b>MCP server</b> at <code>{endpoint}</code>. An agent connected with one of your tokens can look up your sites' numbers:
          summaries, top pages and sources, trends, realtime, unusual days, Google Search Console and speed (including real-user Core Web Vitals and
          on-demand PageSpeed tests). It sees only the sites you can see, or fewer if you limit the token, and <b>can't change anything</b>.
        </p>
        <p className="hint">Treat a token like a password: anyone who has it can read those sites' analytics. Revoke it here when you no longer need it.</p>
      </section>

      <section className="cell">
        <header className="panel-head"><h3>Connect with a button (Claude Desktop, claude.ai)</h3></header>
        <p>
          Apps that support MCP sign-in only need the address: add a custom connector with <code>{endpoint}</code>, then sign in and approve
          when the app opens this dashboard. No token to copy.
        </p>
        <div className="install"><div className="row"><code>{endpoint}</code><Copy text={endpoint} label="Copy address" /></div></div>
        {grants.data && grants.data.grants.length > 0 && (
          <table className="users" style={{ marginTop: 12 }}>
            <thead><tr><th>Connected app</th><th>Sites</th><th>Connected</th><th>Last used</th><th /></tr></thead>
            <tbody>
              {grants.data.grants.map((g) => (
                <tr key={g.id}>
                  <td>{g.client_name} <span className="muted">({g.redirect_host})</span></td>
                  <td>{g.sites ? g.sites.map(siteName).join(", ") : "All your sites"}</td>
                  <td>{ago(g.created_at)}</td>
                  <td>{g.last_used_at ? ago(g.last_used_at) : <span className="muted">Never</span>}</td>
                  <td><button className="link" onClick={() => disconnect.mutate(g.id)} disabled={disconnect.isPending}>Disconnect</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="cell">
        <header className="panel-head"><h3>Or create a token (Claude Code, Cursor, Codex…)</h3></header>
        <div className="site-settings">
          <label>Name (what it's for, e.g. "Claude Code on my laptop")
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder="Claude Code on my laptop" />
          </label>
          <label className="check"><input type="checkbox" checked={limit} onChange={(e) => setLimit(e.target.checked)} /> Only some sites</label>
          {limit && (
            <div className="token-sites">
              {me.sites.map((s) => (
                <label key={s.id} className="check"><input type="checkbox" checked={sites.includes(s.id)} onChange={(e) => setSites(e.target.checked ? [...sites, s.id] : sites.filter((x) => x !== s.id))} /> {s.domain}</label>
              ))}
            </div>
          )}
          <label>Expires
            <select value={expires} onChange={(e) => setExpires(e.target.value)}>
              <option value="never">Never</option>
              <option value="30">In 30 days</option>
              <option value="90">In 90 days</option>
              <option value="365">In a year</option>
            </select>
          </label>
          <div className="install"><div className="row">
            <button onClick={() => create.mutate()} disabled={!name.trim() || create.isPending || (limit && !sites.length)}>{create.isPending ? "Creating…" : "Create token"}</button>
          </div></div>
          {create.isError && <p className="error">{(create.error as Error).message}</p>}
        </div>

        {fresh && (
          <div className="agent-box" style={{ marginTop: 16 }}>
            <div>
              <b>Your new token</b>
              <p className="hint">Copy it now: it won't be shown again.</p>
            </div>
            <div className="install"><div className="row">
              <code className="token-value">{fresh}</code>
              <Copy text={fresh} label="Copy token" />
            </div></div>
            <p style={{ margin: "8px 0 0" }}><b>Claude Code:</b> run this in a terminal</p>
            <pre className="snippet"><code>{`claude mcp add --transport http qwa ${endpoint} --header "Authorization: Bearer ${fresh}"`}</code></pre>
            <p style={{ margin: "8px 0 0" }}><b>Cursor, Windsurf and other clients</b> (an <code>mcp.json</code> entry):</p>
            <pre className="snippet"><code>{JSON.stringify({ mcpServers: { qwa: { url: endpoint, headers: { Authorization: `Bearer ${fresh}` } } } }, null, 2)}</code></pre>
            <p style={{ margin: "8px 0 0" }}><b>Codex</b> (<code>~/.codex/config.toml</code>):</p>
            <pre className="snippet"><code>{`[mcp_servers.qwa]\nurl = "${endpoint}"\nhttp_headers = { Authorization = "Bearer ${fresh}" }`}</code></pre>
            <p className="hint">Then ask your agent something like “Which of my desktop pages have the worst INP, and what should we fix first?”. There's also a ready-made <b>investigate_inp</b> prompt.</p>
          </div>
        )}
      </section>

      <section className="cell">
        <header className="panel-head"><h3>Your tokens</h3></header>
        {tokens.data && tokens.data.tokens.length === 0 && <p className="hint">No tokens yet.</p>}
        {tokens.data && tokens.data.tokens.length > 0 && (
          <table className="users">
            <thead><tr><th>Name</th><th>Token</th><th>Sites</th><th>Last used</th><th>Expires</th><th /></tr></thead>
            <tbody>
              {tokens.data.tokens.map((t) => (
                <tr key={t.id}>
                  <td>{t.name}</td>
                  <td><code>qwa_pat_…{t.hint}</code></td>
                  <td>{t.sites ? t.sites.map(siteName).join(", ") : "All your sites"}</td>
                  <td>{t.last_used_at ? ago(t.last_used_at) : <span className="muted">Never</span>}</td>
                  <td>{t.expires_at ? new Date(t.expires_at * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "Never"}</td>
                  <td><button className="link" onClick={() => revoke.mutate(t.id)} disabled={revoke.isPending}>Revoke</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {tokens.isError && <p className="error">{(tokens.error as Error).message}</p>}
      </section>
    </div>
  );
}
