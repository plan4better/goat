import { describe, expect, it } from "vitest";

import type { Fields, FilterModel, FilterRow } from "@/lib/filter/model";
import { readFilter } from "@/lib/filter/read";
import { overLimits, writeFilter } from "@/lib/filter/write";

const FIELDS: Fields = { name: "string", traffic: "number", opened: "date", seen: "datetime" };

const p = (field: string) => ({ property: field });
const row = (id: string, partial: Partial<FilterRow>): FilterRow => ({
  id,
  field: "name",
  op: "is",
  enabled: true,
  ...partial,
});
const model = (rows: FilterModel["rows"], match: FilterModel["match"] = "all"): FilterModel => ({
  match,
  rows,
});
const strip = (m: FilterModel) => m.rows.map(({ id: _id, ...rest }) => rest);

describe("writeFilter", () => {
  it("writes nothing for no rows", () => {
    expect(writeFilter(model([]), FIELDS)).toEqual({ cql: undefined, ui: undefined });
  });

  it("always writes a group at the top, also for one row", () => {
    expect(writeFilter(model([row("n1", { value: "a" })], "any"), FIELDS)).toEqual({
      cql: { op: "or", args: [{ op: "=", args: [p("name"), "a"] }] },
      ui: undefined,
    });
  });

  it("writes every negation with the empty value as an alternative", () => {
    const negations: Array<Partial<FilterRow>> = [
      { op: "is_not", value: "a" },
      { op: "excludes", value: ["a"] },
      { op: "does_not_contains_the_text", value: "a" },
      { field: "traffic", op: "is_not_between", value: 1, value2: 2 },
      { field: "opened", op: "is_not_on", value: "2024-01-01" },
      { field: "seen", op: "is_not_on", value: "2024-01-01" },
      { field: "seen", op: "not_in_the_last", value: 3 },
    ];
    for (const partial of negations) {
      const { cql } = writeFilter(model([row("n1", partial)]), FIELDS);
      const written = (cql?.args as Array<{ op: string; args: unknown[] }>)[0];
      expect(written.op, partial.op).toBe("or");
      expect(written.args.at(-1), partial.op).toEqual({ op: "isNull", args: [p(partial.field ?? "name")] });
    }
  });

  it("leaves out a contains row with % or _ and an unfinished row", () => {
    const { cql } = writeFilter(
      model([
        row("n1", { op: "contains_the_text", value: "50%" }),
        row("n2", { op: "starts_with", value: "a_" }),
        row("n3", { field: "", value: "a" }),
        row("n4", { op: "is" }),
        row("n5", { value: "ok" }),
      ]),
      FIELDS
    );
    expect(cql).toEqual({ op: "and", args: [{ op: "=", args: [p("name"), "ok"] }] });
  });

  it("keeps a switched-off row in the notes, not in the CQL", () => {
    const written = writeFilter(
      model([
        row("n1", { value: "a" }),
        row("n2", { value: "b", enabled: false }),
        row("n3", { value: "c" }),
      ]),
      FIELDS
    );
    expect(written.cql).toEqual({
      op: "and",
      args: [
        { op: "=", args: [p("name"), "a"] },
        { op: "=", args: [p("name"), "c"] },
      ],
    });
    expect(written.ui).toEqual({ v: 1, off: [{ at: 1, cql: { op: "=", args: [p("name"), "b"] } }] });

    const back = readFilter(written.cql, written.ui, FIELDS);
    expect(back.rows.map((r) => [r.id, r.enabled])).toEqual([
      ["r0", true],
      ["r1", false],
      ["r2", true],
    ]);
    // Without the notes the same rows are active.
    const active = readFilter(written.cql, undefined, FIELDS);
    expect(strip(active)).toEqual(strip(back).filter((r) => r.enabled));
  });

  it("counts positions among the rows it writes, so an unfinished row does not shift them", () => {
    const written = writeFilter(
      model([row("n0", { op: "is" }), row("n1", { value: "a", enabled: false }), row("n2", { value: "b" })]),
      FIELDS
    );
    expect(written.ui?.off).toEqual([{ at: 0, cql: { op: "=", args: [p("name"), "a"] } }]);
  });

  it("writes only switched-off rows as no CQL and notes", () => {
    const written = writeFilter(model([row("n1", { value: "a", enabled: false })]), FIELDS);
    expect(written.cql).toBeUndefined();
    expect(readFilter(written.cql, written.ui, FIELDS).rows).toEqual([
      { id: "r0", field: "name", op: "is", value: "a", enabled: false },
    ]);
  });

  it("writes a relative date as its number of days, without a note, and reads it back", () => {
    const written = writeFilter(
      model([
        row("n1", { field: "seen", op: "in_the_last", value: 7 }),
        row("n2", { field: "opened", op: "not_in_the_last", value: 30, enabled: false }),
      ]),
      FIELDS
    );
    expect(written.cql).toEqual({
      op: "and",
      args: [{ op: ">=", args: [p("seen"), { op: "daysAgo", args: [7] }] }],
    });
    expect(written.ui?.relative).toBeUndefined();
    expect(readFilter(written.cql, undefined, FIELDS).rows).toEqual([
      { id: "r0", field: "seen", op: "in_the_last", value: 7, enabled: true },
    ]);
    expect(readFilter(written.cql, written.ui, FIELDS).rows[1]).toEqual({
      id: "r1",
      field: "opened",
      op: "not_in_the_last",
      value: 30,
      enabled: false,
    });
  });

  it("writes a relative date saved before as a date with a note as its number of days again", () => {
    const saved = {
      op: "and",
      args: [{ op: ">=", args: [p("seen"), { timestamp: "2026-02-22T10:00:00Z" }] }],
    };
    const read = readFilter(saved, { v: 1, relative: [{ at: 0, days: 7 }] }, FIELDS);
    expect(writeFilter(read, FIELDS)).toEqual({
      cql: { op: "and", args: [{ op: ">=", args: [p("seen"), { op: "daysAgo", args: [7] }] }] },
      ui: undefined,
    });
  });

  it("keeps custom rows verbatim and in place next to an edited row", () => {
    const area = { op: "s_intersects", args: [p("geom"), { type: "Point", coordinates: [1, 2] }] };
    const nested = {
      op: "or",
      args: [
        { op: "=", args: [p("name"), "x"] },
        { op: ">", args: [p("traffic"), 3] },
      ],
    };
    const saved = {
      op: "and",
      args: [area, { op: "=", args: [p("name"), "a"] }, nested, { op: "<>", args: [p("traffic"), 4] }],
    };
    const read = readFilter(saved, undefined, FIELDS);
    const edited = { ...read, rows: read.rows.map((r) => (r.id === "r1" ? { ...r, value: "b" } : r)) };
    const written = writeFilter(edited, FIELDS);
    const args = written.cql?.args as unknown[];
    expect(args[0]).toBe(area);
    expect(args[1]).toEqual({ op: "=", args: [p("name"), "b"] });
    expect(args[2]).toBe(nested);
    expect(args[3]).toEqual({
      op: "or",
      args: [
        { op: "<>", args: [p("traffic"), 4] },
        { op: "isNull", args: [p("traffic")] },
      ],
    });

    const again = writeFilter(readFilter(written.cql, written.ui, FIELDS), FIELDS);
    expect(again.cql).toEqual(written.cql);
  });

  it("switches a custom row off and on again unchanged", () => {
    const area = { op: "s_intersects", args: [p("geom"), { type: "Point", coordinates: [1, 2] }] };
    const read = readFilter({ op: "and", args: [area] }, undefined, FIELDS);
    const off = writeFilter({ ...read, rows: read.rows.map((r) => ({ ...r, enabled: false })) }, FIELDS);
    expect(off).toEqual({ cql: undefined, ui: { v: 1, off: [{ at: 0, cql: area }] } });
    const back = readFilter(off.cql, off.ui, FIELDS);
    const on = writeFilter({ ...back, rows: back.rows.map((r) => ({ ...r, enabled: true })) }, FIELDS);
    expect(on.cql).toEqual({ op: "and", args: [area] });
  });

  it("does not overflow on a custom row thousands of levels deep", () => {
    let node: unknown = { op: "=", args: [p("name"), "a"] };
    for (let i = 0; i < 5000; i++) node = { op: "not", args: [node] };
    const read = readFilter(
      { op: "and", args: [node, { op: "=", args: [p("name"), "b"] }] },
      undefined,
      FIELDS
    );
    expect(() => writeFilter(read, FIELDS)).not.toThrow();
    expect((writeFilter(read, FIELDS).cql?.args as unknown[])[0]).toBe(node);
    // 5000 levels are more than a map request takes, also counted without recursion.
    expect(overLimits(read)).toEqual(["length"]);
  });
});

describe("overLimits", () => {
  it("names the limits a filter is over", () => {
    const rows = Array.from({ length: 21 }, (_, i) => row(`n${i}`, { value: String(i) }));
    expect(overLimits(model(rows))).toEqual(["conditions"]);
    expect(overLimits(model(rows.slice(0, 20)))).toEqual([]);
    const values = Array.from({ length: 101 }, (_, i) => `v${i}`);
    expect(overLimits(model([row("n1", { op: "includes", value: values })]))).toEqual(["values"]);
    expect(overLimits(model([row("n1", { op: "includes", value: values.slice(0, 100) })]))).toEqual([]);
    // A switched-off or unfinished row is not saved, so it does not count.
    expect(
      overLimits(model([...rows.slice(0, 20), row("x", { value: "a", enabled: false }), row("y", {})]))
    ).toEqual([]);
  });
});
