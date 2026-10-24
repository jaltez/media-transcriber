import { describe, expect, it } from "vitest";
import { execa } from "execa";

/**
 * Pins the execa behavior that the launch-failure self-heal in
 * whisper-local/parakeet/deepfilternet depends on: with `reject: false`, a
 * spawn failure (ENOENT — a stale cached command spec) RESOLVES instead of
 * throwing, and is detectable only via an undefined exitCode. If a future
 * execa changes this (e.g. throws anyway, or sets exitCode), the rediscover
 * paths must be revisited.
 */
describe("execa reject:false spawn-failure contract", () => {
  it("resolves with an undefined exit code when the binary is missing", async () => {
    const result = await execa("media-transcriber-no-such-binary-xyz", ["--version"], {
      reject: false,
    });
    expect(typeof result.exitCode).not.toBe("number");
    expect(result.failed).toBe(true);
  });
});
