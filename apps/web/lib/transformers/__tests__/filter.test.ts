import { describe, expect, it } from "vitest";

import { createTheCQLBasedOnExpression, parseCQLQueryToObject } from "@/lib/transformers/filter";
import { FilterType, type Expression } from "@/lib/validations/filter";

const FIELDS = [
  { name: "status", type: "string" },
  { name: "groundelev", type: "number" },
  { name: "lstmoddate", type: "date" },
];

const expression = (partial: Partial<Expression>): Expression => ({
  id: "e1",
  attribute: "status",
  expression: "is",
  value: "",
  type: FilterType.Logical,
  ...partial,
});

/** Write one expression to CQL and read it back, as reopening a filter does. */
const roundTrip = (input: Expression) => {
  const cql = createTheCQLBasedOnExpression([input], FIELDS, "and");
  return parseCQLQueryToObject(cql as { op: string; args: unknown[] })[0];
};

describe("parseCQLQueryToObject", () => {
  it("keeps excludes distinct from includes", () => {
    // Both are and/or wrappers; reading the wrapper alone silently inverted
    // every excludes filter into an includes on reload.
    expect(roundTrip(expression({ expression: "excludes", value: ["a", "b"] }))).toMatchObject({
      attribute: "status",
      expression: "excludes",
      value: ["a", "b"],
    });

    expect(roundTrip(expression({ expression: "includes", value: ["a", "b"] }))).toMatchObject({
      attribute: "status",
      expression: "includes",
      value: ["a", "b"],
    });
  });

  it("reads back a negated text match", () => {
    expect(
      roundTrip(expression({ expression: "does_not_contains_the_text", value: "school" }))
    ).toMatchObject({
      attribute: "status",
      expression: "does_not_contains_the_text",
      value: "school",
    });
  });

  it("reads a numeric range as a range, not a value list", () => {
    expect(
      roundTrip(expression({ attribute: "groundelev", expression: "is_between", value: [5, 40] }))
    ).toMatchObject({
      attribute: "groundelev",
      expression: "is_between",
      value: [5, 40],
    });
  });

  it("reads a date range in the order it was written", () => {
    const parsed = roundTrip(
      expression({
        attribute: "lstmoddate",
        expression: "is_not_between",
        value: ["2024-01-01", "2024-03-01"],
      })
    );
    expect(parsed.expression).toBe("is_not_between");
    expect(parsed.attribute).toBe("lstmoddate");
    const [from, to] = parsed.value as string[];
    expect(new Date(from).getTime()).toBeLessThan(new Date(to).getTime());
  });

  it("still reads the operators it always handled", () => {
    expect(roundTrip(expression({ expression: "is", value: "a" }))).toMatchObject({
      expression: "is",
      value: "a",
    });
    expect(roundTrip(expression({ expression: "is_not", value: "a" }))).toMatchObject({
      expression: "is_not",
    });
    expect(roundTrip(expression({ expression: "contains_the_text", value: "abc" }))).toMatchObject({
      expression: "contains_the_text",
      value: "abc",
    });
    expect(roundTrip(expression({ expression: "starts_with", value: "abc" }))).toMatchObject({
      expression: "starts_with",
      value: "abc",
    });
    expect(roundTrip(expression({ expression: "is_blank" }))).toMatchObject({
      expression: "is_blank",
      attribute: "status",
    });
    expect(roundTrip(expression({ expression: "is_not_blank" }))).toMatchObject({
      expression: "is_not_blank",
      attribute: "status",
    });
    expect(
      roundTrip(expression({ attribute: "groundelev", expression: "is_at_least", value: 5 }))
    ).toMatchObject({ expression: "is_at_least", value: 5 });
    expect(roundTrip(expression({ expression: "is_true" }))).toMatchObject({ expression: "is_true" });
    expect(roundTrip(expression({ expression: "is_false" }))).toMatchObject({ expression: "is_false" });
  });

  it("returns nothing for an absent filter", () => {
    expect(parseCQLQueryToObject(undefined)).toEqual([]);
  });
});

describe("negations and empty values", () => {
  const prop = { property: "status" };
  const empty = { op: "isNull", args: prop };
  const write = (input: Expression) =>
    (createTheCQLBasedOnExpression([input], FIELDS, "and") as { args: unknown[] }).args[0];

  // SQL drops a row with an empty value from `status <> 'a'`: the comparison is unknown, not true. A reader of
  // "is not a" expects that row, so every negation also takes the empty value.
  it("writes is not with the empty value as an alternative", () => {
    expect(write(expression({ expression: "is_not", value: "a" }))).toEqual({
      op: "or",
      args: [{ op: "!=", args: [prop, "a"] }, empty],
    });
  });

  it("writes excludes with the empty value as an alternative", () => {
    expect(write(expression({ expression: "excludes", value: ["a", "b"] }))).toEqual({
      op: "or",
      args: [
        {
          op: "and",
          args: [
            { op: "!=", args: [prop, "a"] },
            { op: "!=", args: [prop, "b"] },
          ],
        },
        empty,
      ],
    });
  });

  it("writes does not contain with the empty value as an alternative", () => {
    expect(write(expression({ expression: "does_not_contains_the_text", value: "school" }))).toEqual({
      op: "or",
      args: [{ op: "not", args: [{ op: "like", args: [prop, "%school%"] }] }, empty],
    });
  });

  it("writes the date negations with the empty value as an alternative", () => {
    const date = { property: "lstmoddate" };
    const written = write(
      expression({
        attribute: "lstmoddate",
        expression: "is_not_between",
        value: ["2024-01-01", "2024-03-01"],
      })
    ) as { op: string; args: { op: string }[] };
    expect(written.op).toBe("or");
    expect(written.args.map((arg) => arg.op)).toEqual(["<", ">", "isNull"]);
    expect(written.args[2]).toEqual({ op: "isNull", args: date });

    for (const input of [
      expression({ attribute: "lstmoddate", expression: "is_not_on", value: "2024-01-01" }),
      expression({ attribute: "lstmoddate", expression: "not_in_the_last", value: 7 }),
    ]) {
      const other = write(input) as { op: string; args: { op: string }[] };
      expect(other.args.map((arg) => arg.op)).toEqual(["<", ">", "isNull"]);
    }
  });

  it("leaves is not empty as it is", () => {
    expect(write(expression({ expression: "is_not_empty_string" }))).toEqual({
      op: "!=",
      args: [prop, ""],
    });
  });

  it("reads the values back", () => {
    expect(roundTrip(expression({ expression: "is_not", value: "a" }))).toMatchObject({
      attribute: "status",
      expression: "is_not",
      value: "a",
    });
    expect(
      roundTrip(expression({ attribute: "groundelev", expression: "is_not", value: 5 }))
    ).toMatchObject({ attribute: "groundelev", expression: "is_not", value: 5 });
    expect(roundTrip(expression({ expression: "excludes", value: ["a"] }))).toMatchObject({
      attribute: "status",
      expression: "excludes",
      value: ["a"],
    });
  });

  it("still reads filters saved before", () => {
    const saved = (node: unknown) => parseCQLQueryToObject({ op: "and", args: [node] })[0];

    expect(saved({ op: "!=", args: [prop, "a"] })).toMatchObject({
      attribute: "status",
      expression: "is_not",
      value: "a",
    });
    expect(
      saved({
        op: "and",
        args: [
          { op: "!=", args: [prop, "a"] },
          { op: "!=", args: [prop, "b"] },
        ],
      })
    ).toMatchObject({ attribute: "status", expression: "excludes", value: ["a", "b"] });
    expect(saved({ op: "not", args: [{ op: "like", args: [prop, "%school%"] }] })).toMatchObject({
      attribute: "status",
      expression: "does_not_contains_the_text",
      value: "school",
    });
    expect(
      saved({
        op: "or",
        args: [
          { op: "<", args: [{ property: "lstmoddate" }, "2024-01-01"] },
          { op: ">", args: [{ property: "lstmoddate" }, "2024-03-01"] },
        ],
      })
    ).toMatchObject({
      attribute: "lstmoddate",
      expression: "is_not_between",
      value: ["2024-01-01", "2024-03-01"],
    });
  });
});

describe("createTheCQLBasedOnExpression", () => {
  it("accepts numeric bounds as a pair and as the legacy string", () => {
    const fromPair = createTheCQLBasedOnExpression(
      [expression({ attribute: "groundelev", expression: "is_between", value: [5, 40] })],
      FIELDS,
      "and"
    );
    const fromString = createTheCQLBasedOnExpression(
      [expression({ attribute: "groundelev", expression: "is_between", value: "5-40" })],
      FIELDS,
      "and"
    );
    expect(fromPair).toEqual(fromString);
  });

  it("keeps several expressions under the chosen logical operator", () => {
    const cql = createTheCQLBasedOnExpression(
      [
        expression({ expression: "is", value: "a" }),
        expression({ id: "e2", attribute: "groundelev", expression: "is_at_least", value: 5 }),
      ],
      FIELDS,
      "or"
    ) as { op: string; args: unknown[] };

    expect(cql.op).toBe("or");
    expect(cql.args).toHaveLength(2);
    expect(parseCQLQueryToObject(cql).map((e) => e.expression)).toEqual(["is", "is_at_least"]);
  });
});
