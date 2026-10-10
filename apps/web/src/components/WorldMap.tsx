// World basemap (Natural Earth via world-atlas, projected ahead of time into worldShapes.ts) with accent dots sized by
// visitors per country.
import { useMemo } from "react";
import { countryName, whole } from "../format";
import { CENTROIDS, SHAPES, VIEW_H, VIEW_W } from "./worldShapes";

// ISO 3166-1 alpha-2 → numeric (world-atlas feature ids), built from Intl where possible plus a table.
const NUMERIC: Record<string, string> = {
  AF: "004", AL: "008", DZ: "012", AR: "032", AU: "036", AT: "040", BD: "050", BE: "056", BO: "068", BR: "076", BG: "100", KH: "116", CM: "120", CA: "124",
  CL: "152", CN: "156", CO: "170", CR: "188", HR: "191", CU: "192", CY: "196", CZ: "203", DK: "208", DO: "214", EC: "218", EG: "818", SV: "222", EE: "233",
  ET: "231", FI: "246", FR: "250", DE: "276", GH: "288", GR: "300", GT: "320", HN: "340", HK: "344", HU: "348", IS: "352", IN: "356", ID: "360", IR: "364",
  IQ: "368", IE: "372", IL: "376", IT: "380", JM: "388", JP: "392", JO: "400", KZ: "398", KE: "404", KR: "410", KW: "414", LV: "428", LB: "422", LT: "440",
  LU: "442", MY: "458", MX: "484", MA: "504", NP: "524", NL: "528", NZ: "554", NI: "558", NG: "566", NO: "578", OM: "512", PK: "586", PA: "591", PY: "600",
  PE: "604", PH: "608", PL: "616", PT: "620", PR: "630", QA: "634", RO: "642", RU: "643", SA: "682", RS: "688", SG: "702", SK: "703", SI: "705", ZA: "710",
  ES: "724", LK: "144", SE: "752", CH: "756", TW: "158", TZ: "834", TH: "764", TN: "788", TR: "792", UG: "800", UA: "804", AE: "784", GB: "826", US: "840",
  UY: "858", UZ: "860", VE: "862", VN: "704", YE: "887", ZM: "894", ZW: "716", BY: "112", GE: "268", AM: "051", AZ: "031", MN: "496", MM: "104", BA: "070",
  MK: "807", ME: "499", MD: "498", MT: "470", BH: "048", TT: "780", SN: "686", CI: "384", AO: "024", MZ: "508", SD: "729", LY: "434",
};

// The basemap never changes, so it's one element React builds once.
const basemap = SHAPES.map(([id, d], i) => <path key={id || i} d={d} fill="color-mix(in srgb, var(--tint) 9%, transparent)" stroke="var(--color-bg)" strokeWidth={0.6} />);

export function WorldMap({ data, caption, onPick }: { data: { code: string; visitors: number }[]; caption: string; onPick?: (code: string) => void }) {
  const max = Math.max(1, ...data.map((d) => d.visitors));
  const dots = useMemo(
    () =>
      data
        .map((d) => ({ ...d, at: CENTROIDS[NUMERIC[d.code] ?? ""] ?? null }))
        .filter((d) => d.at && d.visitors > 0)
        .sort((a, b) => b.visitors - a.visitors),
    [data],
  );
  return (
    <div className="map">
      <svg viewBox={`0 0 ${VIEW_W} ${VIEW_H}`} preserveAspectRatio="xMidYMid meet" role="img" aria-label={caption}>
        {basemap}
        {dots.map((d) => {
          const r = 3 + Math.sqrt(d.visitors / max) * 13;
          return (
            <circle
              key={d.code}
              cx={d.at![0]}
              cy={d.at![1]}
              r={r}
              fill="color-mix(in srgb, var(--color-accent) 75%, transparent)"
              stroke="var(--color-accent)"
              strokeWidth={1}
              style={{ cursor: onPick ? "pointer" : undefined }}
              onClick={() => onPick?.(d.code)}
            >
              <title>{`${countryName(d.code)}: ${whole(d.visitors)} visitor${d.visitors === 1 ? "" : "s"}`}</title>
            </circle>
          );
        })}
      </svg>
      <span className="cap">{caption}</span>
    </div>
  );
}
