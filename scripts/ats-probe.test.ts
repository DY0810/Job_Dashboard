import { describe, it, expect } from "vitest";
import { isConfirmed, candidateTokens } from "./ats-probe.js";

// Regression coverage for the per-ATS confirmation-rule fix: greenhouse/lever/ashby/
// recruitee/teamtailor/pinpoint 404 an unknown token (verified by hand, see PR), so a 200
// with the right (possibly empty) shape is itself the confirmation. workable/
// smartrecruiters/workday return 200 + an empty shell even for tokens that don't exist, so
// those three still need count > 0.
describe("isConfirmed", () => {
  const emptyBoardOkAts = ["greenhouse", "lever", "ashby", "recruitee", "teamtailor", "pinpoint"];
  const emptyShapeByAts: Record<string, unknown> = {
    greenhouse: { jobs: [] },
    lever: [],
    ashby: { jobs: [] },
    recruitee: { offers: [] },
    teamtailor: { items: [] },
    pinpoint: { data: [] },
  };
  const nonEmptyShapeByAts: Record<string, unknown> = {
    greenhouse: { jobs: [{ id: 1 }] },
    lever: [{ id: 1 }],
    ashby: { jobs: [{ id: 1 }] },
    recruitee: { offers: [{ id: 1 }] },
    teamtailor: { items: [{ id: 1 }] },
    pinpoint: { data: [{ id: 1 }] },
  };

  for (const ats of emptyBoardOkAts) {
    it(`${ats}: 200 + empty array is still confirmed (real board, zero current postings)`, () => {
      expect(isConfirmed(ats, 200, emptyShapeByAts[ats])).toBe(true);
    });
    it(`${ats}: 200 + non-empty array is confirmed`, () => {
      expect(isConfirmed(ats, 200, nonEmptyShapeByAts[ats])).toBe(true);
    });
    it(`${ats}: 404 is never confirmed regardless of body`, () => {
      expect(isConfirmed(ats, 404, { error: "not found" })).toBe(false);
    });
  }

  const strictCountAts = ["workable", "smartrecruiters", "workday"];
  const strictEmptyShapeByAts: Record<string, unknown> = {
    workable: { jobs: [] },
    smartrecruiters: { content: [] },
    workday: { jobPostings: [] },
  };
  const strictNonEmptyShapeByAts: Record<string, unknown> = {
    workable: { jobs: [{ id: 1 }] },
    smartrecruiters: { content: [{ id: 1 }] },
    workday: { jobPostings: [{ id: 1 }] },
  };

  for (const ats of strictCountAts) {
    it(`${ats}: 200 + empty array is NOT confirmed (these return 200 for accounts that don't exist)`, () => {
      expect(isConfirmed(ats, 200, strictEmptyShapeByAts[ats])).toBe(false);
    });
    it(`${ats}: 200 + non-empty array is confirmed`, () => {
      expect(isConfirmed(ats, 200, strictNonEmptyShapeByAts[ats])).toBe(true);
    });
  }

  it("200 with a body that doesn't even have the expected shape is never confirmed", () => {
    expect(isConfirmed("greenhouse", 200, { unexpected: "shape" })).toBe(false);
    expect(isConfirmed("greenhouse", 200, null)).toBe(false);
  });
});

describe("candidateTokens", () => {
  it("produces a lowercase slug and stays capped at 6 candidates", () => {
    const tokens = candidateTokens("Assort Health", "https://assorthealth.com");
    expect(tokens).toContain("assorthealth");
    expect(tokens.length).toBeLessThanOrEqual(6);
  });
});
