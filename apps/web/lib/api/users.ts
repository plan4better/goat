import useSWR, { type SWRConfiguration } from "swr";

import { apiRequestAuth, fetcher } from "@/lib/api/fetcher";
import { useAuthedSWR } from "@/lib/api/useAuthedSWR";
import { API_BASE_URL } from "@/lib/constants";
import type { InvitationPaginated } from "@/lib/validations/invitation";
import type { Features, Organization, OrganizationCreation } from "@/lib/validations/organization";
import type { GetInvitationsQueryParams, User, UserUpdate } from "@/lib/validations/user";

export const USERS_API_BASE_URL = new URL("api/v2/users", API_BASE_URL).href;

// Hooks

export const useOrganization = (config?: SWRConfiguration<Organization>) => {
  const { data, isLoading, error, mutate, isValidating } = useAuthedSWR<Organization>(
    `${USERS_API_BASE_URL}/organization`,
    fetcher,
    config
  );
  return {
    organization: data,
    isLoading,
    isError: error,
    mutate,
    isValidating,
  };
};

// Support and billing are switched on per installation; a self-hosted GOAT
// runs neither and shows none of their pages. Rarely changes: no revalidation.
export const useFeatures = () => {
  const { data, isLoading, error } = useAuthedSWR<Features>(`${USERS_API_BASE_URL}/me/features`, fetcher, {
    revalidateOnFocus: false,
    revalidateIfStale: false,
  });
  return { features: data, isLoading, isError: error };
};

export const useOrganizationCreation = () => {
  const { data, isLoading, error, mutate, isValidating } = useAuthedSWR<OrganizationCreation>(
    `${USERS_API_BASE_URL}/me/organization-creation`,
    fetcher
  );
  return {
    organizationCreation: data,
    isLoading,
    isError: error,
    mutate,
    isValidating,
  };
};

export const useUserProfile = () => {
  const { data, isLoading, error, mutate, isValidating } = useAuthedSWR<User>(
    `${USERS_API_BASE_URL}/profile`,
    fetcher
  );
  return {
    userProfile: data,
    isLoading,
    isError: error,
    mutate,
    isValidating,
  };
};

export const useInvitations = (queryParams?: GetInvitationsQueryParams) => {
  const { data, isLoading, error, mutate, isValidating } = useSWR<InvitationPaginated>(
    [`${USERS_API_BASE_URL}/invitations`, queryParams],
    fetcher
  );
  return {
    invitations: data,
    isLoading,
    isError: error,
    mutate,
    isValidating,
  };
};

// Mutations

export const updateUserProfile = async (user: UserUpdate) => {
  const response = await apiRequestAuth(`${USERS_API_BASE_URL}/profile`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(user),
  });
  if (!response.ok) throw await response.json();
  return response;
};

export const acceptInvitation = async (invitationId: string) => {
  const response = await apiRequestAuth(`${USERS_API_BASE_URL}/invitations/${invitationId}`, {
    method: "PATCH",
  });
  if (!response.ok) throw await response.json();
  return response;
};

export const declineInvitation = async (invitationId: string) => {
  const response = await apiRequestAuth(`${USERS_API_BASE_URL}/invitations/${invitationId}`, {
    method: "DELETE",
  });
  if (!response.ok) throw await response.json();
  return response;
};

export const deleteAccount = async () => {
  const response = await apiRequestAuth(`${USERS_API_BASE_URL}`, { method: "DELETE" });
  if (!response.ok) throw await response.json();
  return response;
};
