import useSWR, { mutate } from "swr";

import { apiErrorOf } from "@/lib/api/apiError";
import { apiRequestAuth, fetcher } from "@/lib/api/fetcher";
import type {
  InvitationCreate,
  Organization,
  OrganizationMember,
  OrganizationMemberQueryParams,
  OrganizationUpdate,
  PostOrganization,
} from "@/lib/validations/organization";

export const ORG_API_BASE_URL = new URL("api/v2/organizations", process.env.NEXT_PUBLIC_API_URL)
  .href;

export const useOrganizationMembers = (organizationId: string, queryParams?: OrganizationMemberQueryParams) => {
  const { data, isLoading, error, mutate, isValidating } = useSWR<OrganizationMember[]>(
    () => (organizationId ? [`${ORG_API_BASE_URL}/${organizationId}/users`, queryParams] : null),

    fetcher
  );
  return {
    members: data,
    isLoading: isLoading,
    isError: error,
    mutate,
    isValidating,
  };
};

/** SWR key matcher for an organization's member lists, with invitations
 * (Mitglieder) and without (the settings nav's count, Organisation › Profil). */
export const matchesOrganizationMembersKey =
  (organizationId: string) =>
  (key: unknown): boolean =>
    Array.isArray(key) && key[0] === `${ORG_API_BASE_URL}/${organizationId}/users`;

/** Reads every member list of the organization again: after a role change, a
 * removal, a withdrawn or a new invitation. */
export const refreshOrganizationMembers = (organizationId: string) =>
  mutate(matchesOrganizationMembersKey(organizationId));

export const createOrganization = async (payload: PostOrganization): Promise<Organization> => {
  const response = await apiRequestAuth(`${ORG_API_BASE_URL}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error("Failed to create folder");
  }
  return await response.json();
};

export const updateOrganization = async (organization_id: string, organization: OrganizationUpdate) => {
  const response = await apiRequestAuth(`${ORG_API_BASE_URL}/${organization_id}/profile`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(organization),
  });
  if (!response.ok) throw await response.json();
  return response;
};

export const deleteOrganization = async (organization_id: string) => {
  const response = await apiRequestAuth(`${ORG_API_BASE_URL}/${organization_id}`, {
    method: "DELETE",
  });
  if (!response.ok) throw await response.json();
  return response;
};

/** Removes a member. `reassignTo` receives what they own in their personal
 * space; core needs it only when there is something to hand over and
 * ignores it otherwise (F4), so the dialog always sends it. */
export const deleteMember = async (organization_id: string, user_id: string, reassignTo?: string) => {
  const query = reassignTo ? `?${new URLSearchParams({ reassign_to: reassignTo })}` : "";
  const response = await apiRequestAuth(`${ORG_API_BASE_URL}/${organization_id}/users/${user_id}${query}`, {
    method: "DELETE",
  });
  if (!response.ok) throw await apiErrorOf(response);
  return response;
};

export const updateOrganizationMemberRole = async (
  organization_id: string,
  user_id: string,
  role: string
) => {
  const response = await apiRequestAuth(`${ORG_API_BASE_URL}/${organization_id}/users/${user_id}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ role }),
  });
  if (!response.ok) throw await apiErrorOf(response);
  return response;
};

export const updateOrganizationInvitationRole = async (
  organization_id: string,
  invitation_id: string,
  role: string
) => {
  const response = await apiRequestAuth(
    `${ORG_API_BASE_URL}/${organization_id}/invitations/${invitation_id}/role`,
    {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ role }),
    }
  );
  if (!response.ok) throw await apiErrorOf(response);
  return response;
};

export const deleteInvitation = async (organization_id: string, invitation_id: string) => {
  const response = await apiRequestAuth(
    `${ORG_API_BASE_URL}/${organization_id}/invitations/${invitation_id}`,
    {
      method: "DELETE",
    }
  );
  if (!response.ok) throw await apiErrorOf(response);
  return response;
};

export const updateMember = async (organization_id: string, user_id: string, role: string) => {
  const response = await apiRequestAuth(`${ORG_API_BASE_URL}/${organization_id}/users/${user_id}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ role }),
  });
  if (!response.ok) throw await response.json();
  return response;
};

export const inviteMember = async (organization_id: string, invitation: InvitationCreate) => {
  const response = await apiRequestAuth(`${ORG_API_BASE_URL}/${organization_id}/invitations`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(invitation),
  });
  if (!response.ok) throw await apiErrorOf(response);
  return response;
};
