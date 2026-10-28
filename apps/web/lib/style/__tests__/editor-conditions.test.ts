import { describe, expect, it } from "vitest";

import en from "@/i18n/locales/en/common.json";

import {
  type ConditionRows,
  conditionSentence,
  fromRows,
  operatorsFor,
  toRows,
} from "@/lib/style/editor/conditions";

const FIELDS = {
  traffic: "number",
  pupils: "integer",
  name: "string",
  oneway: "boolean",
  opened: "date",
} as const;

const t = ((key: string, opts?: Record<string, unknown>) => {
  const [ns, k] = key.split(".");
  const text = (en as unknown as Record<string, Record<string, string>>)[ns]?.[k] ?? key;
  return Object.entries(opts ?? {}).reduce((s, [name, v]) => s.replace(`{{${name}}}`, String(v)), text);
}) as never;

const one = (row: ConditionRows["rows"][number]): ConditionRows => ({ match: "all", rows: [row] });
const roundTrip = (rows: ConditionRows) => toRows(fromRows(rows, FIELDS), FIELDS);

describe("rule conditions", () => {
  it("every operator round-trips and writes spec 6's shape", () => {
    const cases: ConditionRows[] = [
      one({ field: "traffic", op: "is", value: 300 }),
      one({ field: "traffic", op: "is_not", value: 300 }),
      one({ field: "name", op: "includes", value: ["a", "b"] }),
      one({ field: "name", op: "excludes", value: ["a"] }),
      one({ field: "name", op: "is_blank" }),
      one({ field: "name", op: "is_not_blank" }),
      one({ field: "traffic", op: "is_less_than", value: 1500 }),
      one({ field: "traffic", op: "is_greater_than", value: 1500 }),
      one({ field: "traffic", op: "is_at_most", value: 1500 }),
      one({ field: "traffic", op: "is_at_least", value: 1500 }),
      one({ field: "traffic", op: "is_between", value: 10, value2: 20 }),
      one({ field: "name", op: "contains_the_text", value: "Gymnasium" }),
      one({ field: "name", op: "does_not_contains_the_text", value: "x" }),
      one({ field: "name", op: "starts_with", value: "Prim" }),
      one({ field: "name", op: "ends_with", value: "schule" }),
      one({ field: "oneway", op: "is_true" }),
      one({ field: "oneway", op: "is_false" }),
      one({ field: "opened", op: "is_before", value: "2020-01-01" }),
      one({ field: "opened", op: "is_after", value: "2020-01-01" }),
      {
        match: "any",
        rows: [
          { field: "name", op: "is_blank" },
          { field: "pupils", op: "is_less_than", value: 300 },
        ],
      },
    ];
    for (const rows of cases) expect(roundTrip(rows), JSON.stringify(rows)).toEqual(rows);
    expect(fromRows(one({ field: "name", op: "is_blank" }), FIELDS)).toEqual({
      op: "isNull",
      args: [{ property: "name" }],
    });
    expect(fromRows(one({ field: "traffic", op: "is_not", value: 5 }), FIELDS)).toEqual({
      op: "<>",
      args: [{ property: "traffic" }, 5],
    });
  });

  it("a number field's value is a number; an unfinished row writes nothing", () => {
    expect(fromRows(one({ field: "pupils", op: "is", value: "300" }), FIELDS)).toEqual({
      op: "=",
      args: [{ property: "pupils" }, 300],
    });
    expect(fromRows(one({ field: "pupils", op: "is", value: "" }), FIELDS)).toBeNull();
    expect(fromRows(one({ field: "pupils", op: "is", value: "abc" }), FIELDS)).toBeNull();
    expect(fromRows(one({ field: "name", op: "contains_the_text", value: "a_b" }), FIELDS)).toBeNull();
    expect(fromRows({ match: "all", rows: [] }, FIELDS)).toBeNull();
  });

  it("offers the operators that fit the field type", () => {
    expect(operatorsFor("boolean")).toEqual(["is_true", "is_false", "is_blank", "is_not_blank"]);
    expect(operatorsFor("string")).toContain("contains_the_text");
    expect(operatorsFor("number")).toContain("is_between");
    expect(operatorsFor("number")).not.toContain("starts_with");
    expect(operatorsFor("date")).toContain("is_before");
  });

  it("a condition the rows cannot show reads as null", () => {
    const nested = {
      op: "and",
      args: [
        {
          op: "or",
          args: [
            { op: "=", args: [{ property: "name" }, "a"] },
            { op: "isNull", args: [{ property: "name" }] },
          ],
        },
        {
          op: "not",
          args: [
            {
              op: "and",
              args: [
                { op: "<", args: [{ property: "traffic" }, 1] },
                { op: ">", args: [{ property: "traffic" }, 9] },
              ],
            },
          ],
        },
      ],
    };
    expect(toRows(nested, FIELDS)).toBeNull();
  });

  it("a pattern or a value a row would change reads as null", () => {
    const like = (pattern: string) => ({ op: "like", args: [{ property: "name" }, pattern] });
    expect(toRows(like("Primary%school%"), FIELDS)).toBeNull();
    expect(toRows(like("St_%"), FIELDS)).toBeNull();
    expect(toRows(like("%school%"), FIELDS)).not.toBeNull();
    expect(toRows({ op: ">", args: [{ property: "opened" }, { date: "2020-01-01" }] }, FIELDS)).toBeNull();
    expect(toRows({ op: "=", args: [{ property: "name" }, { property: "traffic" }] }, FIELDS)).toBeNull();
    expect(toRows({ op: "in", args: [{ property: "name" }, ["a", { property: "b" }]] }, FIELDS)).toBeNull();
  });

  it("reads as a sentence", () => {
    const label = (n: string) => n[0].toUpperCase() + n.slice(1);
    expect(conditionSentence({ op: "=", args: [{ property: "oneway" }, true] }, label, t, FIELDS)).toBe(
      "Oneway is true"
    );
    expect(conditionSentence({ op: "<", args: [{ property: "traffic" }, 1500] }, label, t, FIELDS)).toBe(
      "Traffic is less than 1500"
    );
    expect(conditionSentence({ op: "isNull", args: [{ property: "name" }] }, label, t, FIELDS)).toBe(
      "Name is blank"
    );
  });
});
