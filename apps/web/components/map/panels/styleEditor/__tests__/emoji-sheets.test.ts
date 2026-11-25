import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { EMOJI, EMOJI_GROUPS } from "@/lib/style/generated/emoji";

import { cellsOf } from "@/components/map/panels/styleEditor/pickers/EmojiPane";

const SHEETS = resolve(__dirname, "../../../../../public/assets/icons/emoji/sheets");

describe("emoji sheets", () => {
  it("every emoji and toned code has a cell, in catalogue order per group and per tone", () => {
    const cells = cellsOf(EMOJI);
    expect(cells.get("1f600")).toEqual({ sheet: "smileys_emotion", index: 0 });
    const toned = EMOJI.filter((e) => e.tones);
    const wave = toned.findIndex((e) => e.code === "1f44b");
    expect(cells.get("1f44b-1f3fd")).toEqual({ sheet: "tone-3", index: wave });
    expect(cells.size).toBe(EMOJI.length + toned.length * 5);
  });

  it("each group and tone has its sheet", () => {
    for (const name of [...EMOJI_GROUPS, "tone-1", "tone-2", "tone-3", "tone-4", "tone-5"])
      expect(existsSync(resolve(SHEETS, `${name}.webp`)), name).toBe(true);
  });
});
