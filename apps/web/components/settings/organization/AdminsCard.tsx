"use client";

import { Box, Button, IconButton, Skeleton, Stack, Typography, useTheme } from "@mui/material";
import NextLink from "next/link";
import { useTranslation } from "react-i18next";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import { useOrganizationMembers } from "@/lib/api/organizations";
import { useFeatures } from "@/lib/api/users";
import { SETTINGS_ROUTES, settingsUsagePath } from "@/lib/settingsRoutes";

import { useOrganizationId } from "@/hooks/settings/useOrganizationId";

import UserAvatar from "@/components/dashboard/common/UserAvatar";
import CardSkeleton from "@/components/settings/common/CardSkeleton";
import SettingsCard from "@/components/settings/common/SettingsCard";
import SettingsLoadError from "@/components/settings/common/SettingsLoadError";
import { personName } from "@/components/settings/common/personName";
import { orgRoleOf, roleWords } from "@/components/settings/common/roleWords";

/**
 * Eigentümer und Admins: whom members ask (every role may read the member
 * list, F14). The hint and the links depend on the role: with `admin`
 * undefined (the profile still loading) the card is a skeleton with a neutral
 * hint, while its request already runs.
 */
export default function AdminsCard({ admin }: { admin: boolean | undefined }) {
  const { t, i18n } = useTranslation("common");
  const theme = useTheme();
  const organizationId = useOrganizationId();
  // The members-only list, the same SWR key as the nav's Mitglieder badge.
  const { members, isError, mutate } = useOrganizationMembers(organizationId ?? "");
  const { features } = useFeatures();
  const title = t("settings_org_admins_title");
  if (admin === undefined) {
    return (
      <CardSkeleton
        title={title}
        hint={<Skeleton variant="text" width={420} sx={{ maxWidth: "100%" }} />}
        rows={2}
        variant="list"
      />
    );
  }
  const hint = t(admin ? "settings_org_admins_hint" : "settings_org_admins_hint_member");

  if (!members) {
    return isError ? (
      <SettingsCard title={title} hint={hint}>
        <SettingsLoadError onRetry={() => void mutate()} />
      </SettingsCard>
    ) : (
      <CardSkeleton title={title} hint={hint} rows={2} variant="list" />
    );
  }

  const words = roleWords(t);
  const collator = new Intl.Collator(i18n.language);
  const contacts = members
    .filter((member) => member.invitation_status !== "pending")
    .map((member) => ({ member, role: orgRoleOf(member.roles), name: personName(member) }))
    .filter(({ role }) => role === "organization-owner" || role === "organization-admin")
    .sort((a, b) =>
      a.role === b.role ? collator.compare(a.name, b.name) : a.role === "organization-owner" ? -1 : 1
    );

  return (
    <SettingsCard title={title} hint={hint}>
      <Box
        component="ul"
        sx={{ listStyle: "none", m: 0, p: 0, display: "flex", flexDirection: "column", gap: 3 }}>
        {contacts.map(({ member, role, name }) => (
          <Box component="li" key={member.id} sx={{ display: "flex", alignItems: "center", gap: 3 }}>
            <UserAvatar id={member.id} name={name} src={member.avatar} size={32} />
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Typography
                variant="body2"
                fontWeight={700}
                sx={{ display: "flex", alignItems: "center", gap: 1 }}>
                <Box
                  component="span"
                  sx={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {name}
                </Box>
                {role === "organization-owner" && (
                  <Icon
                    iconName={ICON_NAME.CROWN}
                    style={{ fontSize: 12, flexShrink: 0 }}
                    htmlColor={theme.palette.warning.main}
                  />
                )}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                {role && words[role].word}
              </Typography>
            </Box>
            <IconButton
              size="small"
              component="a"
              href={`mailto:${member.email}`}
              aria-label={t("settings_org_mail_to", { name, interpolation: { escapeValue: false } })}
              title={member.email}>
              <Icon iconName={ICON_NAME.EMAIL} style={{ fontSize: 16 }} />
            </IconButton>
          </Box>
        ))}
      </Box>
      {admin && (
        <Stack direction="row" spacing={2} sx={{ mt: 4 }}>
          <Button component={NextLink} href={SETTINGS_ROUTES.members} variant="text" size="small">
            {t("settings_org_all_members")}
          </Button>
          {features?.billing && (
            <Button component={NextLink} href={settingsUsagePath("editors")} variant="text" size="small">
              {t("settings_org_seats_usage")}
            </Button>
          )}
        </Stack>
      )}
    </SettingsCard>
  );
}
