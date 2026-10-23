import { describe, it, expect } from "vitest";
import {
  parseSrtTimestamp,
  formatSrtTimestamp,
  parseSrt,
  buildSrtFromSegments,
} from "./transcript-merger.js";

describe("parseSrtTimestamp", () => {
  it("parses a standard SRT timestamp", () => {
    expect(parseSrtTimestamp("00:01:23,456")).toBe(83456);
  });

  it("parses zero timestamp", () => {
    expect(parseSrtTimestamp("00:00:00,000")).toBe(0);
  });

  it("parses large timestamp", () => {
    expect(parseSrtTimestamp("02:30:45,123")).toBe(
      2 * 3600000 + 30 * 60000 + 45 * 1000 + 123,
    );
  });

  it("returns 0 for invalid input", () => {
    expect(parseSrtTimestamp("invalid")).toBe(0);
  });
});

describe("formatSrtTimestamp", () => {
  it("formats zero", () => {
    expect(formatSrtTimestamp(0)).toBe("00:00:00,000");
  });

  it("formats a standard timestamp", () => {
    expect(formatSrtTimestamp(83456)).toBe("00:01:23,456");
  });

  it("formats large values", () => {
    const ms = 2 * 3600000 + 30 * 60000 + 45 * 1000 + 123;
    expect(formatSrtTimestamp(ms)).toBe("02:30:45,123");
  });

  it("roundtrips correctly", () => {
    const timestamp = "01:15:30,789";
    const ms = parseSrtTimestamp(timestamp);
    expect(formatSrtTimestamp(ms)).toBe(timestamp);
  });
});

describe("buildSrtFromSegments", () => {
  it("renders second-based segments as a numbered SRT document", () => {
    const srt = buildSrtFromSegments([
      { start: 0, end: 2.5, text: "Hello world" },
      { start: 3.1, end: 5, text: "Second cue" },
    ]);
    expect(srt).toBe(
      [
        "1",
        "00:00:00,000 --> 00:00:02,500",
        "Hello world",
        "",
        "2",
        "00:00:03,100 --> 00:00:05,000",
        "Second cue",
        "",
      ].join("\n"),
    );
  });

  it("rounds fractional seconds to milliseconds", () => {
    const srt = buildSrtFromSegments([{ start: 1.2345, end: 2.9999, text: "x" }]);
    expect(srt).toContain("00:00:01,235 --> 00:00:03,000");
  });

  it("never emits an end time before the start time", () => {
    const srt = buildSrtFromSegments([{ start: 5, end: 4.9, text: "clamped" }]);
    expect(srt).toContain("00:00:05,000 --> 00:00:05,000");
  });

  it("round-trips through parseSrt", () => {
    const segments = [
      { start: 0.5, end: 3.25, text: "first" },
      { start: 4, end: 6.75, text: "second" },
    ];
    const entries = parseSrt(buildSrtFromSegments(segments));
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ startTime: 500, endTime: 3250, text: "first" });
    expect(entries[1]).toMatchObject({ startTime: 4000, endTime: 6750, text: "second" });
  });

  it("returns an empty string for no segments", () => {
    expect(buildSrtFromSegments([])).toBe("");
  });
});

describe("parseSrt", () => {
  it("parses a simple SRT file", () => {
    const content = [
      "1",
      "00:00:30,000 --> 00:00:37,000",
      "Hello world",
      "",
      "2",
      "00:00:43,000 --> 00:00:50,000",
      "Second subtitle",
      "",
    ].join("\n");

    const entries = parseSrt(content);
    expect(entries).toHaveLength(2);

    expect(entries[0]!.index).toBe(1);
    expect(entries[0]!.startTime).toBe(30000);
    expect(entries[0]!.endTime).toBe(37000);
    expect(entries[0]!.text).toBe("Hello world");

    expect(entries[1]!.index).toBe(2);
    expect(entries[1]!.startTime).toBe(43000);
    expect(entries[1]!.endTime).toBe(50000);
    expect(entries[1]!.text).toBe("Second subtitle");
  });

  it("handles multi-line subtitles", () => {
    const content = [
      "1",
      "00:00:01,000 --> 00:00:05,000",
      "Line one",
      "Line two",
      "",
    ].join("\n");

    const entries = parseSrt(content);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.text).toBe("Line one\nLine two");
  });

  it("handles empty content", () => {
    const entries = parseSrt("");
    expect(entries).toHaveLength(0);
  });

  it("handles Windows line-endings", () => {
    const content = "1\r\n00:00:01,000 --> 00:00:02,000\r\nTest\r\n\r\n";
    const entries = parseSrt(content);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.text).toBe("Test");
  });
});
