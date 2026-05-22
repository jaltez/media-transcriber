import { describe, expect, it } from "vitest";
import { parseCommandLine } from "./whisper.js";

describe("parseCommandLine", () => {
  it("parses a simple command", () => {
    expect(parseCommandLine("whisper")).toEqual({ command: "whisper", args: [] });
  });

  it("parses command arguments", () => {
    expect(parseCommandLine("uv tool run whisper")).toEqual({
      command: "uv",
      args: ["tool", "run", "whisper"],
    });
  });

  it("keeps quoted paths together", () => {
    expect(parseCommandLine('"C:\\Program Files\\Whisper\\whisper.exe" --flag')).toEqual({
      command: "C:\\Program Files\\Whisper\\whisper.exe",
      args: ["--flag"],
    });
  });
});