/**
 * Small in-memory LRU for person-resolution snippets (optional optimization).
 */

const DEFAULT_MAX = 500;

export function createCache(max = DEFAULT_MAX) {
  const map = new Map();

  function get(key) {
    if (!map.has(key)) return undefined;
    const v = map.get(key);
    map.delete(key);
    map.set(key, v);
    return v;
  }

  function set(key, value) {
    if (map.has(key)) map.delete(key);
    map.set(key, value);
    while (map.size > max) {
      const first = map.keys().next().value;
      map.delete(first);
    }
  }

  return { get, set, clear: () => map.clear() };
}
