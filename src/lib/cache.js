/**
 * cache.js — ইন-মেমোরি ক্যাশ (TTL সহ)
 *
 * Redis ছাড়া লাইটওয়েট সলিউশন — dashboard, reports ইত্যাদি
 * frequently accessed data ক্যাশ করে DB load কমায়।
 * কোনো external dependency নেই।
 */

class SimpleCache {
  constructor() {
    this.store = new Map();
    // প্রতি মিনিটে expired entries পরিষ্কার
    this.cleanupInterval = setInterval(() => this.cleanup(), 60 * 1000);
    // Node process exit-এ interval বন্ধ (test/graceful shutdown)
    if (this.cleanupInterval.unref) this.cleanupInterval.unref();
  }

  /**
   * ক্যাশে ডাটা সেট করা
   * @param {string} key — ক্যাশ key (e.g. "dashboard:<agencyId>")
   * @param {*} value — যেকোনো JSON-serializable ডাটা
   * @param {number} ttlSeconds — কতক্ষণ ক্যাশে থাকবে (default ৫ মিনিট)
   */
  set(key, value, ttlSeconds = 300) {
    this.store.set(key, {
      value,
      expiry: Date.now() + (ttlSeconds * 1000),
    });
  }

  /**
   * ক্যাশ থেকে ডাটা পড়া
   * @param {string} key
   * @returns {*|null} — ক্যাশ hit হলে value, না হলে null
   */
  get(key) {
    const item = this.store.get(key);
    if (!item) return null;
    // expired হলে মুছে null return
    if (Date.now() > item.expiry) {
      this.store.delete(key);
      return null;
    }
    return item.value;
  }

  /**
   * নির্দিষ্ট pattern-এর সব ক্যাশ মুছে ফেলা
   * data mutation (create/update/delete) এর পর call করতে হবে
   * @param {string} pattern — agency ID বা অন্য কোনো substring
   */
  invalidate(pattern) {
    for (const key of this.store.keys()) {
      if (key.includes(pattern)) this.store.delete(key);
    }
  }

  /**
   * expired entries পরিষ্কার (auto cleanup)
   */
  cleanup() {
    const now = Date.now();
    for (const [key, item] of this.store) {
      if (now > item.expiry) this.store.delete(key);
    }
  }

  /**
   * ক্যাশ stats — debugging/monitoring এর জন্য
   */
  stats() {
    return { size: this.store.size };
  }
}

// Singleton instance — পুরো app-এ একই cache ব্যবহার হবে
const cache = new SimpleCache();
module.exports = cache;
