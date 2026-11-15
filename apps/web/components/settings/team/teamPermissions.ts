import { isOrgAdminRole } from "@/components/settings/nav/settingsNav";

export interface TeamPermissions {
  isTeamOwner: boolean;
  isMember: boolean;
  /** Rename, picture, delete: the team's owner with Bearbeiter or higher
   * (update-team and delete-team come with organization-editor), or an
   * organization owner or admin. */
  canEditTeam: boolean;
  /** Add and remove members: the team's owner; organization owners and admins from phase 2. */
  canManageMembers: boolean;
  /** Every member who is not the team's owner. */
  canLeave: boolean;
}

/** Phase 1: organization owners and admins act only in teams they are in
 * (core reads teams by membership, F3); phase 2 passes `adminsManageAllTeams`. */
export const teamPermissions = (
  { teamRole, orgRoles }: { teamRole: string | null | undefined; orgRoles: readonly string[] | undefined },
  { adminsManageAllTeams = false }: { adminsManageAllTeams?: boolean } = {}
): TeamPermissions => {
  const isTeamOwner = teamRole === "team-owner";
  const isMember = !!teamRole;
  const orgAdmin = isOrgAdminRole(orgRoles);
  const editorOrUp = orgAdmin || !!orgRoles?.includes("organization-editor");
  return {
    isTeamOwner,
    isMember,
    canEditTeam: (isTeamOwner && editorOrUp) || (orgAdmin && (isMember || adminsManageAllTeams)),
    canManageMembers: isTeamOwner || (orgAdmin && adminsManageAllTeams),
    canLeave: isMember && !isTeamOwner,
  };
};
