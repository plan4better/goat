"use client";

import ErrorOutline from "@mui/icons-material/ErrorOutline";
import { Box, Button, CircularProgress, Stack, Typography, alpha, useTheme } from "@mui/material";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { refreshConversationLists } from "@/lib/assistant/conversations";
import { assistantErrorKey, toRequestError } from "@/lib/assistant/errors";
import {
  clearFirstMessage,
  getDockState,
  openConversation,
  peekFirstMessage,
  removePendingRun,
  useActiveSurface,
  useDockState,
} from "@/lib/assistant/store";
import { useProjectSurfaceWait } from "@/lib/assistant/surface";
import { fetchConversation } from "@/lib/assistant/transport";
import type { AssistantMessage, ConversationDetail } from "@/lib/assistant/types";

import ChatView, { type ReadOnlyReason } from "@/components/assistant/ChatView";
import { neutralPillSx, pillButtonSx } from "@/components/assistant/styles";

/** Spec §10: a bound conversation continues only in its project, and not after access was lost. */
export function readOnlyReason(
  detail: ConversationDetail,
  currentProjectId: string | null
): ReadOnlyReason | null {
  if (detail.access === "lost") return { kind: "lost" };
  const bound = detail.conversation.project_id;
  if (bound && bound !== currentProjectId)
    return { kind: "elsewhere", projectId: bound, projectName: detail.projectName };
  return null;
}

/**
 * What a user who lost access still sees: their own words, without the
 * answers, tool results or page context (the server's `_without_answers`).
 */
export function withoutAnswers(messages: AssistantMessage[]): AssistantMessage[] {
  return messages
    .filter((message) => message.role === "user")
    .map((message) => ({ ...message, parts: message.parts.filter((part) => part.type === "text") }));
}

type Loaded =
  | { status: "loading" }
  | { status: "error"; conversationId: string; key: string }
  | { status: "ready"; conversationId: string; detail: ConversationDetail };

/** The message that created the conversation, until its chat sent it. */
type First = { conversationId: string; message: ReturnType<typeof peekFirstMessage>; consumed: boolean };
const firstOf = (conversationId: string): First => ({
  conversationId,
  message: peekFirstMessage(conversationId),
  consumed: false,
});

/**
 * Loads a conversation and mounts its chat; a reconnect loads it again into a
 * fresh chat. A binding the chat or the dock caused is applied here at once,
 * so the conversation is read only elsewhere without a reload (spec §10).
 */
export default function ConversationPane({
  conversationId,
  big,
  onLoaded,
}: {
  conversationId: string;
  big?: boolean;
  /** The loaded conversation (the dock's header shows its title). */
  onLoaded?: (detail: ConversationDetail) => void;
}) {
  const { t } = useTranslation("common");
  const theme = useTheme();
  const surface = useActiveSurface();
  const pathname = usePathname();
  // Until a project page's project registered (or the bounded wait ended), which project the
  // user is in is not known yet: the footer waits (the chat stays mounted, so a running answer
  // keeps streaming).
  const waiting = useProjectSurfaceWait(pathname, surface);
  const dock = useDockState();
  const [generation, setGeneration] = useState(0);
  const [loaded, setLoaded] = useState<Loaded>({ status: "loading" });
  const [binding, setBinding] = useState<{ projectId: string; name: string | null } | null>(null);
  /**
   * A refusal said the user lost access to a project of the conversation: the
   * chat's messages at that moment, which include what was sent since the load.
   */
  const [lostWith, setLostWith] = useState<AssistantMessage[] | null>(null);
  const accessLost = lostWith !== null;
  const [first, setFirst] = useState(() => firstOf(conversationId));
  if (first.conversationId !== conversationId) {
    // Reused for another conversation: never carry the previous one's first message over.
    setFirst(firstOf(conversationId));
  }
  const reportLoaded = useRef(onLoaded);
  useEffect(() => {
    reportLoaded.current = onLoaded;
  });

  useEffect(() => {
    let alive = true;
    setLoaded({ status: "loading" });
    fetchConversation(conversationId).then(
      (detail) => {
        if (!alive) return;
        // A run that ended meanwhile (a reload keeps pending runs) shows here: nothing left to
        // announce, and the history may still mark it as running.
        if (
          !detail.activeRunId &&
          getDockState().pending.some((run) => run.conversationId === conversationId)
        ) {
          removePendingRun(conversationId);
          void refreshConversationLists();
        }
        setBinding(null);
        setLostWith(null);
        setLoaded({ status: "ready", conversationId, detail });
        reportLoaded.current?.(detail);
      },
      (error: unknown) => {
        if (!alive) return;
        // Deleted, or not this user's (a tab keeps the dock across a sign-out): there is
        // nothing to retry, so the dock starts a new conversation instead.
        if (toRequestError(error)?.code === "conversation_not_found") {
          openConversation(null);
          return;
        }
        setLoaded({ status: "error", conversationId, key: assistantErrorKey(error) });
      }
    );
    return () => {
      alive = false;
    };
  }, [conversationId, generation]);

  // A state loaded for a previous conversation id counts as loading.
  if (loaded.status === "loading" || loaded.conversationId !== conversationId) {
    return (
      <Box sx={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <CircularProgress size={20} />
      </Box>
    );
  }
  if (loaded.status === "error") {
    return (
      <Stack
        role="alert"
        alignItems="center"
        justifyContent="center"
        gap="10px"
        sx={{ height: "100%", px: 4, py: 6, textAlign: "center" }}>
        <Box
          sx={{
            width: 44,
            height: 44,
            borderRadius: "50%",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            bgcolor: alpha(theme.palette.error.main, 0.12),
            color: "error.main",
          }}>
          <ErrorOutline fontSize="small" />
        </Box>
        <Typography sx={{ fontSize: 15, fontWeight: 700 }}>{t("assistant_load_failed_title")}</Typography>
        <Typography sx={{ fontSize: 13, color: "text.secondary", maxWidth: 320 }}>{t(loaded.key)}</Typography>
        <Stack direction="row" gap="8px" sx={{ mt: "6px" }}>
          <Button
            size="small"
            variant="outlined"
            color="inherit"
            onClick={() => setGeneration((n) => n + 1)}
            sx={{ ...neutralPillSx(theme), "&&": { ...pillButtonSx["&&"], px: "14px", py: "5px" } }}>
            {t("assistant_retry")}
          </Button>
          <Button
            size="small"
            variant="contained"
            onClick={() => openConversation(null)}
            sx={{ ...pillButtonSx, "&&": { ...pillButtonSx["&&"], px: "14px", py: "5px" } }}>
            {t("assistant_new_conversation")}
          </Button>
        </Stack>
      </Stack>
    );
  }
  // A binding the chat caused, or one the dock made ("Open in project to review").
  const dockBinding =
    dock.bound?.conversationId === conversationId
      ? { projectId: dock.bound.projectId, name: dock.bound.projectName }
      : null;
  const applied = binding ?? dockBinding;
  const bound: ConversationDetail = applied
    ? {
        ...loaded.detail,
        conversation: { ...loaded.detail.conversation, project_id: applied.projectId },
        projectName: applied.name ?? loaded.detail.projectName,
      }
    : loaded.detail;
  // Learned from a refusal: hidden as after a reload, nothing runs for this user any more.
  const detail: ConversationDetail = accessLost
    ? { ...bound, access: "lost", activeRunId: null, messages: withoutAnswers(lostWith) }
    : bound;
  const sendFirst =
    first.conversationId === conversationId &&
    !first.consumed &&
    first.message?.conversationId === conversationId
      ? first.message
      : null;
  return (
    <ChatView
      // A chat takes its messages at mount: lost access mounts a fresh one with the user's words only.
      key={`${conversationId}:${generation}${accessLost ? ":lost" : ""}`}
      conversationId={conversationId}
      title={detail.conversation.title ?? ""}
      projectId={detail.conversation.project_id}
      projectName={detail.projectName}
      initialMessages={detail.messages}
      initialFeedback={detail.feedback}
      activeRunId={detail.activeRunId}
      // Only a run that is going on needs re-attaching; a new conversation sends right away.
      resume={!sendFirst && detail.activeRunId !== null}
      waiting={waiting}
      readOnly={readOnlyReason(detail, surface?.project?.id ?? null)}
      // The stored object itself: its identity never changes, so ChatView arms its send once.
      firstMessage={sendFirst}
      onFirstMessageSent={() => {
        setFirst((current) =>
          current.conversationId === conversationId ? { ...current, consumed: true } : current
        );
        clearFirstMessage(conversationId);
      }}
      onReconnect={() => {
        // Unmount the chat at once: the next one mounts with what the server stored.
        setLoaded({ status: "loading" });
        setGeneration((n) => n + 1);
      }}
      onBound={(projectId, name) => setBinding({ projectId, name })}
      onAccessLost={(messages) => setLostWith(messages)}
      big={big}
    />
  );
}
