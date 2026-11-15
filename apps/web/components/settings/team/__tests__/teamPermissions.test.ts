import { describe, expect, it } from "vitest";

import { teamPermissions } from "@/components/settings/team/teamPermissions";

const of = (teamRole: string | null, orgRole: string, adminsManageAllTeams = false) =>
  teamPermissions({ teamRole, orgRoles: [orgRole] }, { adminsManageAllTeams });

describe("teamPermissions", () => {
  it("lets a team owner who is an editor edit the team and manage its members, but not leave", () => {
    expect(of("team-owner", "organization-editor")).toMatchObject({
      canEditTeam: true,
      canManageMembers: true,
      canLeave: false,
    });
  });

  it("lets a team owner who is a viewer manage members only (no update-team or delete-team)", () => {
    expect(of("team-owner", "organization-viewer")).toMatchObject({
      canEditTeam: false,
      canManageMembers: true,
    });
  });

  it("lets an organization admin in the team edit it and leave it, but not manage its members in phase 1", () => {
    expect(of("team-member", "organization-admin")).toMatchObject({
      canEditTeam: true,
      canManageMembers: false,
      canLeave: true,
    });
  });

  it("gives a plain member only leaving", () => {
    expect(of("team-member", "organization-editor")).toEqual({
      isTeamOwner: false,
      isMember: true,
      canEditTeam: false,
      canManageMembers: false,
      canLeave: true,
    });
  });

  it("lets owners and admins manage every team once core allows it (phase 2)", () => {
    expect(of(null, "organization-owner", true)).toMatchObject({
      canEditTeam: true,
      canManageMembers: true,
      canLeave: false,
    });
    expect(of(null, "organization-owner", false)).toMatchObject({
      canEditTeam: false,
      canManageMembers: false,
    });
  });
});
