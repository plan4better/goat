import { useMemo } from "react";

import { useOrganization, useUserProfile } from "@/lib/api/users";
import type { FeatureName } from "@/lib/validations/organization";
import { organizationRoles } from "@/lib/validations/organization";
import { type Team, teamRoles } from "@/lib/validations/team";

interface Options {
  team?: Team;
}

export function useAuthZ(options: Options = {}) {
  const { userProfile, isLoading: isUserProfileLoading, isError: isUserProfileError } = useUserProfile();
  const { organization, isError: isOrganizationError } = useOrganization();
  const roles = userProfile?.roles;

  const isOrgAdmin = useMemo(() => {
    if (!roles) return false;
    return roles.includes(organizationRoles.OWNER) || roles.includes(organizationRoles.ADMIN);
  }, [roles]);

  const isOrgEditor = useMemo(() => {
    if (!roles) return false;
    return roles.includes(organizationRoles.EDITOR) || isOrgAdmin;
  }, [roles, isOrgAdmin]);

  const isTeamOwner = useMemo(() => {
    const { team } = options;
    if (!team || !roles) return false;
    return team.role === teamRoles.OWNER;
  }, [roles, options]);

  const isProjectEditor = useMemo(() => {
    return isOrgEditor;
  }, [isOrgEditor]);

  const isLoading = useMemo(() => {
    return isUserProfileLoading;
  }, [isUserProfileLoading]);

  const isAppFeatureEnabled = (feature: FeatureName) => {
    // extras: null/undefined = all features enabled (self-hosted),
    // otherwise the granted premium features.
    const extras = organization?.extras;
    if (extras === null || extras === undefined) {
      return !!organization;
    }
    return extras.includes(feature);
  };

  return {
    isUserProfileError,
    isOrganizationError,
    isLoading,
    isOrgAdmin,
    isOrgEditor,
    isTeamOwner,
    isProjectEditor,
    isAppFeatureEnabled,
  };
}
