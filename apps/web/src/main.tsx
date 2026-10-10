import { lazy, StrictMode, Suspense, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApiError, useMe } from "./api";
import { Spinner } from "./components/Bits";
import { Header } from "./components/Header";
import { SiteSwitcher } from "./components/SiteSwitcher";
import { compareLabel, comparisonRange, periodLabel, presetRange, todayIn } from "./dates";
import { Overview } from "./pages/Overview";
import { SECTIONS } from "./pages/sections";
import { useAppearance } from "./theme";
import { globalParams, linkHandler, readGlobal, readSiteState, useLocation, withParams } from "./url";
import "./styles.css";

// Pages other than the overview load their code when first opened.
const Site = lazy(() => import("./pages/Site").then((m) => ({ default: m.Site })));
const Admin = lazy(() => import("./pages/Admin").then((m) => ({ default: m.Admin })));
const Account = lazy(() => import("./pages/Account").then((m) => ({ default: m.Account })));
const OAuthConsent = lazy(() => import("./pages/OAuthConsent").then((m) => ({ default: m.OAuthConsent })));

const loading = <div className="busy-block" style={{ minHeight: "60vh" }}><Spinner size={16} />Loading…</div>;

/** Re-render when the date changes in `tz`, so "today" and "last 30 days" move on at midnight in an open tab. */
function useToday(tz?: string): string {
  const [today, setToday] = useState(() => todayIn(tz));
  useEffect(() => {
    const check = () => setToday(todayIn(tz));
    check();
    const t = setInterval(check, 30_000);
    document.addEventListener("visibilitychange", check);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", check);
    };
  }, [tz]);
  return today;
}

const queryClient = new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 1 } } });

function App() {
  const { url, navigate } = useLocation();
  const appearance = useAppearance();
  const me = useMe();

  const siteState = readSiteState(url);
  const site = siteState ? me.data?.sites.find((s) => s.id === siteState.siteId) : undefined;
  useToday(site?.timezone);

  if (me.isLoading) return loading;
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
  // The OAuth consent page stands alone: no dashboard header or date controls.
  if (url.pathname === "/oauth/authorize") return <main><Suspense fallback={loading}><OAuthConsent me={data} /></Suspense></main>;
  const isAdmin = data.user.role === "admin";
  const page = url.pathname.startsWith("/admin") && isAdmin ? "admin" : url.pathname.startsWith("/account") ? "account" : siteState ? "site" : "overview";

  const g = readGlobal(url);
  const { from, to } = g.range === "custom" ? { from: g.from!, to: g.to! } : presetRange(g.range, site?.timezone);
  const cmp = comparisonRange(from, to, g.compare);
  const periodText = periodLabel(g.range, from, to);
  const cmpText = compareLabel(g.range, g.compare, from, to);
  const home = `/${globalParams(url)}`;

  return (
    <>
      <Header
        crumb={page === "site" && site ? <SiteSwitcher variant="crumb" sites={data.sites} currentId={site.id} url={url} navigate={navigate} dates={{ from, to, cfrom: cmp.from, cto: cmp.to }} /> : page === "admin" ? "Admin" : page === "account" ? "Account" : undefined}
        range={g.range}
        from={from}
        to={to}
        compare={g.compare}
        onRange={(r) => navigate(withParams(url, r.range === "custom" ? { range: null, from: r.from, to: r.to, g: null } : { range: r.range === "30d" ? null : r.range, from: null, to: null, g: null }), { replace: true, keepScroll: true })}
        onCompare={(c) => navigate(withParams(url, { cmp: c === "prev" ? null : c }), { replace: true, keepScroll: true })}
        theme={appearance.theme}
        onTheme={appearance.setTheme}
        look={appearance.look}
        onLook={appearance.setLook}
        page={page}
        isAdmin={isAdmin}
        email={data.user.email}
        onHome={linkHandler(navigate, home)}
        onAdmin={linkHandler(navigate, "/admin")}
        onAccount={linkHandler(navigate, "/account")}
        sections={page === "site" && site ? SECTIONS : undefined}
      />
      <main>
        <Suspense fallback={loading}>
        {page === "account" ? (
          <Account me={data} />
        ) : page === "admin" ? (
          <Admin me={data} palette={appearance.palette} onPalette={appearance.setPalette} />
        ) : page === "site" ? (
          <Site me={data} url={url} navigate={navigate} dates={{ from, to }} compare={g.compare} periodText={periodText} cmpText={cmpText} />
        ) : (
          <Overview me={data} url={url} navigate={navigate} dates={{ from, to, cfrom: cmp.from, cto: cmp.to }} periodText={periodText} cmpText={cmpText} />
        )}
        </Suspense>
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
