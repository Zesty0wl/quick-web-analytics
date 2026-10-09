// Lucide-style icons (24px grid, stroke 2), drawn inline.
const p = (size = 16) => ({ width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "square" as const, strokeLinejoin: "miter" as const, "aria-hidden": true });

export const ArrowLeft = () => <svg {...p()}><path d="M19 12H5M12 19l-7-7 7-7" /></svg>;
export const Search = () => <svg {...p()}><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>;
export const External = ({ size = 14 }: { size?: number }) => <svg {...p(size)}><path d="M15 3h6v6M21 3l-9 9M18 13v8H3V6h8" /></svg>;
export const Sun = () => <svg {...p(18)}><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>;
export const Moon = () => <svg {...p(18)}><path d="M21 13A9 9 0 1 1 11 3a7 7 0 0 0 10 10z" /></svg>;
export const Close = () => <svg {...p(12)}><path d="M18 6 6 18M6 6l12 12" /></svg>;
export const Calendar = () => <svg {...p(15)}><rect x="3" y="4" width="18" height="17" /><path d="M3 9h18M8 2v4M16 2v4" /></svg>;
export const Cards = () => <svg {...p(17)}><rect x="3" y="3" width="7.5" height="7.5" rx="2" /><rect x="13.5" y="3" width="7.5" height="7.5" rx="2" /><rect x="3" y="13.5" width="7.5" height="7.5" rx="2" /><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="2" /></svg>;
export const Grid = () => <svg {...p(17)}><path d="M3 3h18v18H3zM12 3v18M3 12h18" /></svg>;
export const ChevronDown = ({ size = 14 }: { size?: number }) => <svg {...p(size)}><path d="m6 9 6 6 6-6" /></svg>;
export const Alarm = ({ size = 14 }: { size?: number }) => <svg {...p(size)}><circle cx="12" cy="13" r="7" /><path d="M12 10v3l2 2M5 3 2 6M22 6l-3-3M6.4 18.6 4 21M17.6 18.6 20 21" /></svg>;
export const Bell = ({ size = 16 }: { size?: number }) => <svg {...p(size)}><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.9 1.9 0 0 0 3.4 0" /></svg>;
export const BellOff = ({ size = 16 }: { size?: number }) => <svg {...p(size)}><path d="M8.7 3A6 6 0 0 1 18 8c0 2.9.5 4.9 1.2 6.3M17 17H3s3-2 3-9c0-.8.1-1.6.4-2.3M10.3 21a1.9 1.9 0 0 0 3.4 0M2 2l20 20" /></svg>;
