import { describe, expect, it } from "vitest";

import type { DayType } from "@/lib/explorer/derive/serviceCalendar";
import { patternColors } from "@/lib/explorer/patternColors";

const type = (key: string, weekdays: number[]): DayType => ({
  key,
  days: [],
  trips: 1,
  weekdays,
  except: [],
  adds: [],
});

describe("pattern colours", () => {
  it("gives the same weekdays the same colour, whatever else a calendar holds", () => {
    const line = patternColors([type("a", [6]), type("b", [1, 2, 3, 4, 5]), type("c", [7])]);
    const trip = patternColors([type("t", [1, 2, 3, 4, 5])]);
    expect(trip[0]).toBe(line[1]);
    expect(patternColors([type("s", [6])])[0]).toBe(line[0]);
  });

  it("shades further patterns on the same weekdays apart", () => {
    const [term, holidays] = patternColors([type("a", [1, 2, 3, 4, 5]), type("b", [1, 2, 3, 4, 5])]);
    expect(holidays).not.toBe(term);
    expect(patternColors([type("x", [1, 2, 3, 4, 5])])[0]).toBe(term);
  });

  it("tells weeks without a colour of their own apart", () => {
    const [a, b] = patternColors([type("a", [1, 3]), type("b", [2, 4])]);
    expect(a).not.toBe(b);
  });
});
