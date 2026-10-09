import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, useAlerts, type Me } from "../api";

interface SiteRow {
  id: number;
  domain: string;
  timezone: string;
  allowed_hostnames: string[];
  ip_blocklist: string[];
  daily_cap: number | null;
}
interface UserRow {
  id: number;
  email: string;
  name: string | null;
  role: "admin" | "viewer";
  last_seen_at: string | null;
  site_ids: number[];
}

const lines = (s: string) => s.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);

export function Admin({ me }: { me: Me }) {
  const [tab, setTab] = useState<"users" | "sites" | "alerts">("users");
  const heads = {
    users: ["Users & access", "Who can sign in, and which sites they can see"],
    sites: ["Sites", "Add sites, install the tracker and change settings"],
    alerts: ["Alerts", "Unusual days (spikes, drops and possible outages), and the emails about them"],
  } as const;
  return (
    <div className="admin">
      <header className="pagehead">
        <div className="titles">
          <div className="kicker">Administration</div>
          <h1 style={{ margin: 0 }}>{heads[tab][0]}</h1>
          <div className="sub">{heads[tab][1]}</div>
        </div>
      </header>
      <div className="seg" style={{ marginBottom: "var(--space-6)" }}>
        <button className={tab === "users" ? "on" : ""} onClick={() => setTab("users")}>Users & access</button>
        <button className={tab === "sites" ? "on" : ""} onClick={() => setTab("sites")}>Sites</button>
        <button className={tab === "alerts" ? "on" : ""} onClick={() => setTab("alerts")}>Alerts</button>
      </div>
      {tab === "users" ? <Users me={me} /> : tab === "sites" ? <Sites /> : <Alerts me={me} />}
    </div>
  );
}

/** The signed-in user's alert emails: every site, or a checklist. Saves as you click. */
function AlertSettings({ me }: { me: Me }) {
  const alerts = useAlerts();
  const qc = useQueryClient();
  const save = useMutation({
    mutationFn: (body: { all?: boolean; sites?: number[] }) => api("/alerts", { method: "PUT", body: JSON.stringify(body) }),
    onMutate: async (body) => {
      // Optimistic: tick boxes immediately.
      await qc.cancelQueries({ queryKey: ["alerts"] });
      const prev = qc.getQueryData<{ email: boolean; all: boolean; sites: number[] }>(["alerts"]);
      if (prev) qc.setQueryData(["alerts"], { ...prev, ...(body.all !== undefined ? { all: body.all } : {}), ...(body.sites ? { sites: body.sites } : {}) });
      return { prev };
    },
    onError: (_e, _b, ctx) => ctx?.prev && qc.setQueryData(["alerts"], ctx.prev),
    onSettled: () => qc.invalidateQueries({ queryKey: ["alerts"] }),
  });
  if (!alerts.data) return null;
  const { all, sites } = alerts.data;
  const chosen = new Set(sites);
  const sorted = [...me.sites].sort((a, b) => a.domain.localeCompare(b.domain));
  const setSites = (ids: number[]) => save.mutate({ sites: ids });
  return (
    <section className="cell">
      <header className="panel-head"><h3>Your alert emails</h3><span className="hint">{all ? "Every site" : `${chosen.size} of ${sorted.length} sites`}</span></header>
      <label className="alert-all">
        <input type="checkbox" checked={all} onChange={(e) => save.mutate({ all: e.target.checked })} />
        <span><b>Every site</b>, including sites added later</span>
      </label>
      <div className={all ? "alert-sites disabled" : "alert-sites"}>
        <div className="alert-sites-head">
          <span className="hint">Or choose sites:</span>
          <button className="link" disabled={all} onClick={() => setSites(sorted.map((s) => s.id))}>Select all</button>
          <button className="link" disabled={all} onClick={() => setSites([])}>None</button>
        </div>
        <div className="alert-grid">
          {sorted.map((s) => (
            <label key={s.id} title={all ? "Covered by “Every site”" : undefined}>
              <input
                type="checkbox"
                disabled={all}
                checked={all || chosen.has(s.id)}
                onChange={(e) => setSites(e.target.checked ? [...chosen, s.id] : [...chosen].filter((id) => id !== s.id))}
              />
              <span>{s.domain}</span>
            </label>
          ))}
        </div>
      </div>
      {save.isError && <p className="error">{(save.error as Error).message}</p>}
      <p className="hint" style={{ marginTop: 10 }}>Emails go to {me.user.email}. The Alerts bell on each site's page changes the same setting.</p>
    </section>
  );
}

function Alerts({ me }: { me: Me }) {
  const alerts = useAlerts();
  const test = useMutation({ mutationFn: () => api<{ to: string; about: string }>("/alerts/test", { method: "POST", body: "{}" }) });
  const check = useMutation({ mutationFn: () => api<{ results: { domain: string; anomalies: number; today: string | null }[] }>("/admin/anomalies", { method: "POST", body: "{}" }) });
  return (
    <>
      <section className="cell">
        <header className="panel-head"><h3>How it works</h3></header>
        <p>
          Every night, after the daily totals are updated, each site's visitors are compared with the same weekday over the
          previous six weeks. Every hour, the day so far is compared with the same time on those weekdays too, including a
          check for a tracker that has gone quiet, so alerts can arrive within the hour. A day is flagged when it's far outside the usual range (a <b>spike</b>, a <b>drop</b>, or a
          <b> possible outage</b> when a normally busy site gets almost no visits). Flagged days get an alarm icon on the
          site's chart and on its card. A run of unusual days counts once.
        </p>
        <p className="hint">Anyone who can see a site can turn on emails for it with the <b>Alerts</b> bell on the site's page.</p>
      </section>
      <AlertSettings me={me} />
      <section className="cell">
        <header className="panel-head"><h3>Email</h3></header>
        {alerts.data && (alerts.data.email ? (
          <p>Email is set up. Alerts go to each subscriber's sign-in address ({me.user.email} for you).</p>
        ) : (
          <div className="callout">
            Email isn't set up yet, so alerts only appear on the dashboard. To send emails, onboard a domain in Cloudflare
            <b> Email Service → Email Sending</b>, then add the <code>send_email</code> binding and <code>ALERT_FROM</code> to the Worker (see docs/DEPLOY.md).
          </div>
        ))}
        <div className="install"><div className="row">
          <button onClick={() => test.mutate()} disabled={test.isPending || !alerts.data?.email}>{test.isPending ? "Sending…" : "Send me a test email"}</button>
          {test.isSuccess && <span>Sent to {test.data.to}, about {test.data.about}.</span>}
          {test.isError && <span className="error">{(test.error as Error).message}</span>}
        </div></div>
      </section>
      <section className="cell">
        <header className="panel-head"><h3>Check now</h3></header>
        <p className="hint">Re-runs both checks for every site: whole days (normally nightly at about 03:30 UTC) and the day so far (normally every hour at 10 past). This doesn't send emails.</p>
        <div className="install"><div className="row">
          <button onClick={() => check.mutate()} disabled={check.isPending}>{check.isPending ? "Checking…" : "Check all sites"}</button>
          {check.isError && <span className="error">{(check.error as Error).message}</span>}
        </div></div>
        {check.data && (
          <table className="users" style={{ marginTop: 12 }}>
            <thead><tr><th>Site</th><th>Unusual days on record</th><th>Today so far</th></tr></thead>
            <tbody>{check.data.results.map((r) => <tr key={r.domain}><td>{r.domain}</td><td>{r.anomalies}</td><td>{r.today ? { spike: "Spike", drop: "Drop", outage: "Possible outage" }[r.today] ?? r.today : "Normal"}</td></tr>)}</tbody>
          </table>
        )}
      </section>
    </>
  );
}

function Users({ me }: { me: Me }) {
  const qc = useQueryClient();
  const users = useQuery({ queryKey: ["admin-users"], queryFn: () => api<{ users: UserRow[] }>("/admin/users") });
  const sites = useQuery({ queryKey: ["admin-sites"], queryFn: () => api<{ sites: SiteRow[] }>("/admin/sites") });
  const refresh = () => qc.invalidateQueries({ queryKey: ["admin-users"] });
  const update = useMutation({
    mutationFn: ({ id, body }: { id: number; body: object }) => api(`/admin/users/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
    onSuccess: refresh,
  });
  const remove = useMutation({ mutationFn: (id: number) => api(`/admin/users/${id}`, { method: "DELETE", body: "{}" }), onSuccess: refresh });
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"viewer" | "admin">("viewer");
  const [grant, setGrant] = useState<number[]>([]);
  const create = useMutation({
    mutationFn: () => api("/admin/users", { method: "POST", body: JSON.stringify({ email, role, site_ids: grant }) }),
    onSuccess: () => {
      setEmail("");
      setGrant([]);
      refresh();
    },
  });

  const allSites = sites.data?.sites ?? [];
  const toggle = (list: number[], id: number) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);

  return (
    <>
      <section className="cell">
        <header className="panel-head"><h3>Add a user</h3></header>
        <form className="form" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
          <input type="email" required placeholder="name@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
          <select value={role} onChange={(e) => setRole(e.target.value as "viewer" | "admin")}>
            <option value="viewer">Viewer (only the sites ticked)</option>
            <option value="admin">Admin (everything)</option>
          </select>
          {role === "viewer" && (
            <div className="checks">
              {allSites.map((s) => (
                <label key={s.id}><input type="checkbox" checked={grant.includes(s.id)} onChange={() => setGrant(toggle(grant, s.id))} /> {s.domain}</label>
              ))}
            </div>
          )}
          <button type="submit" disabled={create.isPending}>Add user</button>
          {create.isError && <span className="error">{(create.error as Error).message}</span>}
        </form>
        <p className="hint">The person signs in at this address with their email (one-time code via Cloudflare Access). They only see the sites you tick.</p>
      </section>

      <section className="cell">
        <header className="panel-head"><h3>Users</h3></header>
        <table className="users">
          <thead><tr><th>Email</th><th>Role</th><th>Sites</th><th>Last seen</th><th /></tr></thead>
          <tbody>
            {(users.data?.users ?? []).map((u) => (
              <tr key={u.id}>
                <td>{u.email}</td>
                <td>
                  <select value={u.role} disabled={u.id === me.user.id} onChange={(e) => update.mutate({ id: u.id, body: { role: e.target.value } })}>
                    <option value="viewer">viewer</option>
                    <option value="admin">admin</option>
                  </select>
                </td>
                <td>
                  {u.role === "admin" ? <span className="hint">all sites</span> : (
                    <div className="checks compact">
                      {allSites.map((s) => (
                        <label key={s.id}>
                          <input type="checkbox" checked={u.site_ids.includes(s.id)} onChange={() => update.mutate({ id: u.id, body: { site_ids: toggle(u.site_ids, s.id) } })} />
                          {s.domain}
                        </label>
                      ))}
                    </div>
                  )}
                </td>
                <td className="hint">{u.last_seen_at ?? "never"}</td>
                <td>{u.id !== me.user.id && <button className="link danger" onClick={() => confirm(`Remove ${u.email}?`) && remove.mutate(u.id)}>Remove</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </>
  );
}

interface SiteStatus {
  lastEventAt: number | null;
  plausible14d: number;
  qwa14d: number;
}

function ago(ts: number): string {
  const s = Math.max(0, Math.round(Date.now() / 1000 - ts));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86_400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86_400)}d ago`;
}

function Badge({ status }: { status: SiteStatus | null | undefined }) {
  if (status === undefined) return null;
  const live = status?.lastEventAt && Date.now() / 1000 - status.lastEventAt < 1800;
  const via = !status ? "" : status.qwa14d && status.plausible14d ? "QWA + Plausible script" : status.qwa14d ? "QWA tracker" : status.plausible14d ? "Plausible script" : "";
  return (
    <span className="badges">
      <span className={live ? "badge ok" : status?.lastEventAt ? "badge" : "badge warn"}>
        {live ? "● live" : status?.lastEventAt ? `last event ${ago(status.lastEventAt)}` : "no data yet"}
      </span>
      {via && <span className="badge">{via}</span>}
    </span>
  );
}

function Sites() {
  const qc = useQueryClient();
  const sites = useQuery({ queryKey: ["admin-sites"], queryFn: () => api<{ sites: SiteRow[] }>("/admin/sites") });
  const status = useQuery({
    queryKey: ["admin-status"],
    queryFn: () => api<{ status: Record<string, SiteStatus | null> }>("/admin/sites/status"),
    refetchInterval: 15_000,
  });
  const [openId, setOpenId] = useState<number | null>(null);
  const [domain, setDomain] = useState("");
  const [timezone, setTimezone] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone);
  const create = useMutation({
    mutationFn: () => api<{ id: number }>("/admin/sites", { method: "POST", body: JSON.stringify({ domain, timezone }) }),
    onSuccess: ({ id }) => {
      setDomain("");
      setOpenId(id);
      qc.invalidateQueries({ queryKey: ["admin-sites"] });
      qc.invalidateQueries({ queryKey: ["admin-status"] });
      qc.invalidateQueries({ queryKey: ["me"] });
    },
  });
  return (
    <>
      <section className="cell">
        <header className="panel-head"><h3>Add a site</h3></header>
        <form className="form" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
          <input required placeholder="example.com" value={domain} onChange={(e) => setDomain(e.target.value)} aria-label="Domain" />
          <input required placeholder="Europe/London" value={timezone} onChange={(e) => setTimezone(e.target.value)} aria-label="Timezone" />
          <button type="submit" disabled={create.isPending}>Add site</button>
          {create.isError && <span className="error">{(create.error as Error).message}</span>}
        </form>
        <p className="hint">Use the domain without "www." Subdomains are separate sites unless you list them under the site's allowed hostnames. Days in reports follow the timezone.</p>
      </section>
      {(sites.data?.sites ?? []).map((s) => (
        <SiteCard
          key={s.id}
          site={s}
          status={status.data ? status.data.status[String(s.id)] ?? null : undefined}
          open={openId === s.id}
          onToggle={() => setOpenId(openId === s.id ? null : s.id)}
        />
      ))}
    </>
  );
}

function SiteCard({ site, status, open, onToggle }: { site: SiteRow; status: SiteStatus | null | undefined; open: boolean; onToggle: () => void }) {
  const [tab, setTab] = useState<"install" | "settings" | "delete">("install");
  return (
    <section className="cell">
      <header className="panel-head clickable" onClick={onToggle}>
        <h3>{site.domain}</h3>
        <span className="hint"><Badge status={status} /> {open ? "▾" : "▸"}</span>
      </header>
      {open && (
        <>
          <div className="seg" style={{ margin: "10px 0" }}>
            <button className={tab === "install" ? "on" : ""} onClick={() => setTab("install")}>Install</button>
            <button className={tab === "settings" ? "on" : ""} onClick={() => setTab("settings")}>Settings</button>
            <button className={tab === "delete" ? "on" : ""} onClick={() => setTab("delete")}>Delete</button>
          </div>
          {tab === "install" && <Install site={site} status={status} />}
          {tab === "settings" && <SiteSettings site={site} />}
          {tab === "delete" && <DeleteSite site={site} />}
        </>
      )}
    </section>
  );
}

function Install({ site, status }: { site: SiteRow; status: SiteStatus | null | undefined }) {
  const qc = useQueryClient();
  const [hash, setHash] = useState(false);
  const [noOutbound, setNoOutbound] = useState(false);
  const [noDownloads, setNoDownloads] = useState(false);
  const [copied, setCopied] = useState(false);
  const attrs = [`data-site="${site.domain}"`, hash && "data-hash", noOutbound && "data-no-outbound", noDownloads && "data-no-downloads"].filter(Boolean).join(" ");
  const snippet = `<script defer src="${location.origin}/t.js" ${attrs}></script>`;
  const waiting = !status?.lastEventAt;
  // Poll quickly while waiting for the first event.
  useQuery({
    queryKey: ["admin-status-fast", site.id],
    queryFn: async () => {
      await qc.invalidateQueries({ queryKey: ["admin-status"] });
      return null;
    },
    refetchInterval: waiting ? 5000 : false,
    enabled: waiting,
  });
  const check = useMutation({
    mutationFn: () => api<{ status: number; url: string; qwa: boolean; plausible: boolean }>(`/admin/sites/${site.id}/check`),
  });
  const copy = async () => {
    await navigator.clipboard.writeText(snippet);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="install">
      <p>Add this to the <code>&lt;head&gt;</code> of every page on <b>{site.domain}</b>:</p>
      <pre className="snippet"><code>{snippet}</code></pre>
      <div className="row">
        <button onClick={copy}>{copied ? "Copied ✓" : "Copy snippet"}</button>
        <label><input type="checkbox" checked={hash} onChange={(e) => setHash(e.target.checked)} /> Hash-based routing (<code>#/page</code>)</label>
        <label><input type="checkbox" checked={noOutbound} onChange={(e) => setNoOutbound(e.target.checked)} /> Don't track outbound links</label>
        <label><input type="checkbox" checked={noDownloads} onChange={(e) => setNoDownloads(e.target.checked)} /> Don't track file downloads</label>
      </div>

      <div className={waiting ? "status-line warn" : "status-line ok"}>
        {waiting ? (
          <><span className="spinner" /> Waiting for the first event. Load a page on {site.domain} once the snippet is in place.</>
        ) : (
          <>✓ Receiving data. Last event {ago(status!.lastEventAt!)}.</>
        )}
        <button className="link" onClick={() => check.mutate()} disabled={check.isPending}>{check.isPending ? "Checking…" : "Check installation"}</button>
      </div>
      {check.data && (
        <p className="hint">
          Fetched {check.data.url} ({check.data.status}):{" "}
          {check.data.qwa ? "✓ QWA snippet found." : "QWA snippet not found in the page HTML (it may be added by JavaScript; the live status above is the real test)."}
          {check.data.plausible ? " The old Plausible script is still on the page." : ""}
        </p>
      )}
      {check.isError && <p className="error">{(check.error as Error).message}</p>}

      {status && status.plausible14d > 0 && (
        <div className="callout">
          <b>Migrating from Plausible:</b> this site sent {status.plausible14d.toLocaleString()} events through the Plausible script in the last 14 days
          {status.qwa14d ? ` and ${status.qwa14d.toLocaleString()} through the QWA tracker` : ""}. Replace the old Plausible <code>&lt;script&gt;</code> tag with
          the snippet above. Existing <code>plausible(…)</code> calls and <code>plausible-event-*</code> classes keep working, and event names stay the same, so reports continue seamlessly.
        </div>
      )}

      <details>
        <summary>Custom events</summary>
        <pre className="snippet"><code>{`qwa("Signup", { props: { plan: "pro" } });

<!-- or without JavaScript: -->
<button class="qwa-event-name=Signup qwa-event-plan=pro">Sign up</button>

<!-- to call qwa() before the script has loaded, add this once: -->
<script>window.qwa = window.qwa || function () { (qwa.q = qwa.q || []).push(arguments) }</script>`}</code></pre>
        <p className="hint">Exclude your own visits by running <code>localStorage.qwa_ignore = "true"</code> in the browser console on the site.</p>
      </details>
    </div>
  );
}

function DeleteSite({ site }: { site: SiteRow }) {
  const qc = useQueryClient();
  const [confirm, setConfirm] = useState("");
  const del = useMutation({
    mutationFn: () => api(`/admin/sites/${site.id}`, { method: "DELETE", body: JSON.stringify({ confirm }) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin-sites"] });
      qc.invalidateQueries({ queryKey: ["me"] });
    },
  });
  return (
    <div className="site-settings">
      <p className="hint">
        Removes the site, its access grants and its settings. New events for {site.domain} will be ignored. Stored analytics data is not deleted, but a re-added
        site gets a new ID and won't show the old data.
      </p>
      <label>Type <b>{site.domain}</b> to confirm <input value={confirm} onChange={(e) => setConfirm(e.target.value)} /></label>
      <button className="btn danger-button" disabled={confirm !== site.domain || del.isPending} onClick={() => del.mutate()}>Delete site</button>
      {del.isError && <span className="error">{(del.error as Error).message}</span>}
    </div>
  );
}

function SiteSettings({ site }: { site: SiteRow }) {
  const qc = useQueryClient();
  const [hosts, setHosts] = useState(site.allowed_hostnames.join("\n"));
  const [ips, setIps] = useState(site.ip_blocklist.join("\n"));
  const [tz, setTz] = useState(site.timezone);
  const [cap, setCap] = useState(site.daily_cap === null ? "" : String(site.daily_cap));
  const capValue = cap.trim() === "" ? null : Number(cap.replace(/[,\s_]/g, ""));
  const save = useMutation({
    mutationFn: () => api(`/admin/sites/${site.id}`, { method: "PATCH", body: JSON.stringify({ timezone: tz, allowed_hostnames: lines(hosts), ip_blocklist: lines(ips), daily_cap: capValue }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin-sites"] }),
  });
  return (
    <div className="site-settings">
      <label>Timezone <input value={tz} onChange={(e) => setTz(e.target.value)} /></label>
      <label>Allowed hostnames (one per line, <code>*.example.com</code> for subdomains; empty = any)
        <textarea rows={3} value={hosts} onChange={(e) => setHosts(e.target.value)} />
      </label>
      <label>Blocked IPs or CIDR ranges (one per line)
        <textarea rows={3} value={ips} onChange={(e) => setIps(e.target.value)} />
      </label>
      <label>Daily event limit (empty = default of 3,000,000; 0 = no limit). Past it, the site stops recording until midnight UTC. A brake on costs.
        <input inputMode="numeric" placeholder="3,000,000" value={cap} onChange={(e) => setCap(e.target.value)} />
      </label>
      <button onClick={() => save.mutate()} disabled={save.isPending || (capValue !== null && !(Number.isInteger(capValue) && capValue >= 0))}>Save</button>
      {save.isSuccess && <span className="hint"> Saved</span>}
      {save.isError && <span className="error">{(save.error as Error).message}</span>}
    </div>
  );
}
