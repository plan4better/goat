import { describe, expect, it } from "vitest";

import { defaultResultName } from "@/components/map/panels/toolbox/generic/inputs/FieldStatisticsInput";

describe("defaultResultName", () => {
  it("is field then operation unless the tool names another order", () => {
    expect(defaultResultName("sum", "Einwohner gesamt")).toBe("Einwohner gesamt_sum");
  });

  it("follows the tool's template", () => {
    expect(defaultResultName("sum", "Einwohner gesamt", "{operation}_{field}")).toBe("sum_Einwohner gesamt");
  });

  it("is count for a count, whatever the template", () => {
    expect(defaultResultName("count", null, "{operation}_{field}")).toBe("count");
  });

  it("keeps a field name with replacement patterns as it is", () => {
    expect(defaultResultName("max", "a$&b", "{operation}_{field}")).toBe("max_a$&b");
  });

  it("is empty until an operation and a field are chosen", () => {
    expect(defaultResultName("", "value")).toBe("");
    expect(defaultResultName("sum", null)).toBe("");
  });
});
