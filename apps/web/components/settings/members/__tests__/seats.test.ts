import { describe, expect, it } from "vitest";

import { commonT } from "@/i18n/__tests__/commonI18n";

import { inviteRoleState, roleOptions, seatLevel, seatsOf } from "@/components/settings/members/seats";

const t = commonT("de");
const org = (
  used_editors: number,
  total_editors: number | null,
  used_viewers: number,
  total_viewers: number | null
) => seatsOf({ used_editors, total_editors, used_viewers, total_viewers });
const reasons = (options: ReturnType<typeof roleOptions>) =>
  Object.fromEntries(options.map((option) => [option.role, option.disabledReason ?? null]));

describe("seatsOf", () => {
  it("counts free seats, and none for a pool without a limit", () => {
    expect(org(3, 5, 0, null)).toEqual({
      editors: { used: 3, total: 5, free: 2 },
      viewers: { used: 0, total: null, free: null },
    });
  });

  it("never counts below zero free seats when a pool is over its limit", () => {
    expect(org(6, 5, 0, 0).editors.free).toBe(0);
  });
});

describe("seatLevel", () => {
  it("is full once every seat is taken, not at 90 %, and over beyond the limit", () => {
    expect(seatLevel(org(9, 10, 0, null).editors)).toBe("ok");
    expect(seatLevel(org(10, 10, 0, null).editors)).toBe("full");
    expect(seatLevel(org(11, 10, 0, null).editors)).toBe("over");
  });

  it("leaves a pool without a limit, and a pool of no seats that nobody uses, alone", () => {
    expect(seatLevel(org(40, null, 0, null).editors)).toBe("ok");
    expect(seatLevel(org(1, 5, 0, 0).viewers)).toBe("ok");
    expect(seatLevel(org(1, 5, 2, 0).viewers)).toBe("over");
  });
});

describe("roleOptions", () => {
  it("disables the editor roles for a viewer while every editor seat is taken", () => {
    expect(reasons(roleOptions("organization-viewer", org(5, 5, 1, 10), t))).toEqual({
      "organization-admin": "Kein Bearbeiter-Platz frei",
      "organization-editor": "Kein Bearbeiter-Platz frei",
      "organization-viewer": null,
    });
  });

  it("keeps an editor seat free by one: exactly full is full, one under is not", () => {
    expect(
      reasons(roleOptions("organization-viewer", org(4, 5, 1, 10), t))["organization-editor"]
    ).toBeNull();
  });

  it("refuses editor and admin swaps while the editor pool is full in phase 1 (F7), not when told otherwise", () => {
    expect(reasons(roleOptions("organization-editor", org(5, 5, 1, 10), t))["organization-admin"]).toBe(
      "Kein Bearbeiter-Platz frei"
    );
    expect(
      reasons(roleOptions("organization-editor", org(5, 5, 1, 10), t, { swapNeedsSeat: false }))[
        "organization-admin"
      ]
    ).toBeNull();
  });

  it("needs a viewer seat to make someone a viewer", () => {
    expect(reasons(roleOptions("organization-admin", org(2, 5, 10, 10), t))["organization-viewer"]).toBe(
      "Kein Betrachter-Platz frei"
    );
  });

  it("disables nothing where the pools have no limit", () => {
    for (const current of ["organization-admin", "organization-editor", "organization-viewer"] as const) {
      expect(Object.values(reasons(roleOptions(current, org(40, null, 90, null), t)))).toEqual([
        null,
        null,
        null,
      ]);
    }
  });
});

describe("inviteRoleState", () => {
  it("opens a role only while its pool has a seat for every address", () => {
    expect(inviteRoleState(org(3, 5, 0, null), 3)).toEqual({
      editorsOk: false,
      viewersOk: true,
      defaultRole: "organization-editor",
    });
    expect(inviteRoleState(org(3, 5, 0, null), 2).editorsOk).toBe(true);
  });

  it("defaults to viewer once every editor seat is taken", () => {
    expect(inviteRoleState(org(5, 5, 0, 3), 1).defaultRole).toBe("organization-viewer");
  });
});
