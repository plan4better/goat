"use client";

import { LoadingButton } from "@mui/lab";
import { Box, Button, Skeleton, Stack, Tooltip, Typography } from "@mui/material";
import { visuallyHidden } from "@mui/utils";
import { useId } from "react";
import { useTranslation } from "react-i18next";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import { type AssistantConnection, type AssistantSettings, providerName } from "@/lib/validations/assistant";

import StatusPill, { type StatusTone } from "@/components/common/StatusPill";
import { goatAiDescription } from "@/components/settings/ai/goatAi";
import RadioCardGroup, { type RadioCardOption } from "@/components/settings/common/RadioCardGroup";
import RowMenu from "@/components/settings/common/RowMenu";
import SettingsCard from "@/components/settings/common/SettingsCard";
import SettingsLoadError from "@/components/settings/common/SettingsLoadError";
import SwitchRow from "@/components/settings/common/SwitchRow";
import { UsageMark } from "@/components/settings/usage/UsageMark";

/** The radio value of the included connection (`active_connection_id` null). */
export const GOAT_AI = "goat_ai";
const PLAIN = { interpolation: { escapeValue: false } } as const;

/** The name and its pills, the pills apart by a space so the radio's name reads them as words. */
const NameWithPills = ({ name, pills }: { name: string; pills: { text: string; tone: StatusTone }[] }) => (
  <Box
    component="span"
    sx={{ display: "flex", flexWrap: "wrap", alignItems: "center", columnGap: 2, rowGap: 1 }}>
    <Box component="span" sx={{ overflowWrap: "anywhere" }}>
      {name}
    </Box>
    {pills.map((pill) => (
      <Box component="span" key={pill.text}>
        {" "}
        <StatusPill tone={pill.tone}>{pill.text}</StatusPill>
      </Box>
    ))}
  </Box>
);

/** "Womit der Assistent antwortet": GOAT AI and the own connections as one radio group; a pick saves at once
 * (the page), an own connection is chosen only after a passed test, the fallback switch sits under the
 * active own connection. */
export default function ConnectionsCard({
  settings,
  connections,
  loading,
  saving,
  onRetry,
  testingId,
  onChoose,
  onNeedsTest,
  onTest,
  onAdd,
  onEdit,
  onDelete,
  onFallback,
}: {
  settings: AssistantSettings;
  connections: AssistantConnection[];
  /** The connections are not read yet. */
  loading: boolean;
  /** A change of the settings is being saved: no other choice until it is. */
  saving: boolean;
  /** Reading the connections failed: retries it. */
  onRetry: (() => void) | null;
  testingId: string | null;
  onChoose: (connectionId: string | null) => void;
  onNeedsTest: () => void;
  onTest: (connection: AssistantConnection) => void;
  onAdd: () => void;
  onEdit: (connection: AssistantConnection) => void;
  onDelete: (connection: AssistantConnection) => void;
  onFallback: (on: boolean) => void;
}) {
  const { t } = useTranslation("common");
  const reasonId = useId();
  const goatAi = settings.instance.goat_ai;
  const addDisabledReason = !settings.instance.secrets_key_configured
    ? t("ai_settings_secrets_key_missing")
    : !settings.instance.org_connections
      ? t("ai_settings_org_connections_off")
      : null;

  const testPill = (connection: AssistantConnection): { text: string; tone: StatusTone } =>
    testingId === connection.id
      ? { text: t("settings_ai_testing"), tone: "neutral" }
      : connection.last_test_ok === true
        ? { text: t("ai_settings_test_passed"), tone: "success" }
        : connection.last_test_ok === false
          ? { text: t("ai_settings_test_failed"), tone: "error" }
          : { text: t("ai_settings_not_tested"), tone: "neutral" };

  const options: RadioCardOption<string>[] = [
    {
      value: GOAT_AI,
      lead: <UsageMark icon={ICON_NAME.SPARKLES} tone="primary" />,
      label: (
        <NameWithPills
          name={t("ai_settings_goat_ai")}
          pills={
            settings.enabled && settings.active_connection_id === null && goatAi.available
              ? [{ text: t("settings_ai_active"), tone: "primary" }]
              : []
          }
        />
      ),
      // Where GOAT AI is hosted, never its model or provider (decision 9).
      line: goatAi.available ? goatAiDescription(goatAi, t) : t("ai_settings_goat_ai_unavailable"),
      disabled: saving || !settings.enabled || !goatAi.available,
    },
    ...connections.map((connection): RadioCardOption<string> => {
      const active = connection.id === settings.active_connection_id;
      return {
        value: connection.id,
        lead: (
          <UsageMark
            icon={connection.provider === "openai_compatible" ? ICON_NAME.DATABASE : ICON_NAME.LOCK}
            tone="neutral"
          />
        ),
        label: (
          <NameWithPills
            name={connection.name}
            pills={[
              ...(active && settings.enabled
                ? [{ text: t("settings_ai_active"), tone: "primary" as const }]
                : []),
              testPill(connection),
              ...(connection.tested_model
                ? []
                : [{ text: t("ai_settings_untested_model"), tone: "warning" as const }]),
            ]}
          />
        ),
        line: (
          <>
            <Box component="span" sx={{ display: "block", overflowWrap: "anywhere" }}>
              {`${providerName(connection.provider, t("ai_settings_provider_openai_compatible"))} · ${connection.model}`}
            </Box>
            {connection.key_last4 && (
              <Box component="span" sx={{ display: "block" }}>
                {t("ai_settings_key_hint", { last4: connection.key_last4 })}
              </Box>
            )}
            {!connection.credentials_readable && (
              <Box component="span" sx={{ display: "block" }}>
                {t("ai_settings_credentials_unreadable")}
              </Box>
            )}
            {connection.last_test_ok === false && connection.last_test_error && (
              <Box component="span" sx={{ display: "block", color: "error.main", overflowWrap: "anywhere" }}>
                {connection.last_test_error}
              </Box>
            )}
          </>
        ),
        disabled: saving || !settings.enabled || connection.last_test_ok !== true,
        actions: (
          <>
            <LoadingButton
              size="small"
              variant="outlined"
              loading={testingId === connection.id}
              disabled={testingId !== null && testingId !== connection.id}
              onClick={() => onTest(connection)}
              sx={{ whiteSpace: "nowrap" }}>
              {t("settings_ai_test")}
            </LoadingButton>
            <RowMenu
              label={t("settings_more_actions_for", { name: connection.name, ...PLAIN })}
              items={[
                {
                  key: "edit",
                  label: t("settings_ai_edit"),
                  icon: ICON_NAME.EDIT,
                  onClick: () => onEdit(connection),
                },
                {
                  key: "delete",
                  label: t("ai_settings_delete_connection"),
                  icon: ICON_NAME.TRASH,
                  danger: true,
                  disabled: active,
                  reason: active ? t("settings_ai_delete_active_reason") : undefined,
                  onClick: () => onDelete(connection),
                },
              ]}
            />
          </>
        ),
        extra:
          active && goatAi.available ? (
            <SwitchRow
              id="ai-fallback"
              label={t("ai_settings_fallback_label")}
              line={t("ai_settings_fallback_help")}
              checked={settings.allow_default_fallback}
              disabled={saving}
              onChange={onFallback}
            />
          ) : undefined,
      };
    }),
  ];

  return (
    <SettingsCard
      title={t("settings_ai_answers_title")}
      hint={t(settings.enabled ? "settings_ai_answers_hint" : "settings_ai_answers_hint_off")}
      action={
        <Tooltip title={addDisabledReason ?? ""}>
          <span>
            <Button
              size="small"
              variant="outlined"
              disabled={!!addDisabledReason}
              aria-describedby={addDisabledReason ? reasonId : undefined}
              startIcon={<Icon iconName={ICON_NAME.PLUS} style={{ fontSize: 14 }} htmlColor="inherit" />}
              onClick={onAdd}
              sx={{ whiteSpace: "nowrap" }}>
              {t("settings_ai_own_connection")}
            </Button>
            {addDisabledReason && (
              <Box component="span" id={reasonId} sx={visuallyHidden}>
                {addDisabledReason}
              </Box>
            )}
          </span>
        </Tooltip>
      }>
      {onRetry ? (
        <SettingsLoadError onRetry={onRetry} />
      ) : loading ? (
        <Stack spacing={3} role="status" aria-busy="true" aria-label={t("settings_nav_loading")}>
          {[0, 1].map((index) => (
            <Skeleton key={index} variant="rounded" height={72} sx={{ borderRadius: "12px" }} />
          ))}
        </Stack>
      ) : (
        <>
          <RadioCardGroup<string>
            label={t("settings_ai_answers_title")}
            // Without GOAT AI and an own connection nothing answers: no card is chosen.
            value={settings.active_connection_id ?? (goatAi.available ? GOAT_AI : null)}
            options={options}
            onChange={(next) => onChoose(next === GOAT_AI ? null : next)}
            onDisabledClick={(next) => {
              // AI off: nothing can be chosen, and the hint says so. The active
              // connection is in use already; when it failed, the banner says so.
              if (saving || !settings.enabled || next === GOAT_AI || next === settings.active_connection_id)
                return;
              if (connections.find((connection) => connection.id === next)?.last_test_ok !== true)
                onNeedsTest();
            }}
          />
          {connections.length === 0 && (
            <Typography variant="body2" color="text.secondary" sx={{ mt: 3 }}>
              {t("settings_ai_no_own")}
            </Typography>
          )}
        </>
      )}
    </SettingsCard>
  );
}
