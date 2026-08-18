import { describe, it, expect } from "vitest";
import { parseLimit, shouldWriteRegistry, DEAD_OR_ACQUIRED, AMBIGUOUS_IDENTITY } from "./resolve-companies.js";

// Regression coverage for the two bugs code review found:
// 1. --limit=<garbage> must fail loudly, not silently resolve into a NaN that degrades to
//    "process zero companies" and still touches the registry file.
// 2. DEAD_OR_ACQUIRED / AMBIGUOUS_IDENTITY are keyed by names sourced from untrusted remote
//    input (the YC directory) — they must be Maps, not plain objects, or a company named
//    "constructor"/"toString"/"hasOwnProperty" hits the Object.prototype chain.
describe("parseLimit", () => {
  it("accepts a positive integer", () => {
    expect(parseLimit("5")).toBe(5);
    expect(parseLimit("1")).toBe(1);
  });

  it("rejects non-numeric input instead of yielding NaN", () => {
    expect(parseLimit("abc")).toBeNull();
  });

  it("rejects zero, negative, and non-integer input", () => {
    expect(parseLimit("0")).toBeNull();
    expect(parseLimit("-3")).toBeNull();
    expect(parseLimit("3.5")).toBeNull();
  });
});

describe("shouldWriteRegistry", () => {
  it("is false when nothing resolved this run — must not overwrite good data with a no-op", () => {
    expect(shouldWriteRegistry(0)).toBe(false);
  });

  it("is true when at least one company resolved", () => {
    expect(shouldWriteRegistry(1)).toBe(true);
    expect(shouldWriteRegistry(73)).toBe(true);
  });
});

describe("DEAD_OR_ACQUIRED / AMBIGUOUS_IDENTITY prototype-pollution safety", () => {
  it("are real Maps, not plain objects", () => {
    expect(DEAD_OR_ACQUIRED).toBeInstanceOf(Map);
    expect(AMBIGUOUS_IDENTITY).toBeInstanceOf(Map);
  });

  it("a company named after an Object.prototype member is never silently 'found'", () => {
    // A plain-object lookup like `({})["constructor"]` returns the Object constructor
    // function (truthy) and `({})["toString"]`/`["hasOwnProperty"]` return functions too —
    // exactly the false-positive this fix closes. Map.get has no prototype chain to hit.
    for (const key of ["constructor", "toString", "hasOwnProperty", "valueOf", "__proto__"]) {
      expect(DEAD_OR_ACQUIRED.get(key)).toBeUndefined();
      expect(AMBIGUOUS_IDENTITY.get(key)).toBeUndefined();
    }
  });

  it("known real keys still resolve correctly", () => {
    expect(AMBIGUOUS_IDENTITY.get("Alex")).toContain("ambiguous token");
  });
});
