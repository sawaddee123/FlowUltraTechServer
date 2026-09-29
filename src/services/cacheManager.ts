/**
 * High-Performance In-Memory Cache Manager
 * Provides TTL caching, pattern invalidation, and metrics tracking
 * to eliminate excessive MongoDB fetch requests.
 */

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

export interface CacheMetrics {
  hits: number;
  misses: number;
  hitRatePercent: number;
  activeKeys: number;
  queriesSaved: number;
}

class CacheManager {
  private store: Map<string, CacheEntry<unknown>> = new Map();
  private hits: number = 0;
  private misses: number = 0;
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor() {
    // Run cleanup every 60 seconds to prune expired keys
    this.cleanupInterval = setInterval(() => {
      this.pruneExpired();
    }, 60000);

    // Unref interval so it doesn't block process exit
    if (this.cleanupInterval && typeof this.cleanupInterval.unref === "function") {
      this.cleanupInterval.unref();
    }
  }

  /**
   * Retrieve cached value if exists and not expired
   */
  get<T>(key: string): T | undefined {
    const entry = this.store.get(key) as CacheEntry<T> | undefined;
    if (!entry) {
      this.misses++;
      return undefined;
    }

    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      this.misses++;
      return undefined;
    }

    this.hits++;
    return entry.value;
  }

  /**
   * Set value in cache with TTL in seconds (default 60s)
   */
  set<T>(key: string, value: T, ttlSeconds: number = 60): void {
    const expiresAt = Date.now() + Math.max(1, ttlSeconds) * 1000;
    this.store.set(key, { value, expiresAt });
  }

  /**
   * Delete a single key
   */
  del(key: string): boolean {
    return this.store.delete(key);
  }

  /**
   * Invalidate all keys matching a prefix (e.g. 'user:' or 'lease:')
   */
  delPrefix(prefix: string): number {
    let count = 0;
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) {
        this.store.delete(key);
        count++;
      }
    }
    return count;
  }

  /**
   * Atomic Get or Fetch: returns cached value if available,
   * otherwise executes fetchFn, caches result, and returns it.
   */
  async getOrSet<T>(
    key: string,
    fetchFn: () => Promise<T>,
    ttlSeconds: number = 60
  ): Promise<T> {
    const cached = this.get<T>(key);
    if (cached !== undefined) {
      return cached;
    }

    const fresh = await fetchFn();
    if (fresh !== undefined && fresh !== null) {
      this.set(key, fresh, ttlSeconds);
    }
    return fresh;
  }

  /**
   * Clear entire cache
   */
  flush(): void {
    this.store.clear();
  }

  /**
   * Get operational statistics
   */
  getMetrics(): CacheMetrics {
    const total = this.hits + this.misses;
    const hitRatePercent = total > 0 ? Number(((this.hits / total) * 100).toFixed(1)) : 0;
    return {
      hits: this.hits,
      misses: this.misses,
      hitRatePercent,
      activeKeys: this.store.size,
      queriesSaved: this.hits,
    };
  }

  private pruneExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.store.entries()) {
      if (now > entry.expiresAt) {
        this.store.delete(key);
      }
    }
  }
}

export const cacheManager = new CacheManager();
