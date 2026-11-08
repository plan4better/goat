import { describe, expect, it } from "vitest";

import { commonT } from "@/i18n/__tests__/commonI18n";

import { ORG_ROLE_ORDER, orgRoleOf, roleWords } from "@/components/settings/common/roleWords";

describe("roleWords", () => {
  it("gives each role its word and one line in German", () => {
    const words = roleWords(commonT("de"));
    expect(ORG_ROLE_ORDER.map((role) => words[role].word)).toEqual([
      "Eigentümer",
      "Admin",
      "Bearbeiter",
      "Betrachter",
    ]);
    expect(words["organization-viewer"].description).toBe(
      "Öffnet, was mit der Person geteilt wird. Belegt keinen Bearbeiter-Platz."
    );
  });

  it("gives the English words", () => {
    const words = roleWords(commonT("en"));
    expect(ORG_ROLE_ORDER.map((role) => words[role].word)).toEqual(["Owner", "Admin", "Editor", "Viewer"]);
  });

  it("reads the highest organization role from a list of roles", () => {
    expect(orgRoleOf(["team-member", "organization-editor"])).toBe("organization-editor");
    expect(orgRoleOf(["organization-viewer", "organization-admin"])).toBe("organization-admin");
    expect(orgRoleOf(["team-owner"])).toBeUndefined();
    expect(orgRoleOf(undefined)).toBeUndefined();
  });
});
