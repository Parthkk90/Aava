import { createStore, del, entries, get, keys, set, clear, type UseStore } from "idb-keyval";
import type { KeyValueStore } from "@relaymesh/identity";
import type { StorageItem } from "@relaymesh/observatory";

/**
 * IndexedDB-backed store. Everything the app persists goes through this:
 * the identity vault (NIP-49 ciphertext), encrypted message history, the
 * payment ledger, and non-secret settings. Nothing is written to localStorage.
 */
export class IdbStore implements KeyValueStore {
  private readonly db: UseStore;
  constructor(dbName = "relaymesh", storeName = "kv") {
    this.db = createStore(dbName, storeName);
  }
  get(key: string) {
    return get<string>(key, this.db);
  }
  set(key: string, value: string) {
    return set(key, value, this.db);
  }
  delete(key: string) {
    return del(key, this.db);
  }
  async keys() {
    return (await keys(this.db)).map(String);
  }
  async dump(): Promise<[string, string][]> {
    return (await entries<string, string>(this.db)).map(([k, v]) => [String(k), typeof v === "string" ? v : JSON.stringify(v)]);
  }
  clear() {
    return clear(this.db);
  }
}

export const kv = new IdbStore();

/**
 * Cache for large public binaries (Tornado proving artifacts, ~34 MB). Kept out of `kv` so the
 * Observatory's storage scan stays small; contents are public and integrity-pinned by Kohaku.
 */
const cacheStore = createStore("relaymesh-cache", "blobs");
export const blobCache = {
  get: <T>(key: string) => get<T>(key, cacheStore),
  set: (key: string, value: unknown) => set(key, value, cacheStore),
};

/** Everything the browser stores for this origin that the app can see. Used by the Observatory key-storage test. */
export async function dumpAllStorage(): Promise<StorageItem[]> {
  const items: StorageItem[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i)!;
    items.push({ area: "localStorage", key: k, value: localStorage.getItem(k) ?? "" });
  }
  for (let i = 0; i < sessionStorage.length; i++) {
    const k = sessionStorage.key(i)!;
    items.push({ area: "sessionStorage", key: k, value: sessionStorage.getItem(k) ?? "" });
  }
  for (const [k, v] of await kv.dump()) items.push({ area: "indexedDB:relaymesh", key: k, value: v });
  return items;
}

/** Clears all local application data (demo step: "local application data is cleared"). */
export async function wipeAllLocalData() {
  await kv.clear();
  await clear(cacheStore);
  localStorage.clear();
  sessionStorage.clear();
}
