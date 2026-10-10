// A small in-memory LRU for query answers. Each isolate keeps its own; the key carries everything an answer depends on.

export class ResultCache<T> {
  private entries = new Map<string, { value: T; bytes: number }>();
  private bytes = 0;

  constructor(private readonly limits: { maxEntries: number; maxBytes: number }) {}

  /** A short, fixed-length key for any JSON-serialisable parts. */
  static async key(parts: unknown[]): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(parts)));
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  get(key: string): T | undefined {
    const e = this.entries.get(key);
    if (!e) return undefined;
    // Most recently used goes to the back.
    this.entries.delete(key);
    this.entries.set(key, e);
    return e.value;
  }

  set(key: string, value: T, bytes = JSON.stringify(value).length) {
    if (bytes > this.limits.maxBytes / 4) return; // one huge answer shouldn't push out everything else
    const old = this.entries.get(key);
    if (old) {
      this.bytes -= old.bytes;
      this.entries.delete(key);
    }
    this.entries.set(key, { value, bytes });
    this.bytes += bytes;
    while (this.entries.size > this.limits.maxEntries || this.bytes > this.limits.maxBytes) {
      const [oldest, e] = this.entries.entries().next().value!;
      this.entries.delete(oldest);
      this.bytes -= e.bytes;
    }
  }

  get size() {
    return this.entries.size;
  }
}
