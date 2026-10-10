import { useInView } from "./Bits";

/** A dashboard section that renders its body once scrolled near, and lets its queries run only while it's near. */
export function Section({ id, title, sub, right, children }: { id: string; title: string; sub?: React.ReactNode; right?: React.ReactNode; children: (visible: boolean) => React.ReactNode }) {
  const [ref, seen, near] = useInView<HTMLElement>();
  return (
    <section id={id} className="section" ref={ref}>
      <div className="section-head">
        <h3>{title}</h3>
        {sub && <span className="muted" style={{ marginRight: right ? "auto" : undefined }}>{sub}</span>}
        {right}
      </div>
      {seen ? children(near) : <div className="placeholder" />}
    </section>
  );
}

export function Seg<T extends string>({ value, options, onChange }: { value: T; options: { id: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="seg" role="group">
      {options.map((o) => <button key={o.id} className={value === o.id ? "on" : ""} onClick={() => onChange(o.id)}>{o.label}</button>)}
    </div>
  );
}

