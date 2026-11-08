import { describe, expect, it } from "vitest";

import {
  type SettingsNavGroup,
  type SettingsNavInput,
  settingsNav,
  settingsPageAllowed,
  whiteLabelEnabled,
} from "@/components/settings/nav/settingsNav";

const ROLES = {
  owner: ["organization-owner"],
  admin: ["organization-admin"],
  editor: ["organization-editor"],
  viewer: ["organization-viewer"],
} as const;

const input = (over: Partial<SettingsNavInput> = {}): SettingsNavInput => ({
  pathname: "/settings/profile",
  roles: ROLES.owner,
  features: { billing: true, whiteLabel: true },
  assistant: true,
  phone: false,
  ...over,
});

/** The rows of each group as keys, skeletons marked with a trailing "~". */
const shape = (groups: SettingsNavGroup[]) =>
  Object.fromEntries(
    groups.map((group) => [group.key, group.items.map((item) => (item.skeleton ? `${item.key}~` : item.key))])
  );

describe("settingsNav", () => {
  it("gives every role and setting the rows of the spec's table", () => {
    for (const role of Object.keys(ROLES) as (keyof typeof ROLES)[]) {
      for (const billing of [true, false]) {
        for (const assistant of [true, false]) {
          for (const whiteLabel of [true, false]) {
            for (const phone of [false, true]) {
              const admin = role === "owner" || role === "admin";
              const expected = {
                account: ["profile", "preferences"],
                organization: [
                  "organization",
                  ...(admin ? ["members"] : []),
                  "teams",
                  ...(admin && whiteLabel ? (phone ? ["domains", "analytics"] : ["whiteLabel"]) : []),
                  ...(admin && assistant ? ["ai"] : []),
                  ...(admin && billing ? ["usage"] : []),
                ],
              };
              const groups = settingsNav(
                input({ roles: ROLES[role], features: { billing, whiteLabel }, assistant, phone })
              );
              expect(
                shape(groups),
                `${role} billing=${billing} ai=${assistant} wl=${whiteLabel} phone=${phone}`
              ).toEqual(expected);
            }
          }
        }
      }
    }
  });

  it("draws the rows every role has at once, and skeletons for the admin rows until the roles are known", () => {
    expect(
      shape(settingsNav(input({ roles: undefined, features: { billing: undefined, whiteLabel: undefined } })))
    ).toEqual({
      account: ["profile", "preferences"],
      organization: ["organization", "members~", "teams", "whiteLabel~", "ai~", "usage~"],
    });
    // What is known already brings no skeleton: billing off, no assistant.
    expect(
      shape(
        settingsNav(
          input({ roles: undefined, features: { billing: false, whiteLabel: undefined }, assistant: false })
        )
      )
    ).toEqual({
      account: ["profile", "preferences"],
      organization: ["organization", "members~", "teams", "whiteLabel~"],
    });
  });

  it("keeps an admin's White Label and Nutzung rows as skeletons until the organization and the features answer", () => {
    expect(
      shape(settingsNav(input({ features: { billing: undefined, whiteLabel: undefined } }))).organization
    ).toEqual(["organization", "members", "teams", "whiteLabel~", "ai", "usage~"]);
  });

  it("marks Teams current on a team's page and opens White Label while a child is current", () => {
    const teams = settingsNav(input({ pathname: "/settings/teams/abc" }))[1].items.find(
      (item) => item.key === "teams"
    );
    expect(teams?.current).toBe(true);
    const whiteLabel = settingsNav(input({ pathname: "/settings/domains" }))[1].items.find(
      (item) => item.key === "whiteLabel"
    );
    expect(whiteLabel?.containsCurrent).toBe(true);
    expect(whiteLabel?.children?.find((child) => child.key === "domains")?.current).toBe(true);
    const phoneDomains = settingsNav(input({ pathname: "/settings/domains", phone: true }))[1].items.find(
      (item) => item.key === "domains"
    );
    expect(phoneDomains).toMatchObject({ current: true, groupLabelKey: "settings_nav_group_white_label" });
  });

  it("links every row to its leaf page", () => {
    const hrefs = settingsNav(input()).flatMap((group) =>
      group.items.flatMap((item) => [item, ...(item.children ?? [])]).map((item) => item.href)
    );
    expect(hrefs.filter(Boolean)).toEqual([
      "/settings/profile",
      "/settings/preferences",
      "/settings/organization",
      "/settings/members",
      "/settings/teams",
      "/settings/domains",
      "/settings/analytics",
      "/settings/ai",
      "/settings/usage",
    ]);
  });

  it("lets a skeleton row name the current page, so the phone button reads it while the roles load", () => {
    const current = (pathname: string) =>
      settingsNav(input({ pathname, roles: undefined, phone: true }))
        .flatMap((group) => group.items)
        .find((item) => item.current);
    expect(current("/settings/members")).toMatchObject({
      key: "members",
      skeleton: true,
      labelKey: "settings_nav_members",
      groupLabelKey: "settings_nav_group_organization",
    });
    expect(current("/settings/members")?.icon).toBeDefined();
    expect(current("/settings/members")?.href).toBeUndefined();
    expect(current("/settings/domains")).toMatchObject({
      key: "whiteLabel",
      skeleton: true,
      labelKey: "settings_nav_domains",
      groupLabelKey: "settings_nav_group_white_label",
    });
    expect(current("/settings/usage")).toMatchObject({
      key: "usage",
      skeleton: true,
      labelKey: "settings_nav_usage",
    });
  });

  it("draws no skeleton for what a failed request left unknown, and keeps the rows every role has", () => {
    expect(
      shape(
        settingsNav(
          input({ roles: undefined, features: { billing: undefined, whiteLabel: undefined }, failed: true })
        )
      )
    ).toEqual({
      account: ["profile", "preferences"],
      organization: ["organization", "teams"],
    });
    // An admin whose organization failed: White Label goes, what is known stays.
    expect(
      shape(settingsNav(input({ features: { billing: true, whiteLabel: undefined }, failed: true })))
        .organization
    ).toEqual(["organization", "members", "teams", "ai", "usage"]);
  });
});

describe("whiteLabelEnabled", () => {
  it("reads the feature from the organization's extras; null extras (self-hosted) means every feature", () => {
    expect(whiteLabelEnabled(undefined)).toBeUndefined();
    expect(whiteLabelEnabled({ extras: null })).toBe(true);
    expect(whiteLabelEnabled({ extras: ["white_label"] })).toBe(true);
    expect(whiteLabelEnabled({ extras: [] })).toBe(false);
  });
});

describe("settingsPageAllowed", () => {
  const known = (role: keyof typeof ROLES, over: Partial<SettingsNavInput> = {}) => ({
    roles: ROLES[role],
    features: { billing: true, whiteLabel: true },
    assistant: true,
    ...over,
  });

  it("opens the pages every role has to everyone", () => {
    for (const path of [
      "/settings/profile",
      "/settings/preferences",
      "/settings/organization",
      "/settings/teams",
      "/settings/teams/abc",
    ]) {
      expect(settingsPageAllowed(path, known("viewer")), path).toBe(true);
    }
  });

  it("refuses the admin pages to editors and viewers, and only once the roles are known", () => {
    for (const path of [
      "/settings/members",
      "/settings/domains",
      "/settings/analytics",
      "/settings/ai",
      "/settings/usage",
    ]) {
      expect(settingsPageAllowed(path, known("editor")), path).toBe(false);
      expect(settingsPageAllowed(path, known("owner")), path).toBe(true);
      expect(settingsPageAllowed(path, { ...known("owner"), roles: undefined }), path).toBeUndefined();
    }
  });

  it("never refuses a page because a request failed", () => {
    for (const path of [
      "/settings/members",
      "/settings/domains",
      "/settings/analytics",
      "/settings/ai",
      "/settings/usage",
    ]) {
      const failed = {
        ...known("owner"),
        roles: undefined,
        features: { billing: undefined, whiteLabel: undefined },
        failed: true,
      };
      expect(settingsPageAllowed(path, failed), path).toBeUndefined();
    }
  });

  it("refuses White Label without the feature, KI without the assistant and Nutzung without billing", () => {
    expect(
      settingsPageAllowed(
        "/settings/domains",
        known("admin", { features: { billing: true, whiteLabel: false } })
      )
    ).toBe(false);
    expect(
      settingsPageAllowed(
        "/settings/analytics",
        known("admin", { features: { billing: true, whiteLabel: undefined } })
      )
    ).toBeUndefined();
    expect(settingsPageAllowed("/settings/ai", known("admin", { assistant: false }))).toBe(false);
    expect(
      settingsPageAllowed(
        "/settings/usage",
        known("admin", { features: { billing: false, whiteLabel: true } })
      )
    ).toBe(false);
  });
});
