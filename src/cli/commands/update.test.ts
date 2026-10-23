import { describe, it, expect } from "vitest";
import { compareSemver, detectInstallContext } from "./update.js";

describe("compareSemver", () => {
  it("returns 0 for equal versions", () => {
    expect(compareSemver("1.2.0", "1.2.0")).toBe(0);
  });

  it("returns positive when a is newer", () => {
    expect(compareSemver("1.10.0", "1.2.0")).toBeGreaterThan(0);
    expect(compareSemver("2.0.0", "1.99.99")).toBeGreaterThan(0);
    expect(compareSemver("1.2.1", "1.2.0")).toBeGreaterThan(0);
  });

  it("returns negative when b is newer", () => {
    expect(compareSemver("1.1.1", "1.2.0")).toBeLessThan(0);
  });

  it("compares numerically, not lexicographically", () => {
    expect(compareSemver("1.10.0", "1.9.0")).toBeGreaterThan(0);
  });

  it("tolerates short and prefixed versions", () => {
    expect(compareSemver("v1.2.0", "1.2.0")).toBe(0);
    expect(compareSemver("1.2", "1.2.0")).toBe(0);
  });
});

describe("detectInstallContext", () => {
  const noGit = () => false;

  it("detects npx cache paths", () => {
    const execPath = "/home/user/.npm/_npx/abc123/node_modules/media-transcriber/dist/index.js";
    expect(detectInstallContext(execPath, null, noGit)).toBe("npx");
  });

  it("detects global npm installs via the global root", () => {
    const execPath = "/usr/lib/node_modules/media-transcriber/dist/index.js";
    expect(detectInstallContext(execPath, "/usr/lib/node_modules", noGit)).toBe("npm-global");
  });

  it("does not misclassify paths outside the global root", () => {
    const execPath = "/opt/tools/media-transcriber/dist/index.js";
    expect(detectInstallContext(execPath, "/usr/lib/node_modules", noGit)).toBe("unknown");
  });

  it("detects git checkouts by walking up to a .git directory", () => {
    const execPath = "/home/user/projects/media-transcriber/dist/index.js";
    const gitRoots = new Set(["/home/user/projects/media-transcriber"]);
    expect(detectInstallContext(execPath, null, (dir) => gitRoots.has(dir))).toBe("git");
  });

  it("returns unknown when nothing matches", () => {
    const execPath = "/opt/media-transcriber/dist/index.js";
    expect(detectInstallContext(execPath, null, noGit)).toBe("unknown");
  });
});
