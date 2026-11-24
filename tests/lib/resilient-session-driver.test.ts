import { describe, expect, test } from 'bun:test';
import resilientKVSessionDriver from '../../src/lib/resilient-session-driver';

function fakeKV(failPuts: boolean) {
  const store = new Map<string, string>();
  return {
    store,
    binding: {
      get: async (k: string) => store.get(k) ?? null,
      put: async (k: string, v: string) => {
        if (failPuts) throw new Error('KV PUT failed: 429 Too Many Requests');
        store.set(k, v);
      },
      delete: async (k: string) => {
        store.delete(k);
      },
      list: async () => ({ keys: [], list_complete: true }),
    },
  };
}

describe('resilient session driver', () => {
  test('a rejected KV write does not throw (no HTTP 500) and is not stored', async () => {
    const kv = fakeKV(true);
    const driver = resilientKVSessionDriver({ binding: kv.binding as never });
    await expect(driver.setItem!('sid', 'data', { ttl: 60 })).resolves.toBeUndefined();
    expect(kv.store.size).toBe(0);
  });

  test('normal writes and reads still work', async () => {
    const kv = fakeKV(false);
    const driver = resilientKVSessionDriver({ binding: kv.binding as never });
    await driver.setItem!('sid', 'data', { ttl: 60 });
    expect(await driver.getItem!('sid')).toBe('data');
  });
});
