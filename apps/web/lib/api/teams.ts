import useSWR from "swr";

import { apiErrorOf } from "@/lib/api/apiError";
import { apiRequestAuth, fetcher } from "@/lib/api/fetcher";
import { useAuthedSWR } from "@/lib/api/useAuthedSWR";
import { API_BASE_URL } from "@/lib/constants";
import { organizationRoles } from "@/lib/validations/organization";
import type { Team, TeamBase, TeamMember, TeamUpdate } from "@/lib/validations/team";

export const TEAMS_API_BASE_URL = new URL("api/v2/teams", API_BASE_URL).href;

export type TeamsScope = "mine" | "organization";

/** Which list the settings pages read: every team of the organization for its
 * owners and admins, the caller's own teams for everyone else; undefined while
 * the roles load (ask for nothing yet rather than for the wrong list). */
export const teamsScopeOf = (orgRoles: readonly string[] | undefined): TeamsScope | undefined => {
  if (orgRoles === undefined) return undefined;
  return orgRoles.includes(organizationRoles.OWNER) || orgRoles.includes(organizationRoles.ADMIN)
    ? "organization"
    : "mine";
};

// Hooks

/** `GET /teams`: the caller's teams (`mine`, what the share dialogs, Home and
 * the share notice read; its key stays the bare URL so they share one cache
 * entry), or every team of the organization (`organization`, owners and admins). */
export const useTeams = ({
  scope = "mine",
  enabled = true,
}: { scope?: TeamsScope; enabled?: boolean } = {}) => {
  const key = scope === "organization" ? `${TEAMS_API_BASE_URL}?scope=organization` : `${TEAMS_API_BASE_URL}`;
  const { data, isLoading, error, mutate, isValidating } = useAuthedSWR<Team[]>(
    enabled ? key : null,
    fetcher
  );
  return {
    teams: data ?? [],
    isLoading,
    isError: error,
    mutate,
    isValidating,
  };
};

export const useTeam = (teamId: string) => {
  const { data, isLoading, error, mutate, isValidating } = useSWR<Team>(
    teamId ? `${TEAMS_API_BASE_URL}/${teamId}` : null,
    fetcher
  );
  return {
    team: data,
    isLoading,
    isError: error,
    mutate,
    isValidating,
  };
};

export const useTeamMembers = (teamId: string) => {
  const { data, isLoading, error, mutate, isValidating } = useSWR<TeamMember[] | null>(
    teamId ? `${TEAMS_API_BASE_URL}/${teamId}/members` : null,
    fetcher
  );
  return {
    // Core answers null to a caller who may not read the team's members.
    teamMembers: data ?? [],
    isLoading,
    isError: error,
    mutate,
    isValidating,
  };
};

// Mutations

export const createTeam = async (payload: TeamBase) => {
  const response = await apiRequestAuth(`${TEAMS_API_BASE_URL}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw await apiErrorOf(response);
  return await response.json();
};

export const updateTeam = async (teamId: string, organization: TeamUpdate) => {
  const response = await apiRequestAuth(`${TEAMS_API_BASE_URL}/${teamId}/profile`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(organization),
  });
  if (!response.ok) throw await apiErrorOf(response);
  return response;
};

export const deleteTeam = async (teamId: string) => {
  const response = await apiRequestAuth(`${TEAMS_API_BASE_URL}/${teamId}`, {
    method: "DELETE",
  });
  if (!response.ok) throw await apiErrorOf(response);
  return await response.json();
};

export const deleteMember = async (teamId: string, memberId: string) => {
  const response = await apiRequestAuth(`${TEAMS_API_BASE_URL}/${teamId}/users/${memberId}`, {
    method: "DELETE",
  });
  if (!response.ok) throw await apiErrorOf(response);
  return response;
};

export const createTeamMember = async (teamId: string, memberId: string) => {
  const response = await apiRequestAuth(`${TEAMS_API_BASE_URL}/${teamId}/users/${memberId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });
  if (!response.ok) throw await apiErrorOf(response);
  return await response.json();
};

/** Make a member the team's owner (core B7); answers the team's members. Core
 * refuses with 400 for someone outside the team or a Betrachter, 403 for a
 * caller who does not manage the team, and 409 when the person left the team
 * meanwhile. */
export const changeTeamOwner = async (teamId: string, userId: string): Promise<TeamMember[]> => {
  const response = await apiRequestAuth(`${TEAMS_API_BASE_URL}/${teamId}/owner`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user_id: userId }),
  });
  if (!response.ok) throw await apiErrorOf(response);
  return await response.json();
};
