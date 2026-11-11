"use client";

import { useOrganizationMembers } from "@/lib/api/organizations";
import { useFeatures, useOrganization, useUserProfile } from "@/lib/api/users";
import { ASSISTANT_BASE_URL } from "@/lib/constants";

import { useOrganizationId } from "@/hooks/settings/useOrganizationId";

import {
  type SettingsNavInput,
  isOrgAdminRole,
  whiteLabelEnabled,
} from "@/components/settings/nav/settingsNav";

/**
 * What the settings shell needs besides the path. The Mitglieder badge reuses
 * the page's SWR key (members without invitations, as Organisation › Profil
 * reads them), only for owners and admins, and never holds the nav back.
 * `isError`: the profile, the features or the organization failed, so what
 * they leave unknown stays unknown (the badge draws no skeleton, so its
 * request does not count).
 */
export function useSettingsNavInput(): {
  input: Omit<SettingsNavInput, "pathname" | "phone">;
  memberCount: number | undefined;
  isError: boolean;
} {
  const { userProfile, isError: profileError } = useUserProfile();
  const { features, isError: featuresError } = useFeatures();
  const { organization, isError: organizationError } = useOrganization();
  const organizationId = useOrganizationId();
  const roles = userProfile?.roles;
  const admin = isOrgAdminRole(roles);
  const { members } = useOrganizationMembers(admin && organizationId ? organizationId : "");

  return {
    input: {
      roles,
      features: { billing: features?.billing, whiteLabel: whiteLabelEnabled(organization) },
      assistant: Boolean(ASSISTANT_BASE_URL),
    },
    memberCount: members
      ? members.filter((member) => member.invitation_status !== "pending").length
      : undefined,
    isError: Boolean(profileError || featuresError || organizationError),
  };
}
