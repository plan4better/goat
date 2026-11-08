"use client";

import { Alert, Box, Button, Skeleton } from "@mui/material";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import { useTeams } from "@/lib/api/teams";
import { useUserProfile } from "@/lib/api/users";
import { settingsTeamPath } from "@/lib/settingsRoutes";

import { DialogLoadFailed, orLoadFailed } from "@/components/assistant/LoadFailed";
import EmptyState from "@/components/dashboard/common/EmptyState";
import PageHeader from "@/components/dashboard/common/PageHeader";
import SearchInput from "@/components/dashboard/common/SearchInput";
import SettingsLoadError from "@/components/settings/common/SettingsLoadError";
import SettingsPage, { pageActionSx } from "@/components/settings/common/SettingsPage";
import { orgRoleOf } from "@/components/settings/common/roleWords";
import TeamCard from "@/components/settings/teams/TeamCard";
import { GroupToggle } from "@/components/settings/usage/GroupToggle";

const NewTeamDialog = dynamic(
  () => orLoadFailed(import("@/components/settings/teams/NewTeamDialog"), DialogLoadFailed),
  { ssr: false }
);
const PLAIN = { interpolation: { escapeValue: false } } as const;
const GRID = {
  display: "grid",
  gap: 4,
  gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))",
} as const;

/** Organisation › Teams: the caller's teams as cards (phase 1: only the teams
 * they are in, for every role); Bearbeiter and up create new ones. */
export default function TeamsPage() {
  const { t, i18n } = useTranslation("common");
  const router = useRouter();
  const { teams, isLoading, isError, mutate } = useTeams();
  const { userProfile } = useUserProfile();
  const role = orgRoleOf(userProfile?.roles);
  const canCreate = role !== undefined && role !== "organization-viewer";
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "owned">("all");
  const [creating, setCreating] = useState(false);

  const collator = useMemo(() => new Intl.Collator(i18n.language), [i18n.language]);
  const sorted = useMemo(
    () => [...teams].sort((a, b) => collator.compare(a.name, b.name)),
    [teams, collator]
  );
  const teamNames = useMemo(() => teams.map((team) => team.name), [teams]);
  const needle = query.trim().toLowerCase();
  const shown = sorted.filter(
    (team) =>
      (filter === "all" || team.role === "team-owner") &&
      (!needle ||
        team.name.toLowerCase().includes(needle) ||
        (team.description ?? "").toLowerCase().includes(needle))
  );
  const loading = isLoading && !isError && teams.length === 0;

  const newTeam = (
    <Button
      variant="contained"
      startIcon={<Icon iconName={ICON_NAME.PLUS} style={{ fontSize: 16 }} htmlColor="inherit" />}
      onClick={() => setCreating(true)}
      sx={pageActionSx}>
      {t("settings_teams_new")}
    </Button>
  );

  return (
    <SettingsPage
      header={
        <PageHeader
          level={2}
          responsive
          eyebrow={t("settings_nav_group_organization")}
          title={t("settings_teams_title")}
          subtitle={t("settings_teams_subtitle")}
          action={canCreate ? newTeam : undefined}
        />
      }>
      {role === "organization-viewer" && (
        <Alert severity="info" role="note">
          {t("settings_teams_viewer_note")}
        </Alert>
      )}
      {teams.length > 0 && (
        <Box sx={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "10px" }}>
          <SearchInput
            size="toolbar"
            value={query}
            onChange={setQuery}
            onClear={() => setQuery("")}
            placeholder={t("settings_teams_search")}
            ariaLabel={t("settings_teams_search")}
          />
          <GroupToggle<"all" | "owned">
            value={filter}
            label={null}
            ariaLabel={t("settings_teams_filter_label")}
            onChange={setFilter}
            options={[
              { key: "all", label: t("settings_teams_filter_all") },
              { key: "owned", label: t("settings_teams_filter_owned") },
            ]}
          />
        </Box>
      )}
      {isError && teams.length === 0 ? (
        <SettingsLoadError onRetry={() => void mutate()} />
      ) : loading ? (
        <Box sx={GRID} role="status" aria-busy="true" aria-label={t("settings_nav_loading")}>
          {[0, 1, 2].map((index) => (
            <Skeleton key={index} variant="rounded" height={148} sx={{ borderRadius: "12px" }} />
          ))}
        </Box>
      ) : teams.length === 0 ? (
        <EmptyState
          icon={ICON_NAME.USERS}
          title={t("settings_teams_empty_title")}
          // Until the role is known the hint would guess: an editor would read
          // the viewer's line for a moment, or a viewer the editor's.
          hint={
            role === undefined
              ? undefined
              : t(canCreate ? "settings_teams_empty_hint" : "settings_teams_empty_hint_viewer")
          }
          action={canCreate ? newTeam : undefined}
        />
      ) : shown.length === 0 ? (
        <EmptyState
          icon={ICON_NAME.SEARCH}
          title={
            needle
              ? t("settings_teams_empty_search", { query: query.trim(), ...PLAIN })
              : t("settings_teams_empty_owned")
          }
          hint={t("settings_teams_empty_search_hint")}
        />
      ) : (
        <Box sx={GRID}>
          {shown.map((team) => (
            <TeamCard key={team.id} team={team} />
          ))}
        </Box>
      )}
      {creating && (
        <NewTeamDialog
          takenNames={teamNames}
          onClose={() => setCreating(false)}
          onCreated={(team) => {
            setCreating(false);
            void mutate();
            router.push(settingsTeamPath(team.id));
          }}
        />
      )}
    </SettingsPage>
  );
}
