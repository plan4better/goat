"use client";

import { Box, Skeleton, Typography } from "@mui/material";
import { useTranslation } from "react-i18next";

import { useOrganizationMembers } from "@/lib/api/organizations";
import { useOrganization } from "@/lib/api/users";

import { useOrganizationId } from "@/hooks/settings/useOrganizationId";

import UserAvatar from "@/components/dashboard/common/UserAvatar";
import CardSkeleton from "@/components/settings/common/CardSkeleton";
import SettingsCard from "@/components/settings/common/SettingsCard";
import SettingsLoadError from "@/components/settings/common/SettingsLoadError";
import { type OrgRole, roleWords } from "@/components/settings/common/roleWords";

/**
 * Ihre Organisation, read-only, for Bearbeiter and Betrachter. The member
 * count reads the contacts card's request: when that fails, the count is left
 * out here and only the contacts card says so.
 */
export default function OrgSummaryCard({ role }: { role: OrgRole | undefined }) {
  const { t } = useTranslation("common");
  const { organization, isError, mutate } = useOrganization();
  const organizationId = useOrganizationId();
  const { members, isError: membersError } = useOrganizationMembers(organizationId ?? "");
  const title = t("settings_org_summary_title");

  if (!organization) {
    return isError ? (
      <SettingsCard title={title}>
        <SettingsLoadError onRetry={() => void mutate()} />
      </SettingsCard>
    ) : (
      <CardSkeleton title={title} rows={1} variant="list" />
    );
  }
  const count = members?.filter((member) => member.invitation_status !== "pending").length;

  return (
    <SettingsCard title={title}>
      <Box sx={{ display: "flex", alignItems: "center", gap: 4 }}>
        <UserAvatar
          id={organization.id}
          name={organization.name}
          src={organization.avatar}
          size={56}
          sx={{ borderRadius: "14px" }}
        />
        <Box sx={{ minWidth: 0 }}>
          <Typography fontWeight={700} sx={{ overflowWrap: "anywhere" }}>
            {organization.name}
          </Typography>
          {count !== undefined ? (
            <Typography variant="body2" color="text.secondary">
              {t("settings_org_member_count", { count })}
            </Typography>
          ) : (
            !membersError && <Skeleton variant="text" width={100} />
          )}
        </Box>
      </Box>
      {role && (
        <Typography variant="body2" sx={{ mt: 4 }}>
          {t("settings_org_your_role", { role: roleWords(t)[role].word })}
        </Typography>
      )}
    </SettingsCard>
  );
}
