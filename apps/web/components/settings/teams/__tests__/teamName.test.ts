import { describe, expect, it } from "vitest";

import { teamFormSchema } from "@/components/settings/teams/teamName";

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
