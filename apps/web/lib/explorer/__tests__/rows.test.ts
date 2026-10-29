import {
  Bool,
  Field,
  Float64,
  Int32,
  Int64,
  List,
  Table,
  Utf8,
  makeData,
  vectorFromArray,
} from "apache-arrow";
import { describe, expect, it } from "vitest";

import { rowsOf } from "@/lib/explorer/db/rows";

describe("rows of an Arrow table", () => {
  it("are what Arrow's own row objects give, nulls, strings and lists included", () => {
    const table = new Table({
      i: vectorFromArray([1, 2, 3], new Int32()),
      inull: vectorFromArray([1, null, 3], new Int32()),
      f: vectorFromArray([0.5, 1.5, 2.5], new Float64()),
      fnull: vectorFromArray([null, 1.5, null], new Float64()),
      big: vectorFromArray([BigInt(1), BigInt(2), BigInt(3)], new Int64()),
      s: vectorFromArray(["a", null, "c"], new Utf8()),
      b: vectorFromArray([true, false, null], new Bool()),
      l: vectorFromArray([[1, 2], [], null], new List(new Field("item", new Int32(), true))),
    });
    const ours = rowsOf(table);
    const arrows = table.toArray().map((row) => row.toJSON());
    expect(ours).toHaveLength(3);
    for (let r = 0; r < 3; r++)
      for (const k of Object.keys(arrows[r])) {
        const a = (arrows[r] as Record<string, unknown>)[k];
        const o = (ours[r] as Record<string, unknown>)[k];
        // Lists are Arrow vectors either way: compare their values.
        if (a && typeof a === "object" && "toArray" in a)
          expect(Array.from(o as unknown as Iterable<number>)).toEqual(
            Array.from(a as unknown as Iterable<number>)
          );
        else expect(o).toEqual(a);
      }
    expect(ours[1]).toMatchObject({ i: 2, inull: null, fnull: 1.5, s: null, b: false });
  });

  it("has no rows for an empty result", () => {
    const empty = new Table({ i: makeData({ type: new Int32(), length: 0 }) as never });
    expect(rowsOf(empty)).toEqual([]);
  });
});
