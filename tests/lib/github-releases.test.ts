import { describe, expect, test } from 'bun:test';
import { getCachedReleases, FALLBACK_RELEASES } from '../../src/lib/github-releases';

describe('getCachedReleases', () => {
  test('returns valid stable, beta, and plugin release structures with fallbacks', async () => {
    // Calling with null kv returns data (either fetched or fallback)
    const releases = await getCachedReleases(null);
    expect(releases).toBeDefined();
    expect(Array.isArray(releases.stable)).toBe(true);
    expect(Array.isArray(releases.beta)).toBe(true);
    expect(Array.isArray(releases.plugin)).toBe(true);

    expect(releases.stable.length).toBeGreaterThan(0);
    expect(releases.beta.length).toBeGreaterThan(0);
    expect(releases.plugin.length).toBeGreaterThan(0);

    expect(releases.latest.stable).toBeDefined();
    expect(releases.latest.beta).toBeDefined();
    expect(releases.latest.plugin).toBeDefined();

    // Verify tag formats
    expect(releases.latest.stable?.tag).toMatch(/^v?\d/);
    expect(releases.latest.beta?.tag).toMatch(/^v?\d/);
    expect(releases.latest.plugin?.tag).toMatch(/^v?\d/);
  });

  test('cached releases are served consistently', async () => {
    const r1 = await getCachedReleases(null);
    const r2 = await getCachedReleases(null);
    expect(r1.latest.stable?.version).toBe(r2.latest.stable?.version);
  });
});
