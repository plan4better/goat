import { describe, expect, it } from "vitest";

import { isOwnerless, teamFormSchema } from "@/components/settings/teams/teamName";

describe("teamFormSchema", () => {
  const schema = teamFormSchema(["Stadtplanung", "Verkehr"]);

  it("takes a new name, trimmed", () => {
    expect(schema.parse({ name: "  Umwelt ", description: "" })).toEqual({ name: "Umwelt", description: "" });
  });

  it("refuses a name the caller sees already, whatever its case and spaces", () => {
    const result = schema.safeParse({ name: " stadtPLANUNG ", description: "" });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0].message).toBe("settings_teams_name_taken");
  });

  it("refuses an empty name, more than 50 characters and a description over 250", () => {
    expect(schema.safeParse({ name: "   ", description: "" }).error?.issues[0].message).toBe(
      "settings_teams_name_required"
    );
    expect(schema.safeParse({ name: "x".repeat(51), description: "" }).success).toBe(false);
    expect(schema.safeParse({ name: "Umwelt", description: "x".repeat(251) }).error?.issues[0].message).toBe(
      "settings_teams_description_too_long"
    );
  });
});

describe("teamFormSchema with the team's own name", () => {
  // Another team shares the name: a duplicate from before core checked names.
  const schema = teamFormSchema(["Stadtplanung", "Verkehr"], "Stadtplanung");

  it("keeps the team's saved name valid, as core does for a name that does not change", () => {
    expect(schema.safeParse({ name: "Stadtplanung", description: "Neu" }).success).toBe(true);
    expect(schema.safeParse({ name: " Stadtplanung ", description: "" }).success).toBe(true);
  });

  it("still refuses another case of it, which core counts as a rename, and the other names", () => {
    expect(schema.safeParse({ name: "stadtplanung", description: "" }).error?.issues[0].message).toBe(
      "settings_teams_name_taken"
    );
    expect(schema.safeParse({ name: "verkehr", description: "" }).error?.issues[0].message).toBe(
      "settings_teams_name_taken"
    );
  });

  it("keeps a saved name over 50 characters valid while it does not change", () => {
    const long = "Stadtplanung und Verkehr im Landkreis Musterstadt-Nord";
    expect(long.length).toBeGreaterThan(50);
    const own = teamFormSchema([], long);
    expect(own.safeParse({ name: long, description: "Neu" }).success).toBe(true);
    expect(own.safeParse({ name: `${long}x`, description: "" }).error?.issues[0].message).toBe(
      "settings_teams_name_help"
    );
  });

  it("compares with the saved name as core does, without the spaces around it", () => {
    expect(
      teamFormSchema(["Stadtplanung"], " Stadtplanung ").safeParse({ name: "Stadtplanung", description: "" })
        .success
    ).toBe(true);
  });
});

describe("isOwnerless", () => {
  it("is true when the preview, owner first, starts without an owner or is empty", () => {
    expect(isOwnerless({ members_preview: [{ id: "u1", role: "team-member" }] })).toBe(true);
    expect(isOwnerless({ members_preview: [] })).toBe(true);
    expect(
      isOwnerless({
        members_preview: [
          { id: "u1", role: "team-owner" },
          { id: "u2", role: "team-member" },
        ],
      })
    ).toBe(false);
  });

  it("is false while the preview is unknown", () => {
    expect(isOwnerless({})).toBe(false);
  });
});
