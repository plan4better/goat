import useSWR from "swr";

import { apiErrorOf } from "@/lib/api/apiError";
import { apiRequestAuth, fetcher } from "@/lib/api/fetcher";
import { useAuthedSWR } from "@/lib/api/useAuthedSWR";
import { API_BASE_URL } from "@/lib/constants";
import type { Team, TeamBase, TeamMember, TeamUpdate } from "@/lib/validations/team";

export const TEAMS_API_BASE_URL = new URL("api/v2/teams", API_BASE_URL).href;

// Hooks

export const useTeams = () => {
  const { data, isLoading, error, mutate, isValidating } = useAuthedSWR<Team[]>(
    `${TEAMS_API_BASE_URL}`,
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
  const { data, isLoading, error, mutate, isValidating } = useSWR<TeamMember[]>(
    teamId ? `${TEAMS_API_BASE_URL}/${teamId}/members` : null,
    fetcher
  );
  return {
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
