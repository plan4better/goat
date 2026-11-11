import type { PaletteMode } from "@mui/material";
import {
  Avatar,
  Badge,
  Box,
  ButtonBase,
  Divider,
  IconButton,
  Stack,
  Typography,
  useTheme,
} from "@mui/material";
import { signOut } from "next-auth/react";
import { useRouter } from "next/navigation";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import { useFeatures, useOrganization, useUserProfile } from "@/lib/api/users";
import { AUTH_DISABLED } from "@/lib/constants";
import { SETTINGS_ROUTES } from "@/lib/settingsRoutes";

import { type PreferenceLanguage, usePreferenceChoice } from "@/hooks/settings/usePreferenceChoice";

import { ArrowPopper } from "@/components/ArrowPoper";
import { focusRing } from "@/components/assistant/styles";
import { HeaderPopoverList, HeaderPopoverRow } from "@/components/header/HeaderPopover";
import HeaderPopoverPaper, { HEADER_POPOVER_PLACEMENT } from "@/components/header/HeaderPopoverPaper";
import { isOrgAdminRole } from "@/components/settings/nav/settingsNav";
import { SupportMenuEntries, supportCountLabel, useSupportCounts } from "@/components/support/SupportMenu";

/** Narrower than the header's trays: short rows only. Never wider than a phone. */
const ACCOUNT_MENU_WIDTH = "min(280px, calc(100vw - 24px))";

interface PickOption<T extends string> {
  value: T;
  /** The button's name. */
  name: string;
  content: ReactNode;
  lang?: string;
}

/** A pick between a few values, in a row of the menu: small buttons in one
 * pill, the current one raised. */
function Pick<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: PickOption<T>[];
  onChange: (value: T) => void;
}) {
  const theme = useTheme();
  return (
    <Box
      role="group"
      aria-label={label}
      sx={{
        display: "flex",
        flexShrink: 0,
        gap: "2px",
        p: "2px",
        // Higher than the row's line: the rows keep one height.
        my: "-5px",
        borderRadius: "999px",
        border: `1px solid ${theme.palette.divider}`,
      }}>
      {options.map((option) => {
        const picked = option.value === value;
        return (
          <ButtonBase
            key={option.value}
            aria-label={option.name}
            aria-pressed={picked}
            title={option.name}
            lang={option.lang}
            onClick={() => !picked && onChange(option.value)}
            sx={{
              width: 32,
              height: 24,
              borderRadius: "999px",
              fontFamily: "inherit",
              fontSize: 11,
              fontWeight: 800,
              color: picked ? theme.palette.text.primary : theme.palette.text.secondary,
              backgroundColor: picked ? theme.palette.action.selected : "transparent",
              ...(!picked && { "&:hover": { color: theme.palette.text.primary } }),
              ...focusRing(theme),
            }}>
            {option.content}
          </ButtonBase>
        );
      })}
    </Box>
  );
}

/**
 * The account menu behind the header's avatar: who is signed in, the way to
 * the profile and (owners and admins of an organization with billing) to
 * usage, the appearance and the language in place, and sign out.
 */
export default function UserInfoMenu({ withSupport = false }: { withSupport?: boolean }) {
  const theme = useTheme();
  const { t } = useTranslation("common");
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const { organization } = useOrganization();
  const { userProfile } = useUserProfile();
  const { features } = useFeatures();
  const { choice, save } = usePreferenceChoice();
  // The settings nav's rule for Nutzung.
  const showUsage = isOrgAdminRole(userProfile?.roles) && features?.billing === true;
  // On a phone the header has no room for the support icon, so its entries (and its badge) move in here.
  const supportCounts = useSupportCounts(withSupport);
  const needsReply = supportCounts?.needsReply ?? 0;
  const unread = supportCounts?.unread ?? 0;
  const countLabel = supportCounts ? supportCountLabel(t, supportCounts) : undefined;
  const go = (path: string) => {
    setOpen(false);
    router.push(path);
  };
  const userAvatar = (size: number) =>
    userProfile?.avatar ? (
      <Avatar
        sx={{ width: size, height: size }}
        alt={userProfile.email || t("user")}
        src={userProfile.avatar}
      />
    ) : (
      <Avatar sx={{ width: size, height: size }} alt={userProfile?.email || t("user")}>
        <Icon fontSize="inherit" iconName={ICON_NAME.USER} htmlColor="inherit" />
      </Avatar>
    );
  const roles =
    userProfile && userProfile.roles?.length > 0
      ? userProfile.roles.map((role) => t(role)).join(", ")
      : t("user");
  return (
    <>
      <ArrowPopper
        content={
          <HeaderPopoverPaper width={ACCOUNT_MENU_WIDTH}>
            <Box sx={{ p: "14px 16px 12px", borderBottom: `1px solid ${theme.palette.divider}` }}>
              {userProfile && (
                <Stack direction="row" alignItems="center" spacing="12px" sx={{ mb: "10px" }}>
                  {userAvatar(40)}
                  <Box sx={{ minWidth: 0 }}>
                    <Typography noWrap sx={{ fontSize: 14.5, fontWeight: 700 }}>
                      {userProfile.firstname} {userProfile.lastname}
                    </Typography>
                    <Typography noWrap sx={{ fontSize: 12, color: theme.palette.text.secondary }}>
                      {userProfile.email}
                    </Typography>
                  </Box>
                </Stack>
              )}
              <Typography noWrap sx={{ fontSize: 12, color: theme.palette.text.secondary }}>
                {organization?.name ?? t("organization")}
                {userProfile ? ` · ${roles}` : ""}
              </Typography>
            </Box>
            <HeaderPopoverList>
              <HeaderPopoverRow
                icon={ICON_NAME.USER}
                label={t("settings_nav_profile")}
                onClick={() => go(SETTINGS_ROUTES.profile)}
              />
              {showUsage && (
                <HeaderPopoverRow
                  icon={ICON_NAME.CHART_PIE}
                  label={t("settings_nav_usage")}
                  onClick={() => go(SETTINGS_ROUTES.usage)}
                />
              )}
              <Divider sx={{ my: "4px" }} />
              <HeaderPopoverRow
                icon={ICON_NAME.STYLE}
                label={t("settings_prefs_appearance_title")}
                trailing={
                  <Pick<PaletteMode>
                    label={t("settings_prefs_appearance_title")}
                    value={choice.mode}
                    onChange={(mode) => void save({ ...choice, mode })}
                    options={[
                      {
                        value: "light",
                        name: t("settings_prefs_light"),
                        content: <Icon iconName={ICON_NAME.SUN} htmlColor="inherit" sx={{ fontSize: 13 }} />,
                      },
                      {
                        value: "dark",
                        name: t("settings_prefs_dark"),
                        content: <Icon iconName={ICON_NAME.MOON} htmlColor="inherit" sx={{ fontSize: 13 }} />,
                      },
                    ]}
                  />
                }
              />
              <HeaderPopoverRow
                icon={ICON_NAME.LANGUAGE}
                label={t("settings_prefs_language_title")}
                trailing={
                  <Pick<PreferenceLanguage>
                    label={t("settings_prefs_language_title")}
                    value={choice.language}
                    onChange={(language) => void save({ ...choice, language })}
                    options={[
                      { value: "de", name: "Deutsch", content: "DE", lang: "de" },
                      { value: "en", name: "English", content: "EN", lang: "en" },
                    ]}
                  />
                }
              />
              {withSupport && (
                <>
                  <Divider sx={{ my: "4px" }} />
                  <SupportMenuEntries counts={supportCounts} onNavigate={() => setOpen(false)} />
                </>
              )}
              {!AUTH_DISABLED && (
                <>
                  <Divider sx={{ my: "4px" }} />
                  <HeaderPopoverRow
                    icon={ICON_NAME.SIGNOUT}
                    label={t("logout")}
                    onClick={() => signOut({ callbackUrl: process.env.NEXT_PUBLIC_APP_URL })}
                  />
                </>
              )}
            </HeaderPopoverList>
          </HeaderPopoverPaper>
        }
        open={open}
        placement={HEADER_POPOVER_PLACEMENT}
        arrow={false}
        onClose={() => setOpen(false)}>
        <IconButton
          onClick={() => {
            setOpen(!open);
          }}
          size="small"
          aria-label={countLabel ? `${t("account_menu")}: ${countLabel}` : t("account_menu")}
          aria-expanded={open}>
          <Badge
            variant="dot"
            color={needsReply ? "warning" : "primary"}
            invisible={!needsReply && !unread}
            overlap="circular"
            sx={{
              "& .MuiBadge-dot": {
                width: 10,
                height: 10,
                borderRadius: "50%",
                border: `2px solid ${theme.palette.background.paper}`,
              },
            }}>
            {userAvatar(36)}
          </Badge>
        </IconButton>
      </ArrowPopper>
    </>
  );
}
