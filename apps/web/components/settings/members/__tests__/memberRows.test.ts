import { describe, expect, it } from "vitest";

import type { OrganizationMember } from "@/lib/validations/organization";

import { filterMemberRows, sortMemberRows, toMemberRows } from "@/components/settings/members/memberRows";

const member = (id: string, firstname: string, role: string, pending = false): OrganizationMember => ({
  id,
  firstname,
  lastname: "",
  email: `${id}@example.com`,
  roles: [role],
  invitation_status: pending ? "pending" : "accepted",
  avatar: "",
});

const MEMBERS = [
  member("v1", "Vera", "organization-viewer"),
  member("e1", "Emil", "organization-editor"),
  member("o1", "Otto", "organization-owner"),
  member("i1", "", "organization-editor", true),
  member("a1", "Ada", "organization-admin"),
  member("e2", "Berta", "organization-editor"),
];
const collator = new Intl.Collator("de");
const ids = (rows: { id: string }[]) => rows.map((row) => row.id);

describe("member rows", () => {
  it("names an invitation and a nameless account by the address and marks one's own row", () => {
    const rows = toMemberRows(MEMBERS, "a1");
    expect(rows.find((row) => row.id === "i1")).toMatchObject({
      name: "i1@example.com",
      pending: true,
      role: "organization-editor",
    });
    expect(rows.find((row) => row.id === "a1")?.isSelf).toBe(true);
  });

  it("sorts by role from owner to viewer, members before invitations, then by name", () => {
    expect(ids(sortMemberRows(toMemberRows(MEMBERS, "a1"), { key: "role", dir: "asc" }, collator))).toEqual([
      "o1",
      "a1",
      "e2",
      "e1",
      "i1",
      "v1",
    ]);
  });

  it("sorts by name both ways", () => {
    const rows = toMemberRows(MEMBERS, undefined);
    expect(ids(sortMemberRows(rows, { key: "member", dir: "asc" }, collator))).toEqual([
      "a1",
      "e2",
      "e1",
      "i1",
      "o1",
      "v1",
    ]);
    expect(ids(sortMemberRows(rows, { key: "member", dir: "desc" }, collator))[0]).toBe("v1");
  });

  it("filters by role, by seat pool, by status and by name or address", () => {
    const rows = toMemberRows(MEMBERS, undefined);
    const all = { query: "", role: "all" as const, status: "all" as const };
    expect(ids(filterMemberRows(rows, { ...all, role: "admins" }))).toEqual(["o1", "a1"]);
    expect(ids(filterMemberRows(rows, { ...all, role: "editorSeats" }))).toEqual([
      "e1",
      "o1",
      "i1",
      "a1",
      "e2",
    ]);
    expect(ids(filterMemberRows(rows, { ...all, status: "pending" }))).toEqual(["i1"]);
    expect(ids(filterMemberRows(rows, { ...all, status: "members", role: "editors" }))).toEqual(["e1", "e2"]);
    expect(ids(filterMemberRows(rows, { ...all, query: "BERT" }))).toEqual(["e2"]);
    expect(ids(filterMemberRows(rows, { ...all, query: "i1@ex" }))).toEqual(["i1"]);
  });

  it("carries the dates core sends", () => {
    const [row] = toMemberRows(
      [
        {
          ...member("i9", "", "organization-viewer", true),
          invited_at: "2026-10-01T08:00:00",
          last_sent_at: "2026-10-30T12:00:00",
          expires_at: null,
        },
      ],
      undefined
    );
    expect(row).toMatchObject({
      invitedAt: "2026-10-01T08:00:00",
      lastSentAt: "2026-10-30T12:00:00",
      joinedAt: null,
    });
  });

  it("carries a member's join date, and no dates where core sends none", () => {
    const [joined, older] = toMemberRows(
      [
        { ...member("e9", "Eva", "organization-editor"), joined_at: "2024-03-05T09:30:00" },
        member("v9", "Vito", "organization-viewer"),
      ],
      undefined
    );
    expect(joined).toMatchObject({ joinedAt: "2024-03-05T09:30:00", invitedAt: null, lastSentAt: null });
    expect(older).toMatchObject({ joinedAt: null, invitedAt: null, lastSentAt: null });
  });
});
