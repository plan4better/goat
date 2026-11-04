import { describe, expect, it } from "vitest";

import { bySeverity, issueSeverity, mostSerious } from "@/components/workflows/issues/issueStyle";

import { makeIssue } from "./issueFixtures";

const damaged = makeIssue({ code: "node_duplicate_id", level: "damaged" });
const error = makeIssue({ code: "input_not_connected" });
const run = makeIssue({ code: "run_failed", source: "run" });
const warning = makeIssue({ code: "step_not_connected", level: "warning" });

describe("issue severity", () => {
  it("tells a failed run apart from a check error of the same level", () => {
    expect(issueSeverity(error)).toBe("error");
    expect(issueSeverity(run)).toBe("run");
    expect(issueSeverity(damaged)).toBe("damaged");
    expect(issueSeverity(warning)).toBe("warning");
  });

  it("ranks damaged over run errors over check errors over warnings", () => {
    expect([warning, error, run, damaged].sort(bySeverity)).toEqual([damaged, run, error, warning]);
    expect(mostSerious([warning, error])).toBe(error);
    expect(mostSerious([])).toBeUndefined();
  });
});
