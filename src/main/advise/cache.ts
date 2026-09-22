/**
 * Raw Jev answers keyed by the hash of the state they were asked about (plan §3.4):
 * changing a weight must re-rank, never re-request. Small and in-memory — a match is
 * an hour and a handful of decision points.
 */
export class AnswerCache<T> {
  private entries = new Map<string, T>();

  constructor(private readonly limit = 64) {}

  get(key: string): T | undefined {
    const value = this.entries.get(key);
    if (value !== undefined) {
      // Refresh recency so the live decision point is never the one evicted.
      this.entries.delete(key);
      this.entries.set(key, value);
    }
    return value;
  }

  set(key: string, value: T): void {
    this.entries.set(key, value);
    if (this.entries.size > this.limit) {
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }
  }

  clear(): void {
    this.entries.clear();
  }
}
