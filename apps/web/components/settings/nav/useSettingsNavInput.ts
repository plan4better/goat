"use client";

import { useOrganizationMembers } from "@/lib/api/organizations";
import { useCreditBalance } from "@/lib/api/usage";
import { useFeatures, useOrganization, useUserProfile } from "@/lib/api/users";
import { ASSISTANT_BASE_URL } from "@/lib/constants";
import type { Organization } from "@/lib/validations/organization";

import { useOrganizationId } from "@/hooks/settings/useOrganizationId";

import {
  type SettingsNavInput,
  isOrgAdminRole,
  whiteLabelEnabled,
} from "@/components/settings/nav/settingsNav";
import { quotaNeedsAttention } from "@/components/settings/usage/quotaLevels";

/**
 * What the settings shell needs besides the path. The Mitglieder badge and the
 * Nutzung dot reuse the pages' SWR keys (members without invitations, as
 * Organisation › Profil reads them; the balance, as Nutzung reads it), only
 * for owners and admins, and never hold the nav back. `isError`: the profile,
 * the features or the organization failed, so what they leave unknown stays
 * unknown (the badge and the dot draw no skeleton, so theirs do not count).
 */
export function useSettingsNavInput(): {
  input: Omit<SettingsNavInput, "pathname" | "phone">;
  organization: Organization | undefined;
  memberCount: number | undefined;
  needsAttention: boolean;
  isError: boolean;
} {
  const { userProfile, isError: profileError } = useUserProfile();
  const { features, isError: featuresError } = useFeatures();
  const { organization, isError: organizationError } = useOrganization();
  const organizationId = useOrganizationId();
  const roles = userProfile?.roles;
  const admin = isOrgAdminRole(roles);
  const { members } = useOrganizationMembers(admin && organizationId ? organizationId : "");
  const { balance } = useCreditBalance(admin && features?.billing === true);

  return {
    input: {
      roles,
      features: { billing: features?.billing, whiteLabel: whiteLabelEnabled(organization) },
      assistant: Boolean(ASSISTANT_BASE_URL),
    },
    organization,
    memberCount: members
      ? members.filter((member) => member.invitation_status !== "pending").length
      : undefined,
    needsAttention: quotaNeedsAttention(balance),
    isError: Boolean(profileError || featuresError || organizationError),
  };
}
