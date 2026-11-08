"use client";

import { Alert, Typography } from "@mui/material";
import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "react-toastify";

import {
  deleteAssistantConnection,
  refreshAssistantStatus,
  testAssistantConnection,
  updateAssistantSettings,
  useAssistantConnections,
  useAssistantSettings,
} from "@/lib/api/assistant";
import { useCreditBalance } from "@/lib/api/usage";
import { useFeatures } from "@/lib/api/users";
import { undoToast } from "@/lib/toasts";
import { formatCredits } from "@/lib/utils/credits";
import type {
  AssistantConnection,
  AssistantSettings,
  AssistantSettingsUpdate,
  DataPolicy,
} from "@/lib/validations/assistant";

import { ConfirmLoadFailed, DialogLoadFailed, orLoadFailed } from "@/components/assistant/LoadFailed";
import PageHeader from "@/components/dashboard/common/PageHeader";
import AiSwitchCard, { type AiCredits } from "@/components/settings/ai/AiSwitchCard";
import ConnectionsCard from "@/components/settings/ai/ConnectionsCard";
import DataPolicyCard from "@/components/settings/ai/DataPolicyCard";
import {
  STATUS_MESSAGES,
  assistantErrorText,
  loadErrorText,
} from "@/components/settings/ai/aiSettingsErrors";
import CardSkeleton from "@/components/settings/common/CardSkeleton";
import SettingsLoadError from "@/components/settings/common/SettingsLoadError";
import SettingsPage from "@/components/settings/common/SettingsPage";

// Loaded on first open (L5). A dialog whose code does not load (a deploy
// since the page opened) shows a notice instead of taking the page down.
const ConnectionDialog = dynamic(
  () => orLoadFailed(import("@/components/settings/ai/ConnectionDialog"), DialogLoadFailed),
  { ssr: false }
);
const ConfirmModal = dynamic(() => orLoadFailed(import("@/components/modals/Confirm"), ConfirmLoadFailed), {
  ssr: false,
});

const PLAIN = { interpolation: { escapeValue: false } } as const;

/** The four fields of PUT /settings as they are. */
const fieldsOf = (settings: AssistantSettings): AssistantSettingsUpdate => ({
  enabled: settings.enabled,
  active_connection_id: settings.active_connection_id,
  data_policy: settings.data_policy,
  allow_default_fallback: settings.allow_default_fallback,
});

/** What a save came to: `busy` when another save of the page still runs and this one was not sent. */
type PutResult = "saved" | "failed" | "busy";

/**
 * Organisation › KI (owners and admins, with the assistant; the shell guards
 * both). Every switch and choice saves at once (no Speichern, decision 15):
 * the page shows the new value while it saves and puts the old one back when
 * the save fails. The AI switch and the active connection can be undone
 * (decision 16). Every change reads the settings, the connections and the
 * dock's /status again.
 */
export default function AiPage() {
  const { t, i18n } = useTranslation("common");
  const { settings, error, mutate } = useAssistantSettings(true);
  // Read together with the settings (L4); not once they were refused. A
  // failed re-read of the settings keeps the list (SWR keeps the old data).
  const refused = error?.status === 403;
  const {
    connections,
    isLoading: connectionsLoading,
    error: connectionsError,
    mutate: mutateConnections,
  } = useAssistantConnections(!refused);
  const { features } = useFeatures();
  const billing = features?.billing === true;
  const { balance, isError: balanceError, mutate: mutateBalance } = useCreditBalance(billing);
  const [pending, setPending] = useState<Partial<AssistantSettingsUpdate> | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<AssistantConnection | "new" | null>(null);
  const [deleting, setDeleting] = useState<AssistantConnection | null>(null);
  const [removing, setRemoving] = useState(false);
  // An undo runs up to 7 seconds later: it changes the settings as they are
  // then, not as they were when its toast opened.
  const latest = useRef(settings);
  useEffect(() => {
    latest.current = settings;
  }, [settings]);
  // One save at a time: a second one would send the fields before the first
  // was read back, and put the first change back.
  const saving = useRef(false);

  const header = (
    <PageHeader
      level={2}
      responsive
      eyebrow={t("settings_nav_group_organization")}
      title={t("settings_ai_title")}
      subtitle={t("settings_ai_subtitle")}
    />
  );

  // SWR keeps the error while it tries again (and sets isLoading then): the
  // notice stays instead of turning into skeletons on every retry.
  if (!settings && error) {
    return (
      <SettingsPage header={header}>
        {/* Refused: a retry would be refused again, so the reason stands alone. */}
        {refused ? (
          <Alert severity="warning">{loadErrorText(error, t)}</Alert>
        ) : (
          <SettingsLoadError onRetry={() => void mutate()} />
        )}
      </SettingsPage>
    );
  }
  if (!settings) {
    return (
      <SettingsPage header={header}>
        <CardSkeleton title={t("settings_ai_switch_title")} rows={1} variant="list" />
        <CardSkeleton title={t("settings_ai_answers_title")} rows={2} variant="list" />
        <CardSkeleton
          title={t("settings_ai_policy_title")}
          hint={t("settings_ai_policy_hint")}
          rows={1}
          variant="list"
        />
      </SettingsPage>
    );
  }

  const view: AssistantSettings = { ...settings, ...pending };
  // SWR keeps the error while it tries again (and sets isLoading then): the
  // retry and the nameless switch line stay instead of flipping to skeletons.
  // A failed re-read keeps the list it has (SWR keeps the old data).
  const connectionsFailed = !!connectionsError && connections.length === 0;
  const connectionsWaiting = connectionsLoading && !connectionsError;
  // A read that fails keeps its error in SWR; the change itself is saved.
  const refreshOthers = () =>
    Promise.all([mutateConnections(), refreshAssistantStatus()]).catch(() => undefined);
  const refresh = () => Promise.all([mutate().catch(() => undefined), refreshOthers()]);

  /** PUT /settings with the four fields as they are and `patch` changed; a failure puts the old value back. */
  const put = async (patch: Partial<AssistantSettingsUpdate>): Promise<PutResult> => {
    const current = latest.current;
    if (!current) return "failed";
    if (saving.current) return "busy";
    saving.current = true;
    setPending(patch);
    const body = { ...fieldsOf(current), ...patch };
    // Without GOAT AI the fallback has nothing to fall back to, and the
    // service refuses it (`goat_ai_unavailable`): a stored one would make
    // every change on this page fail, whatever the patch carries.
    body.allow_default_fallback &&= current.instance.goat_ai.available;
    let saved: AssistantSettings;
    try {
      saved = await updateAssistantSettings(body);
    } catch (err) {
      toast.error(assistantErrorText(err, t));
      saving.current = false;
      setPending(null);
      return "failed";
    }
    // The answer is the stored settings: no second read of them. The new
    // value stays in sight until the rest is read back.
    await mutate(saved, { revalidate: false });
    await refreshOthers();
    saving.current = false;
    setPending(null);
    return "saved";
  };
  /** An undo is a save: one dropped because another save runs fails, and its toast says so. */
  const undoPut = (patch: Partial<AssistantSettingsUpdate>) => async () => {
    if ((await put(patch)) === "busy") throw new Error("Another save of the AI settings runs.");
  };
  const nameOf = (id: string | null): string | null =>
    id === null
      ? t("ai_settings_goat_ai")
      : (connections.find((connection) => connection.id === id)?.name ?? null);

  const toggle = async (enabled: boolean) => {
    if ((await put({ enabled })) === "saved") {
      undoToast(
        t(enabled ? "settings_ai_turned_on" : "settings_ai_turned_off"),
        undoPut({ enabled: !enabled }),
        t
      );
    }
  };
  const choose = async (id: string | null) => {
    if (id === settings.active_connection_id) return;
    const previous = {
      active_connection_id: settings.active_connection_id,
      allow_default_fallback: settings.allow_default_fallback,
    };
    const name = nameOf(id) ?? "";
    // GOAT AI has nothing to fall back to.
    const patch = {
      active_connection_id: id,
      allow_default_fallback: id === null ? false : settings.allow_default_fallback,
    };
    if ((await put(patch)) === "saved") {
      undoToast(t("settings_ai_switched", { name, ...PLAIN }), undoPut(previous), t);
    }
  };
  /** Testen: the result is stored by the service, so the list is read again either way. */
  const test = async (connection: AssistantConnection) => {
    setTestingId(connection.id);
    let say: () => void;
    try {
      const result = await testAssistantConnection(connection.id);
      say = result.last_test_ok
        ? () => toast.success(t("settings_ai_test_passed", { name: connection.name, ...PLAIN }))
        : () =>
            toast.error(
              result.last_test_error
                ? t("settings_ai_test_failed", { error: result.last_test_error, ...PLAIN })
                : t("ai_settings_test_failed")
            );
    } catch (err) {
      say = () => toast.error(assistantErrorText(err, t));
    }
    await refresh();
    setTestingId(null);
    say();
  };
  const remove = async (connection: AssistantConnection) => {
    setRemoving(true);
    try {
      await deleteAssistantConnection(connection.id);
    } catch (err) {
      toast.error(assistantErrorText(err, t));
      setRemoving(false);
      return;
    }
    await refresh();
    setRemoving(false);
    setDeleting(null);
    toast.success(t("ai_settings_connection_deleted"));
  };

  const active = connections.find((connection) => connection.id === view.active_connection_id) ?? null;
  const banner =
    active?.last_test_ok === false
      ? active.last_test_error
        ? t("ai_settings_banner_failed", { error: active.last_test_error, ...PLAIN })
        : t("ai_settings_banner_failed_no_detail")
      : view.enabled && STATUS_MESSAGES[view.status]
        ? t(STATUS_MESSAGES[view.status])
        : null;
  const credits: AiCredits | null = !billing
    ? null
    : balance
      ? {
          state: "ready",
          used: formatCredits(balance.used_ai_credits, i18n.language),
          total:
            balance.total_ai_credits === null ? null : formatCredits(balance.total_ai_credits, i18n.language),
        }
      : balanceError
        ? { state: "failed", retry: () => void mutateBalance() }
        : { state: "loading" };

  return (
    <SettingsPage header={header}>
      {banner && <Alert severity="warning">{banner}</Alert>}
      {!view.instance.secrets_key_configured && (
        <Alert severity="info">{t("ai_settings_secrets_key_missing")}</Alert>
      )}
      <AiSwitchCard
        enabled={view.enabled}
        answeringName={nameOf(view.active_connection_id)}
        nameLoading={connectionsWaiting}
        credits={credits}
        disabled={pending !== null}
        onToggle={(enabled) => void toggle(enabled)}
      />
      <ConnectionsCard
        settings={view}
        connections={connections}
        loading={connectionsWaiting}
        saving={pending !== null}
        onRetry={connectionsFailed ? () => void mutateConnections() : null}
        testingId={testingId}
        onChoose={(id) => void choose(id)}
        onNeedsTest={() => toast.info(t("settings_ai_needs_test"))}
        onTest={(connection) => void test(connection)}
        onAdd={() => setDialog("new")}
        onEdit={(connection) => setDialog(connection)}
        onDelete={setDeleting}
        onFallback={(on) => {
          void put({ allow_default_fallback: on }).then(
            (result) =>
              result === "saved" &&
              toast.success(t(on ? "settings_ai_fallback_on" : "settings_ai_fallback_off"))
          );
        }}
      />
      <DataPolicyCard
        value={view.data_policy}
        disabled={pending !== null}
        onChange={(policy: DataPolicy) => {
          void put({ data_policy: policy }).then(
            (result) =>
              result === "saved" &&
              toast.success(
                t("settings_ai_policy_saved", { name: t(`ai_settings_data_policy_${policy}`), ...PLAIN })
              )
          );
        }}
      />
      <Typography variant="caption" color="text.secondary">
        {t("settings_ai_footnote")}
      </Typography>
      {dialog !== null && (
        <ConnectionDialog
          open
          connection={dialog === "new" ? null : dialog}
          allowedProviders={view.instance.allowed_providers}
          allowHttp={view.instance.private_endpoints}
          onClose={() => setDialog(null)}
          // Speichern und testen: the list shows the saved connection, the
          // dialog closes, then the test runs as "Testen" does.
          onSaved={async (saved) => {
            await refresh();
            setDialog(null);
            void test(saved);
          }}
        />
      )}
      {deleting && (
        <ConfirmModal
          open
          title={t("ai_settings_delete_confirm", { name: deleting.name, ...PLAIN })}
          body={t("settings_ai_delete_body")}
          closeText={t("cancel")}
          confirmText={t("ai_settings_delete_connection")}
          loading={removing}
          onClose={() => {
            if (!removing) setDeleting(null);
          }}
          onConfirm={() => void remove(deleting)}
        />
      )}
    </SettingsPage>
  );
}
