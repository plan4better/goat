"use client";

import { Avatar, Box, Button, ButtonBase, Stack, Typography, alpha, useTheme } from "@mui/material";
import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import type { OrganizationMember } from "@/lib/validations/organization";

import {
  DialogGroupLabel,
  DialogSearchField,
} from "@/components/modals/content/ContentDialogChrome";
import RolePicker, { type RolePrefix } from "@/components/modals/content/RolePicker";

const MAX_MATCHES = 40;

interface SharePeopleTabProps {
  /** Only layers and projects grant to individual users; folders and
   * bundles show the fallback message instead of the search/list below. */
  supported: boolean;
  users: { id: string; role: string }[];
  members: OrganizationMember[];
  organizationName: string;
  rolePrefix: RolePrefix;
  onAdd: (memberId: string) => void;
  onRoleChange: (memberId: string, role: string) => void;
}

const memberName = (member: OrganizationMember): string =>
  [member.firstname, member.lastname].filter(Boolean).join(" ") || member.email;

/**
 * The People tab: a typeahead over the organization's members that adds a
 * viewer grant on click, and the current list of people the item is shared
 * with, each with its own `RolePicker`. Folders and bundles have no user
 * grantee on the backend, so this renders only the "not supported" message
 * for them.
 */
const SharePeopleTab = ({
  supported,
  users,
  members,
  organizationName,
  rolePrefix,
  onAdd,
  onRoleChange,
}: SharePeopleTabProps) => {
  const { t } = useTranslation("common");
  const theme = useTheme();
  const [query, setQuery] = useState("");
  // Whether the field is being used to pick someone. An empty field then
  // lists the organisation's members instead of nothing: "Add person" used to
  // only move focus, which shows no change on screen and reads as broken.
  const [browsing, setBrowsing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const addedIds = useMemo(() => new Set(users.map((u) => u.id)), [users]);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    const pool = q
      ? members.filter(
          (member) => memberName(member).toLowerCase().includes(q) || member.email.toLowerCase().includes(q)
        )
      : members.filter((member) => !addedIds.has(member.id));
    return pool.slice(0, MAX_MATCHES);
  }, [members, query, addedIds]);
  const picking = query.trim() !== "" || browsing;

  if (!supported) {
    return (
      <Typography sx={{ fontSize: 12.8, color: "text.secondary", lineHeight: 1.6 }}>
        {t("people_not_supported_for_type")}
      </Typography>
    );
  }

  const scrollSx = { flex: 1, minHeight: 0, overflowY: "auto" as const };

  return (
    <Stack sx={{ height: "100%", minHeight: 0 }} spacing="10px">
      <DialogSearchField
        value={query}
        onChange={setQuery}
        placeholder={t("add_people_placeholder")}
        clearLabel={t("clear")}
        inputRef={inputRef}
        onFocus={() => setBrowsing(true)}
      />

      {picking ? (
        <Box sx={scrollSx}>
          {matches.length === 0 ? (
            <Typography sx={{ padding: "16px 2px", fontSize: 12.5, color: "text.disabled", lineHeight: 1.55 }}>
              {t("no_one_matches", { name: organizationName, query })}
            </Typography>
          ) : (
            <DialogGroupLabel first>{t("people")}</DialogGroupLabel>
          )}
          {matches.map((member) => {
            const already = addedIds.has(member.id);
            return (
              <ButtonBase
                key={member.id}
                disabled={already}
                onClick={() => {
                  if (already) return;
                  onAdd(member.id);
                  // Clearing the query and the browse puts the new grant (and
                  // its role picker) in view straight away.
                  setQuery("");
                  setBrowsing(false);
                }}
                sx={{
                  display: "flex",
                  width: "100%",
                  alignItems: "center",
                  gap: "11px",
                  padding: "7px 8px",
                  margin: "0 -8px",
                  borderRadius: "9px",
                  textAlign: "left",
                  "&:hover": { backgroundColor: theme.palette.action.hover },
                }}>
                <Avatar alt={memberName(member)} src={member.avatar} sx={{ width: 28, height: 28, fontSize: 12 }} />
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <Typography component="div" noWrap sx={{ fontSize: 13.5, fontWeight: 600 }}>
                    {memberName(member)}
                  </Typography>
                  <Typography component="div" noWrap sx={{ fontSize: 11.5, color: "text.secondary" }}>
                    {member.email}
                  </Typography>
                </Box>
                {already ? (
                  <Typography component="span" sx={{ fontSize: 11.5, fontWeight: 700, color: "text.disabled" }}>
                    {t("already_added")}
                  </Typography>
                ) : (
                  <Icon iconName={ICON_NAME.PLUS} style={{ fontSize: 14, color: theme.palette.primary.main }} />
                )}
              </ButtonBase>
            );
          })}
        </Box>
      ) : users.length === 0 ? (
        <Box
          sx={{
            ...scrollSx,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            textAlign: "center",
            padding: "0 20px",
          }}>
          <Box
            sx={{
              width: 52,
              height: 52,
              borderRadius: "50%",
              backgroundColor: alpha(theme.palette.primary.main, 0.12),
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              marginBottom: "13px",
            }}>
            <Icon iconName={ICON_NAME.USER} style={{ fontSize: 22, color: theme.palette.primary.main }} />
          </Box>
          <Typography component="div" sx={{ fontSize: 14.5, fontWeight: 800, marginBottom: "5px" }}>
            {t("not_shared_yet")}
          </Typography>
          <Typography
            component="div"
            sx={{ fontSize: 12.8, color: "text.secondary", lineHeight: 1.6, maxWidth: 320, marginBottom: "16px" }}>
            {t("share_people_hint")}
          </Typography>
          <Button
            variant="contained"
            onClick={() => {
              setBrowsing(true);
              inputRef.current?.focus();
            }}
            startIcon={<Icon iconName={ICON_NAME.PLUS} style={{ fontSize: 14 }} />}
            sx={{ borderRadius: "999px", padding: "9px 18px", fontSize: 13.5, fontWeight: 700, textTransform: "none" }}>
            {t("add_person")}
          </Button>
        </Box>
      ) : (
        <Box sx={scrollSx}>
          <DialogGroupLabel first>{t("who_has_access")}</DialogGroupLabel>
          {users.map((entry) => {
            const member = members.find((m) => m.id === entry.id);
            return (
              <Box key={entry.id} sx={{ display: "flex", alignItems: "center", gap: "11px", padding: "6px 0" }}>
                <Avatar
                  alt={member ? memberName(member) : entry.id}
                  src={member?.avatar}
                  sx={{ width: 28, height: 28, fontSize: 12 }}
                />
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <Typography component="div" noWrap sx={{ fontSize: 13.5, fontWeight: 600 }}>
                    {member ? memberName(member) : entry.id}
                  </Typography>
                  <Typography component="div" noWrap sx={{ fontSize: 11.5, color: "text.secondary" }}>
                    {member?.email}
                  </Typography>
                </Box>
                <RolePicker value={entry.role} prefix={rolePrefix} onChange={(role) => onRoleChange(entry.id, role)} />
              </Box>
            );
          })}
        </Box>
      )}
    </Stack>
  );
};

export default SharePeopleTab;
