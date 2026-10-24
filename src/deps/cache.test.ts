import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  invalidateProbeCache,
  isProbeCacheDisabled,
  NEGATIVE_TTL_MS,
  POSITIVE_TTL_MS,
  readProbeCache,
  setProbeCacheDisabled,
  withProbeCache,
  writeProbeCache,
} from "./cache.js";

interface FakeStatus {
  available: boolean;
  version?: string;
}

describe("probe cache", () => {
  let cacheDir: string;
  let computeCalls: number;

  beforeEach(async () => {
    cacheDir = await mkdtemp(join(tmpdir(), "media-transcriber-cache-test-"));
    process.env["MEDIA_TRANSCRIBER_CACHE_DIR"] = cacheDir;
    delete process.env["MEDIA_TRANSCRIBER_NO_CACHE"];
    setProbeCacheDisabled(false);
    computeCalls = 0;
  });

  afterEach(async () => {
    delete process.env["MEDIA_TRANSCRIBER_CACHE_DIR"];
    setProbeCacheDisabled(false);
    await rm(cacheDir, { recursive: true, force: true });
  });

  function compute(status: FakeStatus): Promise<FakeStatus> {
    computeCalls += 1;
    return Promise.resolve(status);
  }

  it("computes once and serves the second read from cache", async () => {
    const first = await withProbeCache<FakeStatus>(
      "test-a",
      (v) => v.available,
      () => compute({ available: true, version: "1.0" }),
    );
    const second = await withProbeCache<FakeStatus>(
      "test-a",
      (v) => v.available,
      () => compute({ available: true, version: "2.0" }),
    );

    expect(first).toEqual({ available: true, version: "1.0" });
    expect(second).toEqual(first);
    expect(computeCalls).toBe(1);
    expect(existsSync(join(cacheDir, "test-a.json"))).toBe(true);
  });

  it("expires positive entries after the positive TTL and negatives after the negative TTL", async () => {
    await withProbeCache<FakeStatus>("test-b", (v) => v.available, () =>
      compute({ available: true }));

    const path = join(cacheDir, "test-b.json");
    const readStoredAt = async () =>
      (JSON.parse(await readFile(path, "utf-8")) as { storedAt: number }).storedAt;
    expect(await readStoredAt()).toBeGreaterThan(0);

    const backdate = async (ageMs: number) => {
      const entry = JSON.parse(await readFile(path, "utf-8")) as { storedAt: number };
      entry.storedAt = Date.now() - ageMs;
      await writeFile(path, JSON.stringify(entry), "utf-8");
    };

    // Positive entry: still fresh inside POSITIVE_TTL_MS, stale beyond it.
    await backdate(POSITIVE_TTL_MS / 2);
    expect(await readProbeCache<FakeStatus>("test-b", (v) => v.available)).not.toBeNull();

    await backdate(POSITIVE_TTL_MS + 5_000);
    expect(await readProbeCache<FakeStatus>("test-b", (v) => v.available)).toBeNull();

    // Negative entry expires much sooner.
    await withProbeCache<FakeStatus>("test-c", (v) => v.available, () =>
      compute({ available: false }));
    const negativePath = join(cacheDir, "test-c.json");
    const backdateNegative = async (ageMs: number) => {
      const entry = JSON.parse(await readFile(negativePath, "utf-8")) as { storedAt: number };
      entry.storedAt = Date.now() - ageMs;
      await writeFile(negativePath, JSON.stringify(entry), "utf-8");
    };

    await backdateNegative(NEGATIVE_TTL_MS / 2);
    expect(await readProbeCache<FakeStatus>("test-c", (v) => v.available)).not.toBeNull();

    await backdateNegative(NEGATIVE_TTL_MS + 5_000);
    expect(await readProbeCache<FakeStatus>("test-c", (v) => v.available)).toBeNull();
  });

  it("bypasses and does not write the cache when MEDIA_TRANSCRIBER_NO_CACHE=1", async () => {
    process.env["MEDIA_TRANSCRIBER_NO_CACHE"] = "1";

    await withProbeCache<FakeStatus>("test-d", (v) => v.available, () =>
      compute({ available: true }));

    expect(computeCalls).toBe(1);
    expect(existsSync(join(cacheDir, "test-d.json"))).toBe(false);
    expect(isProbeCacheDisabled()).toBe(true);
  });

  it("bypasses the cache after setProbeCacheDisabled()", async () => {
    setProbeCacheDisabled();
    await withProbeCache<FakeStatus>("test-e", (v) => v.available, () =>
      compute({ available: true }));

    expect(existsSync(join(cacheDir, "test-e.json"))).toBe(false);
  });

  it("treats a corrupt cache file as a miss and removes it", async () => {
    const path = join(cacheDir, "test-f.json");
    await writeFile(path, "{not valid json", "utf-8");

    const value = await withProbeCache<FakeStatus>("test-f", (v) => v.available, () =>
      compute({ available: true, version: "3.0" }));

    expect(value).toEqual({ available: true, version: "3.0" });
    expect(computeCalls).toBe(1);

    // The rewritten entry is valid JSON again.
    const entry = JSON.parse(await readFile(path, "utf-8")) as { schema: number; value: FakeStatus };
    expect(entry.value).toEqual({ available: true, version: "3.0" });
  });

  it("rejects entries from a different schema version", async () => {
    await writeProbeCache("test-g", { available: true });
    const path = join(cacheDir, "test-g.json");
    const entry = JSON.parse(await readFile(path, "utf-8")) as { schema: number };
    entry.schema = 999;
    await writeFile(path, JSON.stringify(entry), "utf-8");

    expect(await readProbeCache<FakeStatus>("test-g", (v) => v.available)).toBeNull();
  });

  it("invalidateProbeCache removes a single key or everything", async () => {
    await writeProbeCache("test-h1", { available: true });
    await writeProbeCache("test-h2", { available: true });

    await invalidateProbeCache("test-h1");
    expect(existsSync(join(cacheDir, "test-h1.json"))).toBe(false);
    expect(existsSync(join(cacheDir, "test-h2.json"))).toBe(true);

    await invalidateProbeCache();
    expect(existsSync(join(cacheDir, "test-h2.json"))).toBe(false);
    expect((await readdir(cacheDir)).filter((name) => name.endsWith(".json"))).toHaveLength(0);
  });

  it("concurrent writers leave a readable entry (no torn reads)", async () => {
    await Promise.all([
      withProbeCache<FakeStatus>("test-i", (v) => v.available, () => compute({ available: true, version: "a" })),
      withProbeCache<FakeStatus>("test-i", (v) => v.available, () => compute({ available: true, version: "b" })),
    ]);

    const value = await readProbeCache<FakeStatus>("test-i", (v) => v.available);
    expect(value).not.toBeNull();
    expect(["a", "b"]).toContain(value!.version);
  });
});
