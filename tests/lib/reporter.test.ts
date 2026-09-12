import { describe, expect, test } from 'bun:test';
import { isRealAccount, reporterMeta, reporterName } from '../../src/lib/reporter';

/**
 * The Discord announcement used to print a raw snowflake where the reporter's
 * name belonged, because it sent `<@id>` into an embed that pings nobody and
 * therefore carries nothing for a client to resolve. What it sends now is the
 * stored username, which means this module has to answer for a real account and
 * for the two synthetic ones without ever reading the database for the latter.
 */

const USERS: Record<string, { username: string }> = {
  '297145': { username: 'mech' },
  'tg:12345678': { username: 'telegram_user' },
};

/** Stands in for dbUser, and records who was looked up. */
function loader() {
  const asked: string[] = [];
  return {
    asked,
    load: async (id: string) => {
      asked.push(id);
      return USERS[id];
    },
  };
}

describe('isRealAccount', () => {
  test('empty or zero are not accounts', () => {
    expect(isRealAccount('')).toBe(false);
    expect(isRealAccount('0')).toBe(false);
  });

  test('a snowflake is', () => {
    expect(isRealAccount('297145')).toBe(true);
    expect(isRealAccount('1483322438551994499')).toBe(true);
  });

  test('a telegram id is', () => {
    expect(isRealAccount('tg:12345678')).toBe(true);
  });
});

describe('reporterName', () => {
  test('a real Discord account reads the username', async () => {
    const { asked, load } = loader();
    expect(await reporterName('297145', load)).toBe('mech');
    expect(asked).toEqual(['297145']);
  });

  test('a Telegram account reads the username', async () => {
    const { asked, load } = loader();
    expect(await reporterName('tg:12345678', load)).toBe('telegram_user');
    expect(asked).toEqual(['tg:12345678']);
  });

  test('an empty id costs no lookup and returns unknown', async () => {
    const { asked, load } = loader();
    expect(await reporterName('', load)).toBe('unknown');
    expect(await reporterName('0', load)).toBe('unknown');
    expect(asked).toEqual([]);
  });

  test('a missing user row does not leak the id', async () => {
    const { load } = loader();
    expect(await reporterName('999999', load)).toBe('unknown');
  });
});

describe('reporterMeta', () => {
  test('the page and the announcement get the same string', () => {
    expect(reporterMeta('297145', { username: 'mech' }).display).toBe('mech');
    expect(reporterMeta('tg:12345678', { username: 'telegram_user' }).display).toBe('telegram_user');
    expect(reporterMeta('0').display).toBe('unknown');
  });
});
