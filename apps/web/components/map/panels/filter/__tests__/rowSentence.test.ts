import type { TFunction } from "i18next";
import { describe, expect, it, vi } from "vitest";

import { rowSentence } from "@/components/map/panels/filter/ConditionRow";

// Every text is its key, with what it names after it.
const t = ((key: string, opts?: Record<string, unknown>) =>
  opts ? `${key}${JSON.stringify(opts)}` : key) as unknown as TFunction;

describe("a row as a sentence", () => {
  it("names the field, the comparison and a single value", () => {
    expect(rowSentence({ field: "status", op: "is", value: "open" }, "Status", t)).toBe(
      "Status filter_panel.op.is open"
    );
  });

  it("lists a few values and counts the rest", () => {
    expect(rowSentence({ field: "status", op: "includes", value: ["a", "b"] }, "Status", t)).toBe(
      "Status filter_panel.op.includes a, b"
    );
    expect(rowSentence({ field: "status", op: "includes", value: ["a", "b", "c", "d"] }, "Status", t)).toBe(
      'Status filter_panel.op.includes a, b, c filter_panel.more{"count":1}'
    );
  });

  it("reads a date and time in the browser's zone", () => {
    vi.stubEnv("TZ", "Europe/Berlin");
    try {
      expect(rowSentence({ field: "seen", op: "is_after", value: "2026-11-16T09:00:00Z" }, "Seen", t)).toBe(
        "Seen filter_panel.op.is_after 2026-11-16 10:00"
      );
      expect(
        rowSentence(
          { field: "seen", op: "is_between", value: "2026-07-01T08:00:00Z", value2: "2026-07-02T08:00:00Z" },
          "Seen",
          t
        )
      ).toBe(
        'Seen filter_panel.op.is_between filter_panel.range{"from":"2026-07-01 10:00","to":"2026-07-02 10:00"}'
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("reads a range and a number of days", () => {
    expect(rowSentence({ field: "lanes", op: "is_between", value: 5, value2: 40 }, "Lanes", t)).toBe(
      'Lanes filter_panel.op.is_between filter_panel.range{"from":"5","to":"40"}'
    );
    expect(rowSentence({ field: "built", op: "in_the_last", value: 30 }, "Built", t)).toBe(
      'Built filter_panel.op.in_the_last filter_panel.days{"count":30}'
    );
  });

  it("says nothing more for a comparison without a value, nor for a missing one", () => {
    expect(rowSentence({ field: "status", op: "is_blank" }, "Status", t)).toBe(
      "Status filter_panel.op.is_blank"
    );
    expect(rowSentence({ field: "status", op: "is", value: null }, "Status", t)).toBe(
      "Status filter_panel.op.is"
    );
  });

  it("leaves out an empty label, as a chip that bolds the field itself", () => {
    expect(rowSentence({ field: "status", op: "is", value: "open" }, "", t)).toBe("filter_panel.op.is open");
  });
});
