"use client";

import type { PaletteMode } from "@mui/material";
import { Box } from "@mui/material";
import { useTranslation } from "react-i18next";

import { type PreferenceLanguage, usePreferenceChoice } from "@/hooks/settings/usePreferenceChoice";

import RadioCardGroup from "@/components/settings/common/RadioCardGroup";
import SettingsCard from "@/components/settings/common/SettingsCard";

const Badge = ({ children }: { children: string }) => (
  <Box
    component="span"
    aria-hidden
    sx={{
      px: 1.5,
      py: "2px",
      borderRadius: "6px",
      border: 1,
      borderColor: "divider",
      fontSize: 11,
      fontWeight: 800,
    }}>
    {children}
  </Box>
);

/** A small drawing of the app in a mode: a header, a nav column, two cards. */
const ModePreview = ({ mode }: { mode: PaletteMode }) => {
  const dark = mode === "dark";
  const page = dark ? "#18202B" : "#F4F6F8";
  const surface = dark ? "#222C38" : "#FFFFFF";
  const line = dark ? "#3A4655" : "#DDE2E8";
  return (
    <Box
      aria-hidden
      sx={{
        width: 64,
        height: 44,
        flexShrink: 0,
        borderRadius: "6px",
        border: `1px solid ${line}`,
        backgroundColor: page,
        overflow: "hidden",
      }}>
      <Box sx={{ height: 8, backgroundColor: surface, borderBottom: `1px solid ${line}` }} />
      <Box sx={{ display: "flex", gap: "4px", p: "4px" }}>
        <Box sx={{ width: 12, height: 24, borderRadius: "3px", backgroundColor: surface }} />
        <Box sx={{ flex: 1, display: "flex", flexDirection: "column", gap: "4px" }}>
          <Box sx={{ height: 10, borderRadius: "3px", backgroundColor: surface }} />
          <Box sx={{ height: 10, borderRadius: "3px", backgroundColor: surface }} />
        </Box>
      </Box>
    </Box>
  );
};

/**
 * Sprache and Erscheinungsbild: a pick saves at once (`usePreferenceChoice`).
 * While a pick saves, the other cards are disabled.
 */
export default function PreferenceCards() {
  const { t } = useTranslation("common");
  const { choice, saving, save } = usePreferenceChoice();

  // The picked card stays enabled (picking it again changes nothing).
  const held = (value: string, current: string) => saving && value !== current;

  return (
    <>
      <SettingsCard title={t("settings_prefs_language_title")} hint={t("settings_prefs_language_hint")}>
        <RadioCardGroup<PreferenceLanguage>
          label={t("settings_prefs_language_title")}
          value={choice.language}
          columns={{ xs: 1, md: 2 }}
          onChange={(language) => language !== choice.language && void save({ ...choice, language })}
          options={[
            {
              value: "de",
              label: "Deutsch",
              line: t("settings_prefs_line_de"),
              lead: <Badge>DE</Badge>,
              lang: "de",
              disabled: held("de", choice.language),
            },
            {
              value: "en",
              label: "English",
              line: t("settings_prefs_line_en"),
              lead: <Badge>EN</Badge>,
              lang: "en",
              disabled: held("en", choice.language),
            },
          ]}
        />
      </SettingsCard>
      <SettingsCard title={t("settings_prefs_appearance_title")} hint={t("settings_prefs_appearance_hint")}>
        <RadioCardGroup<PaletteMode>
          label={t("settings_prefs_appearance_title")}
          value={choice.mode}
          columns={{ xs: 1, md: 2 }}
          onChange={(mode) => mode !== choice.mode && void save({ ...choice, mode })}
          options={[
            {
              value: "light",
              label: t("settings_prefs_light"),
              lead: <ModePreview mode="light" />,
              disabled: held("light", choice.mode),
            },
            {
              value: "dark",
              label: t("settings_prefs_dark"),
              lead: <ModePreview mode="dark" />,
              disabled: held("dark", choice.mode),
            },
          ]}
        />
      </SettingsCard>
    </>
  );
}
