import { describe, expect, it } from "vitest";
import {
  calculateSplitParts,
  calculateSplitPartsForConstraints,
} from "./orchestrator.js";

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

describe("calculateSplitPartsForConstraints", () => {
  it("uses the duration split count when it is larger", () => {
    expect(calculateSplitPartsForConstraints(1800, 600, 10, 100)).toBe(3);
  });

  it("uses the backend size split count when it is larger", () => {
    expect(calculateSplitPartsForConstraints(300, 600, 250, 100)).toBe(3);
  });

  it("returns one part when no constraint is exceeded", () => {
    expect(calculateSplitPartsForConstraints(300, 600, 50, 100)).toBe(1);
  });
});
