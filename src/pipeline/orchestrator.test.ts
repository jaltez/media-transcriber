import { describe, expect, it } from "vitest";
import { calculateSplitParts } from "./orchestrator.js";

describe("calculateSplitParts", () => {
  it("does not over-split exact multiples", () => {
    expect(calculateSplitParts(1200, 600)).toBe(2);
  });

  it("rounds up when there is a remainder", () => {
    expect(calculateSplitParts(1201, 600)).toBe(3);
  });

  it("returns at least one part", () => {
    expect(calculateSplitParts(1, 600)).toBe(1);
  });
});
