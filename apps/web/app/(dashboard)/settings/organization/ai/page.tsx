"use client";

import { LoadingButton } from "@mui/lab";
import {
  Alert,
  Box,
  Button,
  Chip,
  Divider,
  FormControlLabel,
  IconButton,
  List,
  ListItem,
  ListItemText,
  MenuItem,
  Radio,
  RadioGroup,
  Skeleton,
  Stack,
  Switch,
  TextField,
  Tooltip,
  Typography,
  useTheme,
} from "@mui/material";
import type { TFunction } from "i18next";
import React, { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "react-toastify";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import {
  deleteAssistantConnection,
  refreshAssistantStatus,
  testAssistantConnection,
  updateAssistantSettings,
  useAssistantConnections,
  useAssistantSettings,
} from "@/lib/api/assistant";
import { ASSISTANT_BASE_URL } from "@/lib/constants";
import type { AssistantConnection, AssistantSettingsUpdate, DataPolicy } from "@/lib/validations/assistant";

import ConfirmModal from "@/components/modals/Confirm";
import ConnectionDialog, {
  assistantErrorText,
  providerLabel,
} from "@/components/settings/ai/ConnectionDialog";
import { goatAiDescription } from "@/components/settings/ai/goatAi";

/** The select value of the built-in connection (`active_connection_id` null). */
const GOAT_AI = "goat_ai";
const DATA_POLICIES: DataPolicy[] = ["standard", "restricted"];

/** Why members cannot use AI right now, for the reasons an admin can fix here. */
const STATUS_MESSAGES: Record<string, string> = {
  no_connection: "ai_settings_status_no_connection",
  connection_not_allowed: "ai_settings_status_connection_not_allowed",
  credentials_unreadable: "ai_settings_status_credentials_unreadable",
};

/** The settings request failed: the fetcher attaches the service's answer as `info` and the HTTP status. */
function loadErrorText(
  error: { status?: number; info?: { detail?: { code?: string } } },
  t: TFunction
): string {
  if (error.status === 403) {
    return t(
      error.info?.detail?.code === "no_organization"
        ? "ai_settings_error_no_organization"
        : "ai_settings_admin_only"
    );
  }
  return t("ai_settings_error_generic");
}

function TestChip({ connection }: { connection: AssistantConnection }) {
  const { t } = useTranslation("common");
  if (connection.last_test_ok === true)
    return <Chip size="small" color="success" label={t("ai_settings_test_passed")} />;
  if (connection.last_test_ok === false)
    return <Chip size="small" color="error" label={t("ai_settings_test_failed")} />;
  return <Chip size="small" label={t("ai_settings_not_tested")} />;
}

const AiSettingsPage = () => {
  const theme = useTheme();
  const { t } = useTranslation("common");
  const available = Boolean(ASSISTANT_BASE_URL);
  const { settings, isLoading, error, mutate } = useAssistantSettings(available);
  const { connections, mutate: mutateConnections } = useAssistantConnections(available && !error);
  const [draft, setDraft] = useState<AssistantSettingsUpdate | null>(null);
  const [saving, setSaving] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<AssistantConnection | null>(null);
  const [deleting, setDeleting] = useState<AssistantConnection | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [activatingId, setActivatingId] = useState<string | null>(null);

  useEffect(() => {
    if (settings) {
      setDraft({
        enabled: settings.enabled,
        active_connection_id: settings.active_connection_id,
        data_policy: settings.data_policy,
        allow_default_fallback: settings.allow_default_fallback,
      });
    }
  }, [settings]);

  const dirty = useMemo(
    () =>
      Boolean(settings && draft) &&
      (draft?.enabled !== settings?.enabled ||
        draft?.active_connection_id !== settings?.active_connection_id ||
        draft?.data_policy !== settings?.data_policy ||
        draft?.allow_default_fallback !== settings?.allow_default_fallback),
    [settings, draft]
  );

  if (!available) {
    return (
      <Box sx={{ p: 4 }}>
        <Alert severity="info">{t("ai_settings_unavailable_instance")}</Alert>
      </Box>
    );
  }
  if (error) {
    return (
      <Box sx={{ p: 4 }}>
        <Alert severity="warning">{loadErrorText(error, t)}</Alert>
      </Box>
    );
  }
  if (isLoading || !settings || !draft) {
    return (
      <Box sx={{ p: 4 }}>
        <Stack spacing={4}>
          <Skeleton variant="rectangular" height={56} />
          <Skeleton variant="rectangular" height={160} />
        </Stack>
      </Box>
    );
  }

  // The dock reads in /status whether GOAT AI answers, so it follows a change made here.
  const refresh = async () => {
    await Promise.all([mutate(), mutateConnections(), refreshAssistantStatus()]);
  };

  const persist = async (next: AssistantSettingsUpdate) => {
    await updateAssistantSettings(next);
    await refresh();
    toast.success(t("ai_settings_save_success"));
  };

  const save = async () => {
    setSaving(true);
    try {
      await persist(draft);
    } catch (err) {
      toast.error(assistantErrorText(err, t));
    } finally {
      setSaving(false);
    }
  };

  /**
   * "Use this connection" is the Active connection select plus Save in one step, so it saves the form as it
   * stands with only the active connection swapped: enabled, data policy and fallback stay as they are.
   */
  const activateConnection = async (connection: AssistantConnection) => {
    setActivatingId(connection.id);
    try {
      await persist({ ...draft, active_connection_id: connection.id });
    } catch (err) {
      toast.error(assistantErrorText(err, t));
    } finally {
      setActivatingId(null);
    }
  };

  const runTest = async (connection: AssistantConnection) => {
    setTestingId(connection.id);
    try {
      const result = await testAssistantConnection(connection.id);
      await refresh();
      if (result.last_test_ok) toast.success(t("ai_settings_test_passed"));
      else toast.error(`${t("ai_settings_test_failed")}: ${result.last_test_error ?? ""}`);
    } catch (err) {
      toast.error(assistantErrorText(err, t));
    } finally {
      setTestingId(null);
    }
  };

  const remove = async () => {
    if (!deleting) return;
    try {
      await deleteAssistantConnection(deleting.id);
      toast.success(t("ai_settings_connection_deleted"));
      setDeleting(null);
      await refresh();
    } catch (err) {
      toast.error(assistantErrorText(err, t));
    }
  };

  const busy = saving || activatingId !== null;
  const goatAi = settings.instance.goat_ai;
  const active = connections.find((connection) => connection.id === settings.active_connection_id) ?? null;
  const banner =
    active?.last_test_ok === false
      ? active.last_test_error
        ? t("ai_settings_banner_failed", { error: active.last_test_error })
        : t("ai_settings_banner_failed_no_detail")
      : settings.enabled && STATUS_MESSAGES[settings.status]
        ? t(STATUS_MESSAGES[settings.status])
        : null;
  // Members get GOAT AI while no connection is active, so a passed test alone changes nothing for them.
  const goatAiInUse =
    settings.enabled &&
    goatAi.available &&
    settings.active_connection_id === null &&
    connections.some((connection) => connection.last_test_ok === true);

  return (
    <Box sx={{ p: 4 }}>
      <Stack spacing={theme.spacing(6)}>
        <Divider />
        <Box>
          <Typography variant="body1" fontWeight="bold">
            {t("ai_settings_title")}
          </Typography>
          <Typography variant="caption">{t("ai_settings_description")}</Typography>
        </Box>
        <Divider />
        {banner && <Alert severity="warning">{banner}</Alert>}
        {!settings.instance.secrets_key_configured && (
          <Alert severity="info">{t("ai_settings_secrets_key_missing")}</Alert>
        )}

        <FormControlLabel
          control={
            <Switch
              checked={draft.enabled}
              onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })}
            />
          }
          label={t("ai_settings_enabled_label")}
        />

        <TextField
          select
          label={t("ai_settings_active_connection")}
          value={draft.active_connection_id ?? GOAT_AI}
          disabled={!draft.enabled}
          onChange={(event) => {
            const id = event.target.value === GOAT_AI ? null : event.target.value;
            setDraft({
              ...draft,
              active_connection_id: id,
              allow_default_fallback: id === null ? false : draft.allow_default_fallback,
            });
          }}>
          <MenuItem value={GOAT_AI} disabled={!goatAi.available}>
            <ListItemText
              primary={t("ai_settings_goat_ai")}
              secondary={
                goatAi.available ? goatAiDescription(goatAi, t) : t("ai_settings_goat_ai_unavailable")
              }
            />
          </MenuItem>
          {connections.map((connection) => (
            <MenuItem key={connection.id} value={connection.id} disabled={connection.last_test_ok !== true}>
              <ListItemText
                primary={connection.name}
                secondary={
                  connection.last_test_ok === true ? connection.model : t("ai_settings_connection_needs_test")
                }
              />
            </MenuItem>
          ))}
        </TextField>

        {draft.active_connection_id !== null && goatAi.available && (
          <FormControlLabel
            control={
              <Switch
                checked={draft.allow_default_fallback}
                onChange={(event) => setDraft({ ...draft, allow_default_fallback: event.target.checked })}
              />
            }
            label={
              <Stack>
                <Typography variant="body2">{t("ai_settings_fallback_label")}</Typography>
                <Typography variant="caption" color="text.secondary">
                  {t("ai_settings_fallback_help")}
                </Typography>
              </Stack>
            }
          />
        )}

        <Box>
          <Typography variant="body2" fontWeight="bold">
            {t("ai_settings_data_policy")}
          </Typography>
          <RadioGroup
            value={draft.data_policy}
            onChange={(event) => setDraft({ ...draft, data_policy: event.target.value as DataPolicy })}>
            {DATA_POLICIES.map((policy) => (
              <FormControlLabel
                key={policy}
                value={policy}
                control={<Radio />}
                label={
                  <Stack>
                    <Typography variant="body2">{t(`ai_settings_data_policy_${policy}`)}</Typography>
                    <Typography variant="caption" color="text.secondary">
                      {t(`ai_settings_data_policy_${policy}_help`)}
                    </Typography>
                  </Stack>
                }
              />
            ))}
          </RadioGroup>
        </Box>

        <Stack direction="row" justifyContent="flex-end">
          <LoadingButton
            variant="contained"
            disableElevation
            loading={saving}
            disabled={!dirty || busy}
            onClick={() => void save()}>
            {t("save")}
          </LoadingButton>
        </Stack>

        <Divider />
        <Stack direction="row" justifyContent="space-between" alignItems="center">
          <Box>
            <Typography variant="body1" fontWeight="bold">
              {t("connections")}
            </Typography>
            <Typography variant="caption">{t("ai_settings_connections_description")}</Typography>
          </Box>
          <Tooltip
            title={
              settings.instance.org_connections
                ? ""
                : t(
                    settings.instance.secrets_key_configured
                      ? "ai_settings_org_connections_off"
                      : "ai_settings_secrets_key_missing"
                  )
            }>
            <span>
              <Button
                variant="contained"
                disableElevation
                sx={{ whiteSpace: "nowrap" }}
                startIcon={<Icon iconName={ICON_NAME.PLUS} fontSize="small" />}
                disabled={!settings.instance.org_connections}
                onClick={() => {
                  setEditing(null);
                  setDialogOpen(true);
                }}>
                {t("ai_settings_add_connection")}
              </Button>
            </span>
          </Tooltip>
        </Stack>

        {goatAiInUse && <Alert severity="info">{t("ai_settings_goat_ai_until_active")}</Alert>}

        {connections.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            {t("ai_settings_no_connections")}
          </Typography>
        ) : (
          <List disablePadding>
            {connections.map((connection) => (
              <React.Fragment key={connection.id}>
                <ListItem sx={{ flexWrap: "wrap", justifyContent: "space-between", gap: 2 }}>
                  <ListItemText
                    sx={{ flex: "1 1 320px", minWidth: 0 }}
                    primary={
                      <Stack direction="row" spacing={2} alignItems="center" component="span">
                        <span>{connection.name}</span>
                        {connection.active && <Chip size="small" color="primary" label={t("active")} />}
                        <TestChip connection={connection} />
                        {!connection.tested_model && (
                          <Chip size="small" variant="outlined" label={t("ai_settings_untested_model")} />
                        )}
                      </Stack>
                    }
                    secondaryTypographyProps={{ component: "div" }}
                    secondary={
                      <Stack component="span">
                        <span>{providerLabel(connection.provider, t)}</span>
                        <span>{connection.model}</span>
                        {connection.key_last4 && (
                          <span>{t("ai_settings_key_hint", { last4: connection.key_last4 })}</span>
                        )}
                        {!connection.credentials_readable && (
                          <span>{t("ai_settings_credentials_unreadable")}</span>
                        )}
                        {connection.last_test_ok === false && connection.last_test_error && (
                          <span>{connection.last_test_error}</span>
                        )}
                      </Stack>
                    }
                  />
                  <Stack direction="row" spacing={1} alignItems="center">
                    {connection.last_test_ok === true && !connection.active && (
                      <LoadingButton
                        size="small"
                        variant="contained"
                        disableElevation
                        loading={activatingId === connection.id}
                        disabled={busy || testingId === connection.id}
                        onClick={() => void activateConnection(connection)}>
                        {t("ai_settings_use_connection")}
                      </LoadingButton>
                    )}
                    <LoadingButton
                      size="small"
                      loading={testingId === connection.id}
                      onClick={() => void runTest(connection)}>
                      {t("ai_settings_test_connection")}
                    </LoadingButton>
                    <Tooltip title={t("edit")}>
                      <IconButton
                        size="small"
                        aria-label={t("edit")}
                        onClick={() => {
                          setEditing(connection);
                          setDialogOpen(true);
                        }}>
                        <Icon iconName={ICON_NAME.EDIT} style={{ fontSize: 16 }} />
                      </IconButton>
                    </Tooltip>
                    <Tooltip
                      title={
                        connection.active
                          ? t("ai_settings_delete_active_blocked")
                          : t("ai_settings_delete_connection")
                      }>
                      <span>
                        <IconButton
                          size="small"
                          color="error"
                          aria-label={t("ai_settings_delete_connection")}
                          disabled={connection.active}
                          onClick={() => setDeleting(connection)}>
                          <Icon iconName={ICON_NAME.TRASH} style={{ fontSize: 16 }} />
                        </IconButton>
                      </span>
                    </Tooltip>
                  </Stack>
                </ListItem>
                <Divider />
              </React.Fragment>
            ))}
          </List>
        )}
      </Stack>

      <ConnectionDialog
        open={dialogOpen}
        connection={editing}
        allowedProviders={settings.instance.allowed_providers}
        allowHttp={settings.instance.private_endpoints}
        onClose={() => setDialogOpen(false)}
        onSaved={refresh}
      />
      <ConfirmModal
        open={deleting !== null}
        title={t("ai_settings_delete_connection")}
        body={deleting ? t("ai_settings_delete_confirm", { name: deleting.name }) : ""}
        onClose={() => setDeleting(null)}
        onConfirm={() => void remove()}
        closeText={t("cancel")}
        confirmText={t("delete")}
      />
    </Box>
  );
};

export default AiSettingsPage;
