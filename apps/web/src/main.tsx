import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApiError, useMe } from "./api";
import { Spinner } from "./components/Bits";
import { Header } from "./components/Header";
import { SiteSwitcher } from "./components/SiteSwitcher";
import { compareLabel, comparisonRange, periodLabel, presetRange } from "./dates";
import { Admin } from "./pages/Admin";
import { Overview } from "./pages/Overview";
import { SECTIONS, Site } from "./pages/Site";
import { useAppearance } from "./theme";
import { globalParams, linkHandler, readGlobal, readSiteState, useLocation, withParams } from "./url";
import "./styles.css";

const queryClient = new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 1 } } });

function App() {
  const { url, navigate } = useLocation();
  const appearance = useAppearance();
  const me = useMe();

  if (me.isLoading) return <div className="busy-block" style={{ minHeight: "60vh" }}><Spinner size={16} />Loading…</div>;
  if (me.isError) {
    const e = me.error as ApiError;
    return (
      <div className="center">
        <div className="kicker">Quick Web Analytics</div>
        <h2>{e.status === 403 ? "No access yet" : "Not signed in"}</h2>
        <p>{e.message}</p>
        {e.status === 403 && <p className="muted">Ask an admin to add your email address, then reload.</p>}
        <a className="btn btn-primary" href="/cdn-cgi/access/logout">Sign out</a>
      </div>
    );
  }
  const data = me.data!;
  const isAdmin = data.user.role === "admin";
  const siteState = readSiteState(url);
  const page = url.pathname.startsWith("/admin") && isAdmin ? "admin" : siteState ? "site" : "overview";
  const site = siteState ? data.sites.find((s) => s.id === siteState.siteId) : undefined;

  const g = readGlobal(url);
  const { from, to } = g.range === "custom" ? { from: g.from!, to: g.to! } : presetRange(g.range, site?.timezone);
  const cmp = comparisonRange(from, to, g.compare);
  const periodText = periodLabel(g.range, from, to);
  const cmpText = compareLabel(g.range, g.compare, from, to);
  const home = `/${globalParams(url)}`;

  return (
    <>
      <Header
        crumb={page === "site" && site ? <SiteSwitcher variant="crumb" sites={data.sites} currentId={site.id} url={url} navigate={navigate} dates={{ from, to, cfrom: cmp.from, cto: cmp.to }} /> : page === "admin" ? "Admin" : undefined}
        range={g.range}
        from={from}
        to={to}
        compare={g.compare}
        onRange={(r) => navigate(withParams(url, r.range === "custom" ? { range: null, from: r.from, to: r.to, g: null } : { range: r.range === "30d" ? null : r.range, from: null, to: null, g: null }), { replace: true, keepScroll: true })}
        onCompare={(c) => navigate(withParams(url, { cmp: c === "prev" ? null : c }), { replace: true, keepScroll: true })}
        theme={appearance.theme}
        palette={appearance.palette}
        onTheme={appearance.setTheme}
        onPalette={appearance.setPalette}
        look={appearance.look}
        onLook={appearance.setLook}
        page={page}
        isAdmin={isAdmin}
        email={data.user.email}
        onHome={linkHandler(navigate, home)}
        onAdmin={linkHandler(navigate, "/admin")}
        sections={page === "site" && site ? SECTIONS : undefined}
      />
      <main>
        {page === "admin" ? (
          <Admin me={data} />
        ) : page === "site" ? (
          <Site me={data} url={url} navigate={navigate} dates={{ from, to }} compare={g.compare} periodText={periodText} cmpText={cmpText} />
        ) : (
          <Overview me={data} url={url} navigate={navigate} dates={{ from, to, cfrom: cmp.from, cto: cmp.to }} periodText={periodText} cmpText={cmpText} />
        )}
      </main>
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
