import { describe, expect, it } from "vitest";

import { commonT } from "@/i18n/__tests__/commonI18n";

import { plainTranslate } from "@/lib/assistant/chips";
import { changedElsewhereText } from "@/lib/utils/changedElsewhereText";
import type { SaveConflict } from "@/lib/utils/revisionedSaver";

const now = Date.parse("2026-10-25T09:14:03Z");
const conflict: SaveConflict = {
  id: "wf-1",
  revision: 5,
  updatedAt: "2026-10-25T09:12:03+00:00",
  updatedBy: { id: "user-2", firstname: "Ada", lastname: "Lovelace", avatar: null },
};

const en = plainTranslate(commonT("en"));
const de = plainTranslate(commonT("de"));

describe("changedElsewhereText", () => {
  it("names who changed the document and how long ago", () => {
    expect(changedElsewhereText(en, "workflow", conflict, "en", now)).toBe(
      "This workflow was changed elsewhere (by Ada Lovelace, 2 minutes ago)."
    );
    expect(changedElsewhereText(de, "workflow", conflict, "de", now)).toBe(
      "Dieser Workflow wurde an anderer Stelle geändert (von Ada Lovelace, vor 2 Minuten)."
    );
  });

  it("names the layout and the dashboard in their own words", () => {
    expect(changedElsewhereText(en, "report_layout", conflict, "en", now)).toBe(
      "This layout was changed elsewhere (by Ada Lovelace, 2 minutes ago)."
    );
    expect(changedElsewhereText(de, "dashboard", conflict, "de", now)).toBe(
      "Dieses Dashboard wurde an anderer Stelle geändert (von Ada Lovelace, vor 2 Minuten)."
    );
  });

  it("leaves the name out when nobody is recorded", () => {
    expect(changedElsewhereText(en, "workflow", { ...conflict, updatedBy: null }, "en", now)).toBe(
      "This workflow was changed elsewhere (2 minutes ago)."
    );
  });

  it("writes a time under a minute ago in lower case, inside the sentence", () => {
    const justNow = { ...conflict, updatedAt: "2026-10-25T09:14:00+00:00" };
    expect(changedElsewhereText(en, "workflow", justNow, "en", now)).toBe(
      "This workflow was changed elsewhere (by Ada Lovelace, just now)."
    );
    expect(changedElsewhereText(de, "workflow", justNow, "de", now)).toBe(
      "Dieser Workflow wurde an anderer Stelle geändert (von Ada Lovelace, gerade eben)."
    );
  });

  it("uses the first name alone when there is no last name", () => {
    const firstOnly = {
      ...conflict,
      updatedBy: { id: "user-2", firstname: "Ada", lastname: null, avatar: null },
    };
    expect(changedElsewhereText(en, "dashboard", firstOnly, "en", now)).toBe(
      "This dashboard was changed elsewhere (by Ada, 2 minutes ago)."
    );
  });

  it("says only that it changed when the time is unknown", () => {
    expect(
      changedElsewhereText(en, "workflow", { ...conflict, updatedAt: null, updatedBy: null }, "en", now)
    ).toBe("This workflow was changed elsewhere.");
  });
});
