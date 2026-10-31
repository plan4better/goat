"use client";

import { Box, ButtonBase, Link, Stack, Typography, alpha, useTheme } from "@mui/material";
import { useState } from "react";
import { Trans, useTranslation } from "react-i18next";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import { useProjectLayers } from "@/lib/api/projects";
import { plainTranslate } from "@/lib/assistant/chips";
import { useConversations } from "@/lib/assistant/conversations";
import { conversationTitle, originLabel } from "@/lib/assistant/history";
import { relativeTime } from "@/lib/assistant/messageTimes";
import { type Starter, pickStarters, showStarters, starterContext } from "@/lib/assistant/starters";
import { openConversation, useActiveSurface } from "@/lib/assistant/store";
import type { PageContext } from "@/lib/assistant/types";
import { SYSTEM_LAYERS_IDS, privacyPolicyUrl } from "@/lib/constants";
import { filterSelectableProjectLayers } from "@/lib/utils/map/layer";

import { useNow } from "@/hooks/assistant/useNow";

import { CARD_RADIUS, accentSoft, accentText, focusRing, mutedText } from "@/components/assistant/styles";

const RECENT_COUNT = 3;

/** The small uppercase caption over the starters and the recent conversations. */
const sectionLabelSx = {
  fontSize: 12,
  fontWeight: 700,
  letterSpacing: "0.04em",
  lineHeight: 1.5,
  textTransform: "uppercase",
  color: mutedText,
} as const;

/** What kind of question a starter is, as its icon shows it. */
const STARTER_ICONS: Record<string, ICON_NAME> = {
  layers: ICON_NAME.LAYERS,
  layer_fields: ICON_NAME.TABLE,
  selected_layer: ICON_NAME.LAYERS,
  view_data: ICON_NAME.SEARCH,
  walk: ICON_NAME.ROUTE,
  workflow: ICON_NAME.WORKFLOW,
  datasets: ICON_NAME.SEARCH,
  help_project: ICON_NAME.HELP,
  open_workflow: ICON_NAME.WORKFLOW,
  check_workflow: ICON_NAME.WORKFLOW,
  commercial: ICON_NAME.LIST,
  updated: ICON_NAME.LIST,
  selected_record: ICON_NAME.TABLE,
  cycling_projects: ICON_NAME.SEARCH,
  population: ICON_NAME.SEARCH,
  help: ICON_NAME.HELP,
};

/**
 * The docked start page's way back into earlier work: the newest conversations
 * of this project on a project page, else of all pages with where they began.
 */
function RecentConversations() {
  const { t, i18n } = useTranslation("common");
  const theme = useTheme();
  const translate = plainTranslate(t);
  const now = useNow();
  const projectId = useActiveSurface()?.project?.id ?? null;
  const { conversations } = useConversations({ projectId });
  const recent = conversations.slice(0, RECENT_COUNT);
  if (!recent.length) return null;
  const language = i18n?.language ?? "en";
  return (
    <Stack gap="4px">
      <Typography component="h3" sx={{ ...sectionLabelSx, m: 0 }}>
        {t(projectId ? "assistant_recent_in_project" : "assistant_recent")}
      </Typography>
      <Box component="ul" sx={{ listStyle: "none", m: 0, p: 0, mx: "-8px" }}>
        {recent.map((conversation) => (
          <li key={conversation.id}>
            <ButtonBase
              onClick={() => openConversation(conversation.id)}
              sx={{
                // A button does not inherit the page font by itself.
                fontFamily: "inherit",
                width: "100%",
                justifyContent: "flex-start",
                gap: "12px",
                px: "8px",
                py: "8px",
                borderRadius: "8px",
                textAlign: "left",
                "&:hover": { bgcolor: "action.hover" },
                ...focusRing(theme),
              }}>
              <Typography noWrap sx={{ flex: 1, minWidth: 0, fontSize: 14, color: "text.primary" }}>
                {conversationTitle(conversation, translate)}
              </Typography>
              <Typography noWrap sx={{ flexShrink: 0, maxWidth: "45%", fontSize: 12, color: mutedText }}>
                {projectId
                  ? relativeTime(Date.parse(conversation.updated_at), now, translate, language)
                  : originLabel(conversation, translate)}
              </Typography>
            </ButtonBase>
          </li>
        ))}
      </Box>
    </Stack>
  );
}

/**
 * That the conversation is with an AI and where its messages go, with the
 * privacy policy when the installation has a website to link to.
 */
function AiNotice() {
  const { t, i18n } = useTranslation("common");
  const url = privacyPolicyUrl(i18n.language === "de" ? "de" : "en");
  return (
    <Typography
      sx={{
        fontSize: 11.5,
        lineHeight: 1.45,
        textAlign: "center",
        color: mutedText,
        maxWidth: 560,
        mx: "auto",
      }}>
      {url ? (
        <Trans
          t={t}
          i18n={i18n}
          i18nKey="assistant_ai_notice"
          components={{
            // Not `link`: the parser reads that as the void HTML element and drops its text.
            policy: (
              <Link href={url} target="_blank" rel="noopener noreferrer" color="inherit" underline="always" />
            ),
          }}
        />
      ) : (
        t("assistant_ai_notice_no_policy")
      )}
    </Typography>
  );
}

function StarterCard({ starter, onClick }: { starter: Starter; onClick: () => void }) {
  const theme = useTheme();
  return (
    <ButtonBase
      onClick={onClick}
      sx={{
        fontFamily: "inherit",
        justifyContent: "flex-start",
        alignItems: "center",
        gap: "10px",
        textAlign: "left",
        px: "12px",
        py: "10px",
        border: 1,
        borderColor: "divider",
        borderRadius: CARD_RADIUS,
        bgcolor: "background.paper",
        color: "text.primary",
        transition: theme.transitions.create(["border-color", "background-color"], { duration: 120 }),
        "&:hover": {
          borderColor: alpha(theme.palette.primary.main, 0.6),
          bgcolor: accentSoft(theme),
        },
        ...focusRing(theme),
      }}>
      <Box
        aria-hidden
        sx={{
          width: 28,
          height: 28,
          flexShrink: 0,
          borderRadius: "8px",
          bgcolor: "action.hover",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}>
        <Icon
          iconName={STARTER_ICONS[starter.key] ?? ICON_NAME.SPARKLES}
          style={{ fontSize: 13, color: mutedText(theme) }}
        />
      </Box>
      <Typography component="span" sx={{ flex: 1, fontSize: 14, lineHeight: 1.4, color: "inherit" }}>
        {/* A sentence start reads as one: the user finishes it in the composer. */}
        {starter.draft ? `${starter.text}…` : starter.text}
      </Typography>
    </ButtonBase>
  );
}

/**
 * The start of a new conversation, centred in the free space: what the
 * assistant does here, up to four starters that fit what the page has, that
 * it is an AI, and (docked) the latest conversations. `context` is what the
 * first message would carry; a starter that needs something it lacks is left
 * out. A question is sent at once (`onPick`), a sentence start goes into the
 * composer to be finished (`onDraft`).
 */
export default function EmptyState({
  context,
  onPick,
  onDraft,
  big,
}: {
  context: PageContext | null;
  onPick: (text: string) => void;
  onDraft: (text: string) => void;
  big?: boolean;
}) {
  const { t } = useTranslation("common");
  const theme = useTheme();
  const surface = useActiveSurface();
  const group = surface?.surface === "catalog" ? "catalog" : surface ? "project" : "none";
  const projectId = surface?.project?.id;
  const { layers } = useProjectLayers(projectId, { revalidateOnMount: false });
  // The layers the user can read, as the layer pickers list them: no locked or system layer.
  const layerNames =
    layers && filterSelectableProjectLayers(layers, [], SYSTEM_LAYERS_IDS).map((layer) => layer.name);
  // Only editors get somewhere to add to, as the result cards' "Add to project" decides it.
  const canEdit = !!surface?.uploadTo?.projectId;
  const starterCtx = starterContext(context, layerNames, canEdit);
  // Drawn once per start page, and again when the page or its project changes or the
  // project's layers or the user's edit right arrive: the starters stay put while the user reads them.
  const pickKey = `${surface?.surface ?? "none"}:${projectId ?? ""}:${layerNames ? "layers" : ""}:${canEdit ? "edit" : ""}`;
  const draw = () => pickStarters(surface?.surface ?? "none", starterCtx, Math.random);
  const [pick, setPick] = useState(() => ({ key: pickKey, starters: draw() }));
  if (pick.key !== pickKey) setPick({ key: pickKey, starters: draw() });
  // Shown in the current language, without a drawn one whose context went away since.
  const starters = showStarters(pick.starters, starterCtx, plainTranslate(t));

  return (
    <Stack gap={big ? "24px" : "20px"}>
      <Stack gap="8px" alignItems="center" sx={{ textAlign: "center" }}>
        <Box
          aria-hidden
          sx={{
            width: big ? 52 : 44,
            height: big ? 52 : 44,
            borderRadius: big ? "14px" : "12px",
            bgcolor: accentSoft(theme),
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}>
          <Icon iconName={ICON_NAME.SPARKLES} style={{ fontSize: big ? 26 : 22, color: accentText(theme) }} />
        </Box>
        <Typography
          component="h2"
          sx={{
            m: 0,
            mt: "4px",
            fontSize: big ? 28 : 20,
            fontWeight: 800,
            letterSpacing: big ? "-0.6px" : "-0.2px",
            lineHeight: 1.25,
            color: "text.primary",
          }}>
          {t(`assistant_empty_heading_${group}`)}
        </Typography>
        <Typography
          sx={{ fontSize: big ? 15 : 14, lineHeight: 1.5, color: mutedText, maxWidth: big ? 560 : 320 }}>
          {t(`assistant_empty_sub_${group}`)}
        </Typography>
      </Stack>
      <Stack gap="8px">
        <Typography component="h3" sx={{ ...sectionLabelSx, m: 0 }}>
          {t("assistant_starters_label")}
        </Typography>
        <Box
          sx={{
            display: "grid",
            // Full screen shows only from md up (a phone gets the docked layout).
            gridTemplateColumns: big ? "repeat(2, minmax(0, 1fr))" : "minmax(0, 1fr)",
            gap: big ? "12px" : "8px",
          }}>
          {starters.map((starter) => (
            <StarterCard
              key={starter.key}
              starter={starter}
              onClick={() => (starter.draft ? onDraft(`${starter.text} `) : onPick(starter.text))}
            />
          ))}
        </Box>
      </Stack>
      <AiNotice />
      {!big && <RecentConversations />}
    </Stack>
  );
}
