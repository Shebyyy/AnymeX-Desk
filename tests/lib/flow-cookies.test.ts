import { describe, expect, test } from 'bun:test';
import { clearFlowCookie, readFlowCookie, setFlowCookie } from '../../src/lib/flow-cookies';

function fakeCtx(url: string) {
  const jar = new Map<string, { value: string; options: Record<string, unknown> }>();
  const log: string[] = [];
  const cookies = {
    set: (name: string, value: string, options: Record<string, unknown> = {}) => {
      jar.set(name, { value, options });
      log.push(`set:${name}`);
    },
    get: (name: string) => (jar.has(name) ? { value: jar.get(name)!.value } : undefined),
    has: (name: string) => jar.has(name),
    delete: (name: string) => {
      jar.delete(name);
      log.push(`delete:${name}`);
    },
  };
  return { ctx: { cookies, url: new URL(url) } as never, jar, log };
}

describe('flow cookies', () => {
  test('https uses the __Host- prefix and secure, httponly, lax', () => {
    const { ctx, jar } = fakeCtx('https://desk.example/auth/discord');
    setFlowCookie(ctx, 'oauth_state', 'abc');
    const c = jar.get('__Host-oauth_state')!;
    expect(c.value).toBe('abc');
    expect(c.options).toMatchObject({ path: '/', httpOnly: true, secure: true, sameSite: 'lax' });
    expect(readFlowCookie(ctx, 'oauth_state')).toBe('abc');
  });

  test('http (dev) uses the plain name and is not secure', () => {
    const { ctx, jar } = fakeCtx('http://localhost:4321/auth/discord');
    setFlowCookie(ctx, 'oauth_next', '/new');
    expect(jar.get('oauth_next')!.options.secure).toBe(false);
    expect(readFlowCookie(ctx, 'oauth_next')).toBe('/new');
  });

  test('read returns undefined when absent, clear only acts when present', () => {
    const { ctx, log } = fakeCtx('https://desk.example/');
    expect(readFlowCookie(ctx, 'pending_vote')).toBeUndefined();
    clearFlowCookie(ctx, 'pending_vote');
    expect(log).toEqual([]);
    setFlowCookie(ctx, 'pending_vote', '12', 1800);
    clearFlowCookie(ctx, 'pending_vote');
    expect(readFlowCookie(ctx, 'pending_vote')).toBeUndefined();
  });
});
