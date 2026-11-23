import { describe, expect, it } from "vitest";

import { CLASS_COUNTS } from "@/lib/style/editor/classify";
import { withStored } from "@/lib/style/editor/defaults";

describe("menu numbers", () => {
  it("a stored number the menu lacks takes its place in order, so the menu shows it and keeps it", () => {
    expect(withStored([2, 3, 5, 10], 4)).toEqual([2, 3, 4, 5, 10]);
    expect(withStored([2, 3, 5, 10], 13)).toEqual([2, 3, 5, 10, 13]);
    expect(withStored([10, 12], 9.5)).toEqual([9.5, 10, 12]);
  });

  it("a number the menu has, or no number, leaves it as it is", () => {
    expect(withStored([2, 3, 5], 3)).toEqual([2, 3, 5]);
    expect(withStored([2, 3, 5], undefined)).toEqual([2, 3, 5]);
    expect(withStored([2, 3, 5], "4")).toEqual([2, 3, 5]);
    expect(withStored([2, 3, 5], Number.NaN)).toEqual([2, 3, 5]);
  });

  it("class counts run from 2 to 13", () => {
    expect(CLASS_COUNTS).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
  });
});
