// Site name that opens a searchable list of sites, for jumping between sites without going back to the overview.
import { useEffect, useMemo, useRef, useState } from "react";
import { useOverview, type Me } from "../api";
import { compact } from "../format";
import { linkHandler, withParams, type Navigate } from "../url";
import { ChevronDown, Search } from "./Icons";

interface Props {
  sites: Me["sites"];
  currentId: number;
  url: URL;
  navigate: Navigate;
  /** Current range and comparison, so the list can show each site's visitors for the same period. */
  dates: { from: string; to: string; cfrom: string; cto: string };
  variant: "title" | "crumb";
}

/** Keep range, comparison, metric and grain; drop filters (they belong to the previous site). */
const hrefFor = (url: URL, id: number) => withParams(url, { f: null }, `/s/${id}`);

export function SiteSwitcher({ sites, currentId, url, navigate, dates, variant }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const current = sites.find((s) => s.id === currentId);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  return (
    <div className={`switcher switcher-${variant}`} ref={ref}>
      <button className="switcher-btn" onClick={() => setOpen(!open)} aria-haspopup="listbox" aria-expanded={open} title="Switch site">
        <span className="nm">{current?.domain ?? "Choose a site"}</span>
        <ChevronDown size={variant === "title" ? 22 : 14} />
      </button>
      {open && <SiteList sites={sites} currentId={currentId} url={url} navigate={navigate} dates={dates} onClose={() => setOpen(false)} />}
    </div>
  );
}

function SiteList({ sites, currentId, url, navigate, dates, onClose }: Omit<Props, "variant"> & { onClose: () => void }) {
  const [term, setTerm] = useState("");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const overview = useOverview(dates); // already cached when arriving from the overview page
  const stats = useMemo(() => {
    const m = new Map<number, { visitors: number; now: number }>();
    for (const s of overview.data?.sites ?? []) m.set(s.id, { visitors: s.current.reduce((n, d) => n + d.visitors, 0), now: s.now });
    return m;
  }, [overview.data]);

  const shown = useMemo(() => {
    const t = term.trim().toLowerCase();
    return sites
      .filter((s) => !t || s.domain.includes(t))
      .sort((a, b) => (stats.get(b.id)?.visitors ?? -1) - (stats.get(a.id)?.visitors ?? -1) || a.domain.localeCompare(b.domain));
  }, [sites, term, stats]);

  useEffect(() => setActive(0), [term]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-i="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const go = (id: number) => {
    onClose();
    if (id !== currentId) navigate(hrefFor(url, id));
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") onClose();
    else if (e.key === "ArrowDown") { e.preventDefault(); setActive((i) => Math.min(shown.length - 1, i + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((i) => Math.max(0, i - 1)); }
    else if (e.key === "Enter" && shown[active]) { e.preventDefault(); go(shown[active].id); }
  };

  return (
    <div className="switcher-pop" onKeyDown={onKey}>
      <div className="search">
        <Search />
        <input className="input" autoFocus placeholder={`Search ${sites.length} sites`} value={term} onChange={(e) => setTerm(e.target.value)} aria-label="Search sites" />
      </div>
      <div className="switcher-list" role="listbox" ref={listRef} aria-label="Sites">
        {shown.map((s, i) => {
          const st = stats.get(s.id);
          const href = hrefFor(url, s.id);
          return (
            <a
              key={s.id}
              data-i={i}
              href={href}
              role="option"
              aria-selected={s.id === currentId}
              className={`switcher-item${i === active ? " active" : ""}${s.id === currentId ? " current" : ""}`}
              onMouseEnter={() => setActive(i)}
              onClick={(e) => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; e.preventDefault(); go(s.id); }}
            >
              <span className={st?.now ? "livedot sm" : "livedot sm off"} aria-hidden />
              <span className="d">{s.domain}</span>
              {st?.now ? <span className="live">{st.now} live</span> : null}
              <span className="v">{st ? compact(st.visitors) : ""}</span>
            </a>
          );
        })}
        {shown.length === 0 && <div className="empty" style={{ padding: "12px 10px" }}>No sites match “{term}”.</div>}
      </div>
      <a className="switcher-all" href={withParams(url, { f: null, m: null, g: null }, "/")} onClick={(e) => { onClose(); linkHandler(navigate, withParams(url, { f: null, m: null, g: null }, "/"))(e); }}>
        All sites
      </a>
    </div>
  );
}
