import { useEffect, useRef, useState } from "react";
import { useIsFetching } from "@tanstack/react-query";
import { PRESETS, todayIn, type Compare, type Range } from "../dates";
import type { Look, Theme } from "../theme";
import { useBusyFor } from "./Bits";
import { Calendar, Cards, Grid, Moon, Sun } from "./Icons";

/** Thin indeterminate bar under the header while any report data is loading (not background refreshes). */
function Progress() {
  const n = useIsFetching({ predicate: (q) => q.queryKey[0] === "stats" || (q.queryKey[0] === "overview" && q.state.data === undefined) });
  const on = useBusyFor(n > 0) !== null;
  return on ? <div className="progress" role="progressbar" aria-label="Loading data" /> : null;
}

interface Props {
  crumb?: React.ReactNode;
  range: Range;
  from: string;
  to: string;
  compare: Compare;
  onRange: (r: { range: Exclude<Range, "custom"> } | { range: "custom"; from: string; to: string }) => void;
  onCompare: (c: Compare) => void;
  theme: Theme;
  onTheme: (t: Theme) => void;
  look: Look;
  onLook: (l: Look) => void;
  page: "overview" | "site" | "admin";
  isAdmin: boolean;
  email: string;
  onHome: (e: React.MouseEvent) => void;
  onAdmin: (e: React.MouseEvent) => void;
  sections?: { id: string; label: string }[];
}

function CustomRange({ range, from, to, onRange }: Pick<Props, "range" | "from" | "to" | "onRange">) {
  const [open, setOpen] = useState(false);
  const [a, setA] = useState(from);
  const [b, setB] = useState(to);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    setA(from);
    setB(to);
    const close = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open, from, to]);
  const today = todayIn();
  return (
    <div className="popover-wrap" ref={ref}>
      <button className={range === "custom" ? "btn btn-primary btn-icon" : "btn btn-secondary btn-icon"} onClick={() => setOpen(!open)} title="Custom date range" aria-label="Custom date range" aria-expanded={open}>
        <Calendar />
      </button>
      {open && (
        <form className="popover" onSubmit={(e) => { e.preventDefault(); if (a && b) { onRange({ range: "custom", from: a <= b ? a : b, to: a <= b ? b : a }); setOpen(false); } }}>
          <span className="label">Custom range</span>
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <input className="input" type="date" value={a} max={today} onChange={(e) => setA(e.target.value)} aria-label="From" />
            <span className="muted">–</span>
            <input className="input" type="date" value={b} max={today} onChange={(e) => setB(e.target.value)} aria-label="To" />
          </div>
          <button className="btn btn-primary" type="submit">Apply</button>
        </form>
      )}
    </div>
  );
}

export function Header(p: Props) {
  const go = (id: string) => {
    const el = document.getElementById(id);
    if (el) window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - 120, behavior: "smooth" });
  };
  return (
    <div className="topwrap">
      <nav className="nav">
        <div className="brand">
          <span className="sq" aria-hidden />
          <a className="name" href="/" onClick={p.onHome}>Quick Web Analytics</a>
          {p.crumb && (
            <>
              <span className="muted" style={{ fontSize: 14 }}>/</span>
              <div className="crumb">{p.crumb}</div>
            </>
          )}
        </div>
        <div className="nav-right">
          {p.page !== "admin" && (
            <>
              <div className="seg" role="group" aria-label="Date range">
                {PRESETS.map((o) => (
                  <button key={o.id} className={p.range === o.id ? "on" : ""} onClick={() => p.onRange({ range: o.id })} title={o.long}>{o.label}</button>
                ))}
              </div>
              <CustomRange range={p.range} from={p.from} to={p.to} onRange={p.onRange} />
              <div className="seg" role="group" aria-label="Compare with">
                <button className={p.compare === "prev" ? "on" : ""} onClick={() => p.onCompare("prev")}>vs Previous</button>
                <button className={p.compare === "year" ? "on" : ""} onClick={() => p.onCompare("year")}>vs Last year</button>
              </div>
            </>
          )}
          <button className="btn btn-secondary btn-icon" onClick={() => p.onTheme(p.theme === "dark" ? "light" : "dark")} title="Toggle light/dark" aria-label="Toggle light/dark">
            {p.theme === "dark" ? <Sun /> : <Moon />}
          </button>
          <button className="btn btn-secondary btn-icon" onClick={() => p.onLook(p.look === "cards" ? "grid" : "cards")} title={p.look === "cards" ? "Switch to flat grid layout" : "Switch to card layout"} aria-label="Toggle card / grid layout">
            {p.look === "cards" ? <Grid /> : <Cards />}
          </button>
          {p.isAdmin && <a href="/admin" className={p.page === "admin" ? "navtext on" : "navtext"} onClick={p.onAdmin}>Admin</a>}
          <a className="navtext" href="/cdn-cgi/access/logout" title={p.email}>Sign out</a>
        </div>
      </nav>
      {p.sections && (
        <div className="secnav">
          {p.sections.map((s) => <button key={s.id} onClick={() => go(s.id)}>{s.label}</button>)}
        </div>
      )}
      <Progress />
    </div>
  );
}
