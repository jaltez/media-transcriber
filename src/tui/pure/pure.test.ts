import { describe, it, expect } from "vitest";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fuzzyFilter, fuzzyScore } from "./fuzzy.js";
import { parsePastedPaths, splitPathTokens } from "./paste-paths.js";
import {
  buildDoctorArgs,
  buildEnhanceArgs,
  buildTranscribeArgs,
  DEFAULT_ENHANCE_FORM,
  DEFAULT_TRANSCRIBE_FORM,
  enhancementReportPath,
  describeProgressEvent,
  parseProgressLine,
  parseRunOutcome,
} from "./args.js";
import {
  formatBytes,
  listDirectory,
  MAX_STATED_ENTRIES,
  pendingTargets,
  resetForRerun,
  scanMediaFiles,
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
        allowUpload: true,
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
      "--allow-upload",
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
      { ...DEFAULT_ENHANCE_FORM, enhancer: "deepfilternet", profile: "asr", outputDir: "/o" },
      "/in/a.wav",
    )).toEqual(["enhance", "/in/a.wav", "--json", "--enhancer", "deepfilternet", "--enhance-profile", "asr", "--report", "/o"]);
  });

  it("doctor runs all backends in json mode", () => {
    expect(buildDoctorArgs()).toEqual(["doctor", "--all", "--json"]);
  });
});

describe("enhancement tuning flags", () => {
  it("emits none of the tuning flags at their CLI defaults", () => {
    const transcribe = buildTranscribeArgs(
      { ...DEFAULT_TRANSCRIBE_FORM, enhancer: "deepfilternet" },
      "/in/a.wav",
    );
    const enhance = buildEnhanceArgs({ ...DEFAULT_ENHANCE_FORM, enhancer: "deepfilternet" }, "/in/a.wav");
    for (const args of [transcribe, enhance]) {
      expect(args).not.toContain("--declick");
      expect(args).not.toContain("--no-hum-notch");
      expect(args).not.toContain("--howl-notch");
      expect(args).not.toContain("--dfn-atten");
    }
    expect(transcribe).not.toContain("-d");
  });

  it("passes device and every tuning flag through to the child", () => {
    const tuning = { declick: true, humNotch: false, howlNotch: true, dfnAtten: "12" as const };
    const transcribe = buildTranscribeArgs(
      { ...DEFAULT_TRANSCRIBE_FORM, ...tuning, device: "cuda", enhancer: "deepfilternet" },
      "/in/a.wav",
    );
    expect(transcribe.join(" ")).toContain(
      "-d cuda --enhance deepfilternet --declick --no-hum-notch --howl-notch --dfn-atten 12",
    );
    const enhance = buildEnhanceArgs({ ...DEFAULT_ENHANCE_FORM, ...tuning, enhancer: "deepfilternet" }, "/in/a.wav");
    expect(enhance.join(" ")).toContain("--declick --no-hum-notch --howl-notch --dfn-atten 12");
  });

  it("keeps --dfn-atten off engines that have no attenuation limit", () => {
    const form = { ...DEFAULT_ENHANCE_FORM, ...{ declick: true, humNotch: false, howlNotch: true, dfnAtten: "12" as const } };
    const basic = buildEnhanceArgs({ ...form, enhancer: "basic" }, "/in/a.wav");
    expect(basic).toContain("--declick");
    expect(basic).not.toContain("--dfn-atten");
    const transcribe = buildTranscribeArgs(
      { ...DEFAULT_TRANSCRIBE_FORM, ...form, enhancer: "basic" },
      "/in/a.wav",
    );
    expect(transcribe).toContain("--declick");
    expect(transcribe).not.toContain("--dfn-atten");
  });
});

describe("allow-upload consent", () => {
  it("is omitted unless explicitly consented", () => {
    expect(buildEnhanceArgs(
      { ...DEFAULT_ENHANCE_FORM, enhancer: "unise", profile: "master", report: false },
      "/in/a.wav",
    )).not.toContain("--allow-upload");
    expect(buildEnhanceArgs(
      { ...DEFAULT_ENHANCE_FORM, enhancer: "unise", profile: "master", report: false, allowUpload: true },
      "/in/a.wav",
    )).toContain("--allow-upload");
    expect(buildTranscribeArgs({ ...DEFAULT_TRANSCRIBE_FORM, enhancer: "unise", allowUpload: true }, "/in/a.wav")).toContain("--allow-upload");
    expect(buildTranscribeArgs({ ...DEFAULT_TRANSCRIBE_FORM, enhancer: "unise" }, "/in/a.wav")).not.toContain("--allow-upload");
  });
});

describe("parseRunOutcome", () => {
  it("reads the config-error envelope the CLI prints instead of files[]", () => {
    const outcome = parseRunOutcome(
      JSON.stringify({ error: "config_error", message: "Enhancer 'UniSE' uploads audio to a remote service. Pass --allow-upload to consent." }),
    );
    expect(outcome).toEqual({
      success: false,
      error: "Enhancer 'UniSE' uploads audio to a remote service. Pass --allow-upload to consent.",
    });
  });

  it("falls back to the error code when no message is present", () => {
    expect(parseRunOutcome('{"error":"missing_dependency"}')).toEqual({ success: false, error: "missing_dependency" });
  });

  it("surfaces per-file failures and enhancement report paths", () => {
    expect(parseRunOutcome('{"files":[{"success":false,"error":"whisper failed"}]}')).toEqual({
      success: false,
      error: "whisper failed",
    });
    const ok = parseRunOutcome(
      '{"files":[{"success":true,"enhancement":{"outputFile":"/o/clip_enhanced.wav"}}]}',
    );
    expect(ok).toEqual({
      success: true,
      output: "/o/clip_enhanced.wav",
      reportPath: "/o/clip_enhancement.json",
    });
  });

  it("rejects non-JSON child output", () => {
    expect(parseRunOutcome("ffmpeg died")).toEqual({ success: false, error: "unreadable child output" });
  });

  it("derives report paths for any extension, or none", () => {
    expect(enhancementReportPath("/o/a_enhanced.flac")).toBe("/o/a_enhancement.json");
    expect(enhancementReportPath("/o/b_enhanced")).toBe("/o/b_enhancement.json");
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
    const paths = (queue: { path: string }[]) => queue.map((item) => item.path);
    const first = stageInto([], ["/a.wav", "/b.wav"]);
    expect(paths(first.items)).toEqual(["/a.wav", "/b.wav"]);
    const again = stageInto(first.items, ["/a.wav", "/c.wav"]);
    expect(again.added).toEqual(["/c.wav"]);
    expect(paths(again.items)).toEqual(["/a.wav", "/b.wav", "/c.wav"]);
    const items = unstagePath(again.items, "/b.wav");
    expect(paths(items)).toEqual(["/a.wav", "/c.wav"]);
    // Running items cannot be unstaged
    const running = again.items.map((item) =>
      item.path === "/a.wav" ? { ...item, status: "running" as const } : item,
    );
    expect(unstagePath(running, "/a.wav").some((item) => item.path === "/a.wav")).toBe(true);
  });

  it("carries sizes through the sizeOf resolver", () => {
    const sizes = new Map([["/a.wav", 10], ["/b.wav", 2048]]);
    const { items } = stageInto([], ["/a.wav", "/b.wav", "/gone.wav"], (path) => sizes.get(path) ?? 0);
    expect(items.map((item) => item.sizeBytes)).toEqual([10, 2048, 0]);
  });

  it("formats byte sizes for display", () => {
    expect(formatBytes(0)).toBe("");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
  });

  const mixed = [
    { path: "/a.wav", sizeBytes: 0, status: "pending" as const },
    { path: "/b.wav", sizeBytes: 0, status: "done" as const },
    { path: "/c.wav", sizeBytes: 0, status: "failed" as const, error: "boom" },
    { path: "/d.wav", sizeBytes: 0, status: "running" as const },
  ];

  it("targets only pending and failed items on a plain run", () => {
    expect(pendingTargets(mixed).map((item) => item.path)).toEqual(["/a.wav", "/c.wav"]);
  });

  it("re-arms finished and failed items for a rerun-all, keeping running ones", () => {
    const reset = resetForRerun(mixed);
    expect(reset.map((item) => [item.path, item.status])).toEqual([
      ["/a.wav", "pending"],
      ["/b.wav", "pending"],
      ["/c.wav", "pending"],
      ["/d.wav", "running"],
    ]);
    expect(reset[2]!.error).toBeUndefined();
  });
});

describe("listDirectory", () => {
  it("lists folders first, media by default, all files on request", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mt-listdir-"));
    try {
      await writeFile(join(dir, "b.mp3"), "x");
      await writeFile(join(dir, "a.txt"), "x");
      await mkdir(join(dir, "sub"));

      const media = (await listDirectory(dir, false))!;
      expect(media.map((e) => e.name)).toEqual(["sub", "b.mp3"]);
      expect(media[0]!.isDir).toBe(true);
      expect(media[1]!.supported).toBe(true);

      const all = (await listDirectory(dir, true))!;
      expect(all.map((e) => e.name)).toEqual(["sub", "a.txt", "b.mp3"]);
      expect(all.find((e) => e.name === "a.txt")!.supported).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("treats a symlinked directory as a folder and skips broken links", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mt-listdir-link-"));
    try {
      await mkdir(join(dir, "real"));
      await symlink(join(dir, "real"), join(dir, "shortcut"));
      await symlink(join(dir, "nowhere"), join(dir, "broken"));

      const entries = (await listDirectory(dir, false))!;
      expect(entries.map((e) => e.name)).toEqual(["real", "shortcut"]);
      expect(entries.every((e) => e.isDir)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns null for missing directories but [] for empty ones", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mt-listdir-empty-"));
    try {
      expect(await listDirectory(dir, false)).toEqual([]);
      expect(await listDirectory(join(dir, "gone"), false)).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("skips per-file stats above the size cap so huge folders stay instant", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mt-listdir-cap-"));
    try {
      const count = MAX_STATED_ENTRIES + 1;
      await Promise.all(
        Array.from({ length: count }, (_, i) => writeFile(join(dir, `f${String(i).padStart(3, "0")}.wav`), "x")),
      );
      const entries = (await listDirectory(dir, false))!;
      expect(entries).toHaveLength(count);
      expect(entries.every((entry) => entry.sizeBytes === 0)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("scanMediaFiles", () => {
  it("reaches media behind symlinked directories and files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mt-scan-"));
    try {
      await mkdir(join(dir, "linked", "inner"), { recursive: true });
      await writeFile(join(dir, "linked", "inner", "a.wav"), "x");
      await writeFile(join(dir, "linked", "b.mp3"), "x");
      await symlink(join(dir, "linked"), join(dir, "library"));
      await symlink(join(dir, "linked", "b.mp3"), join(dir, "alias.mp3"));

      const found = await scanMediaFiles(dir);
      expect(found).toContain(join(dir, "library", "inner", "a.wav"));
      expect(found).toContain(join(dir, "library", "b.mp3"));
      expect(found).toContain(join(dir, "alias.mp3"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("stops at the depth bound and ignores broken symlinks", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mt-scan-depth-"));
    try {
      let deep = dir;
      for (let i = 0; i < 8; i += 1) deep = join(deep, `d${i}`);
      await mkdir(deep, { recursive: true });
      await writeFile(join(deep, "too-deep.mp3"), "x");
      await symlink(join(dir, "missing"), join(dir, "broken"));

      expect(await scanMediaFiles(dir)).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
