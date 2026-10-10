// The realtime snapshot as dashboards see it. Kept apart from the Durable Object so the API can use it anywhere.

/** A realtime snapshot without the admin-only fields (which tracker sends events). */
export function forViewer<T extends { plausibleLastAt: number | null; qwaLastAt: number | null }>({ plausibleLastAt: _p, qwaLastAt: _q, ...rest }: T) {
  return rest;
}
