/**
 * Minimal async key/value store. The browser implementation uses IndexedDB;
 * the desktop build can back this with OS secure storage. Values written by the
 * vault are always ciphertext (NIP-49) or public metadata — never raw keys.
 */
export interface KeyValueStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  keys(): Promise<string[]>;
}

export class MemoryStore implements KeyValueStore {
  readonly data = new Map<string, string>();
  async get(key: string) {
    return this.data.get(key);
  }
  async set(key: string, value: string) {
    this.data.set(key, value);
  }
  async delete(key: string) {
    this.data.delete(key);
  }
  async keys() {
    return [...this.data.keys()];
  }
}
