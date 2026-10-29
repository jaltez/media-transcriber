import { describe, it, expect } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fuzzyFilter, fuzzyScore } from "./fuzzy.js";
import { parsePastedPaths, splitPathTokens } from "./paste-paths.js";
import {
  buildDoctorArgs,
  buildEnhanceArgs,
  buildTranscribeArgs,
  DEFAULT_TRANSCRIBE_FORM,
  describeProgressEvent,
  parseProgressLine,
} from "./args.js";
import {
  formatBytes,
  listDirectory,
  queuePaths,
  stageInto,
  unstagePath,
} from "./queue.js";

describe("fuzzyScore", () => {
  it("matches subsequences case-insensitively and rejects non-subsequences", () => {
    expect(fuzzyScore("abc", "/home/a/Bc.wav")).not.toBeNull();
    expect(fuzzyScore("xyz", "/home/a/Bc.wav")).toBeNull();
  });

  it("scores empty queries as a neutral match", () => {
    expect(fuzzyScore("", "anything")).toBe(0);
  });

  it("prefers basename hits over directory hits", () => {
    const basenameHit = fuzzyScore("interv", "/a/b/c/interview.mp3")!;
    const dirHit = fuzzyScore("a/b", "/a/b/interview.mp3")!;
    expect(basenameHit).toBeGreaterThan(dirHit);
  });
});

describe("fuzzyFilter", () => {
  it("filters and ranks by score", () => {
    const items = ["/music/zeppelin.wav", "/talks/interview.mp3", "/noise/aiff.txt"];
    const result = fuzzyFilter("interv", items, (p) => p);
    expect(result.map((r) => r.item)).toEqual(["/talks/interview.mp3"]);
  });

  it("keeps all items for an empty query in input order", () => {
    const items = ["b.wav", "a.wav"];
    expect(fuzzyFilter("", items, (p) => p).map((r) => r.item)).toEqual(items);
  });
});

describe("splitPathTokens", () => {
  const probes = {
    exists: (p: string) => ["/a/interview.mp3", "/b/interview.mp3", "/data dir/clip.wav"].includes(p),
    isFile: () => true,
  };

  it("splits newline-separated paths and strips quotes", () => {
    const text = '/a/interview.mp3\n"/data dir/clip.wav"\n';
    expect(splitPathTokens(text, probes)).toEqual(["/a/interview.mp3", "/data dir/clip.wav"]);
  });

  it("splits space-separated tokens only when every part exists", () => {
    const both = "/a/interview.mp3 /b/interview.mp3";
    expect(splitPathTokens(both, probes)).toEqual(["/a/interview.mp3", "/b/interview.mp3"]);
    const spacedSingle = "/data dir/clip.wav";
    expect(splitPathTokens(spacedSingle, probes)).toEqual(["/data dir/clip.wav"]);
  });
});

describe("parsePastedPaths", () => {
  it("classifies supported files, directories, and rejects the rest", () => {
    const parsed = parsePastedPaths("/a/x.mp3\n/tmp\n/b/notes.txt\n/missing.mp3", {
      exists: (p) => p !== "/missing.mp3",
      isFile: (p) => !p.startsWith("/tmp"),
    });
    expect(parsed.files).toEqual(["/a/x.mp3"]);
    expect(parsed.dirs).toEqual(["/tmp"]);
    expect(parsed.rejected).toEqual(["/b/notes.txt", "/missing.mp3"]);
  });
});

describe("buildTranscribeArgs", () => {
  it("maps every form field to the corresponding CLI flag", () => {
    const args = buildTranscribeArgs(
      {
        ...DEFAULT_TRANSCRIBE_FORM,
        backend: "whisper-api",
        model: "whisper-1",
        preset: "fast",
        formats: "srt",
        outputDir: "/out",
        enhancer: "deepfilternet",
        enhanceProfile: "master",
        splitThreshold: "600",
      },
      "/in/a.wav",
    );
    expect(args).toEqual([
      "transcribe", "/in/a.wav", "--json",
      "-b", "whisper-api",
      "-m", "whisper-1",
      "--preset", "fast",
      "-f", "srt",
      "/out",
      "--enhance", "deepfilternet",
      "--enhance-profile", "master",
      "--split-threshold", "600",
    ]);
  });

  it("omits empty fields entirely", () => {
    const args = buildTranscribeArgs(DEFAULT_TRANSCRIBE_FORM, "/in/a.wav");
    expect(args).toEqual(["transcribe", "/in/a.wav", "--json", "-b", "whisper-local", "-f", "txt,srt"]);
  });
});

describe("buildEnhanceArgs / buildDoctorArgs", () => {
  it("builds enhance args with engine, profile, report, and output", () => {
    expect(buildEnhanceArgs(
      { enhancer: "deepfilternet", profile: "asr", outputDir: "/o", report: true },
      "/in/a.wav",
    )).toEqual(["enhance", "/in/a.wav", "--json", "--enhancer", "deepfilternet", "--enhance-profile", "asr", "--report", "/o"]);
  });

  it("doctor runs all backends in json mode", () => {
    expect(buildDoctorArgs()).toEqual(["doctor", "--all", "--json"]);
  });
});

describe("parseProgressLine / describeProgressEvent", () => {
  it("parses NDJSON events and ignores foreign lines", () => {
    const event = parseProgressLine('{"event":"file_complete","file":"/a.wav","success":true}');
    expect(event).toMatchObject({ event: "file_complete", success: true });
    expect(parseProgressLine("ffmpeg noise")).toBeNull();
    expect(parseProgressLine("{broken")).toBeNull();
  });

  it("describes file events and skips step_complete noise", () => {
    expect(describeProgressEvent({ event: "file_complete", file: "/a/b.wav", success: true })).toBe("✓ b.wav");
    expect(describeProgressEvent({ event: "file_complete", file: "/a/b.wav", success: false, error: "boom" })).toContain("boom");
    expect(describeProgressEvent({ event: "step_complete", file: "/a.wav", step: "convert", message: "" })).toBeNull();
  });
});

describe("queue helpers", () => {
  it("stages paths deduped and unstages by path", () => {
    const first = stageInto([], ["/a.wav", "/b.wav"]);
    expect(queuePaths(first.items)).toEqual(["/a.wav", "/b.wav"]);
    const again = stageInto(first.items, ["/a.wav", "/c.wav"]);
    expect(again.added).toEqual(["/c.wav"]);
    expect(queuePaths(again.items)).toEqual(["/a.wav", "/b.wav", "/c.wav"]);
    const items = unstagePath(again.items, "/b.wav");
    expect(queuePaths(items)).toEqual(["/a.wav", "/c.wav"]);
    // Running items cannot be unstaged
    const running = again.items.map((item) =>
      item.path === "/a.wav" ? { ...item, status: "running" as const } : item,
    );
    expect(unstagePath(running, "/a.wav").some((item) => item.path === "/a.wav")).toBe(true);
  });

  it("formats byte sizes for display", () => {
    expect(formatBytes(0)).toBe("");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
  });
});

describe("listDirectory", () => {
  it("lists folders first, media by default, all files on request", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mt-listdir-"));
    try {
      await writeFile(join(dir, "b.mp3"), "x");
      await writeFile(join(dir, "a.txt"), "x");
      await mkdir(join(dir, "sub"));

      const media = await listDirectory(dir, false);
      expect(media.map((e) => e.name)).toEqual(["sub", "b.mp3"]);
      expect(media[0]!.isDir).toBe(true);
      expect(media[1]!.supported).toBe(true);

      const all = await listDirectory(dir, true);
      expect(all.map((e) => e.name)).toEqual(["sub", "a.txt", "b.mp3"]);
      expect(all.find((e) => e.name === "a.txt")!.supported).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
