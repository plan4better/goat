"use client";

import {
  Alert,
  Box,
  Chip,
  CircularProgress,
  DialogContentText,
  IconButton,
  InputAdornment,
  List,
  ListItem,
  ListItemButton,
  Menu,
  MenuItem,
  Stack,
  TextField,
  Typography,
  alpha,
  useTheme,
} from "@mui/material";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "react-toastify";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import { useDateFnsLocale } from "@/i18n/utils";

import { plain, plainTranslate } from "@/lib/assistant/chips";
import {
  deleteConversation,
  refreshConversationLists,
  updateConversation,
  useConversations,
} from "@/lib/assistant/conversations";
import { assistantErrorKey } from "@/lib/assistant/errors";
import { conversationTitle, groupByDay, historyDate, originLabel } from "@/lib/assistant/history";
import {
  clearDraft,
  getDockState,
  openConversation,
  removePendingRun,
  useActiveSurface,
  useDockState,
} from "@/lib/assistant/store";
import type { ConversationSummary } from "@/lib/assistant/types";

import { CARD_RADIUS, accentSoft, accentText, focusRing, mutedText } from "@/components/assistant/styles";
import AppDialog, { AppDialogFooter } from "@/components/common/AppDialog";
import NameDialog from "@/components/dashboard/common/NameDialog";
import { surfaceShadows } from "@/components/dashboard/common/surfaceShadows";

const SEARCH_DELAY_MS = 300;

/**
 * The global history (spec §10): search, a This project / All chip inside a
 * project ("This project" first), origin labels, rename and delete.
 */
export default function ConversationHistory({
  onPicked,
  variant = "menu",
}: {
  onPicked?: () => void;
  /** `sidebar`: the full-screen view's left column, which draws its own frame. */
  variant?: "menu" | "sidebar";
}) {
  const { t } = useTranslation("common");
  const theme = useTheme();
  const sidebar = variant === "sidebar";
  // Interpolated user text is not escaped twice (React escapes it; nothing here renders HTML).
  const translate = plainTranslate(t);
  const dateLocale = useDateFnsLocale();
  const surface = useActiveSurface();
  const dock = useDockState();
  const projectId = surface?.project?.id ?? null;
  const [scope, setScope] = useState<"project" | "all">(projectId ? "project" : "all");
  const [scopeFor, setScopeFor] = useState(projectId);
  if (scopeFor !== projectId) {
    setScopeFor(projectId);
    setScope(projectId ? "project" : "all");
  }
  const [query, setQuery] = useState("");
  const [q, setQ] = useState("");
  useEffect(() => {
    const id = window.setTimeout(() => setQ(query.trim()), SEARCH_DELAY_MS);
    return () => window.clearTimeout(id);
  }, [query]);
  const { conversations, isLoading, error } = useConversations({
    projectId: scope === "project" ? projectId : null,
    q,
  });
  /** The dialog a menu pick asked for, opened when the menu has closed. */
  const picked = useRef<{ kind: "rename" | "delete"; conversation: ConversationSummary } | null>(null);
  const [menu, setMenu] = useState<{ anchor: HTMLElement; conversation: ConversationSummary } | null>(null);
  const [renaming, setRenaming] = useState<ConversationSummary | null>(null);
  const [deleting, setDeleting] = useState<ConversationSummary | null>(null);
  const groups = groupByDay(conversations);

  const when = (conversation: ConversationSummary) => historyDate(conversation.updated_at, dateLocale);

  /** Rejects with the reason, which the rename dialog shows under its field. */
  const rename = async (conversation: ConversationSummary, name: string) => {
    try {
      await updateConversation(conversation.id, { title: name });
    } catch (err) {
      throw new Error(t(assistantErrorKey(err)));
    }
    void refreshConversationLists();
    setRenaming(null);
  };

  const remove = async () => {
    if (!deleting) return;
    const id = deleting.id;
    setDeleting(null);
    try {
      await deleteConversation(id);
      // Nothing of it is kept: no unsent text, no run to announce.
      clearDraft(id);
      removePendingRun(id);
      if (getDockState().conversationId === id) openConversation(null);
      void refreshConversationLists();
    } catch (err) {
      toast.error(t(assistantErrorKey(err)));
    }
  };

  const row = (conversation: ConversationSummary) => {
    const selected = conversation.id === dock.conversationId;
    return (
      <ListItem
        key={conversation.id}
        disablePadding
        sx={{
          position: "relative",
          // The actions button takes the time's place on hover and focus, so the title keeps the
          // row's width. Without hover (touch), it stays visible beside the time.
          "& .conversation-actions": { opacity: 0 },
          "&:hover, &:focus-within": {
            "& .conversation-actions": { opacity: 1 },
            "& .conversation-when": { opacity: 0 },
          },
          "@media (hover: none)": {
            "& .conversation-actions": { opacity: 1 },
            "& .conversation-when": { opacity: 1 },
            "& .MuiListItemButton-root": { pr: "40px" },
          },
        }}>
        <ListItemButton
          selected={selected}
          onClick={() => {
            openConversation(conversation.id);
            onPicked?.();
          }}
          sx={{
            borderRadius: "8px",
            px: "12px",
            py: "7px",
            gap: "10px",
            alignItems: "flex-start",
            "&:hover": { bgcolor: "action.hover" },
            "&.Mui-selected, &.Mui-selected:hover": { bgcolor: accentSoft(theme) },
            ...focusRing(theme),
          }}>
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Typography
              noWrap
              title={conversationTitle(conversation, translate)}
              sx={{
                fontSize: 13,
                lineHeight: 1.45,
                fontWeight: selected ? 700 : 600,
                color: selected ? accentText(theme) : "text.primary",
              }}>
              {conversationTitle(conversation, translate)}
            </Typography>
            <Typography noWrap sx={{ fontSize: 11.5, lineHeight: 1.45, color: mutedText }}>
              {originLabel(conversation, translate)}
            </Typography>
          </Box>
          {conversation.running ? (
            <CircularProgress
              size={12}
              aria-label={t("assistant_running")}
              sx={{ mt: "4px", flexShrink: 0 }}
            />
          ) : (
            <Typography
              className="conversation-when"
              sx={{
                fontSize: 11,
                lineHeight: "19px",
                color: mutedText,
                flexShrink: 0,
                whiteSpace: "nowrap",
                minWidth: 28,
                textAlign: "right",
              }}>
              {when(conversation)}
            </Typography>
          )}
        </ListItemButton>
        <IconButton
          className="conversation-actions"
          size="small"
          aria-label={t("assistant_conversation_actions")}
          onClick={(event) => setMenu({ anchor: event.currentTarget, conversation })}
          sx={{
            position: "absolute",
            right: 6,
            top: "50%",
            transform: "translateY(-50%)",
            width: 28,
            height: 28,
            borderRadius: "7px",
            color: mutedText,
            "&:hover": { bgcolor: "action.selected" },
            ...focusRing(theme),
          }}>
          <Icon iconName={ICON_NAME.MORE_HORIZ} style={{ fontSize: 14, color: "inherit" }} />
        </IconButton>
      </ListItem>
    );
  };

  const sections: [string, ConversationSummary[]][] = [
    ["assistant_group_today", groups.today],
    ["assistant_group_earlier", groups.earlier],
  ];

  const scopeChip = (value: "project" | "all", label: string) => {
    const on = scope === value;
    return (
      <Chip
        size="small"
        label={label}
        aria-pressed={on}
        onClick={() => setScope(value)}
        sx={{
          height: 26,
          borderRadius: "999px",
          fontStyle: "normal",
          fontSize: 12,
          fontWeight: 700,
          border: `1px solid ${on ? theme.palette.primary.main : theme.palette.divider}`,
          bgcolor: on ? accentSoft(theme) : "transparent",
          color: on ? accentText(theme) : mutedText(theme),
          "&:hover, &.MuiChip-clickable:hover": {
            bgcolor: on ? alpha(theme.palette.primary.main, 0.18) : "action.hover",
          },
          "& .MuiChip-label": { px: "12px" },
          ...focusRing(theme),
        }}
      />
    );
  };

  return (
    <Stack sx={{ minHeight: 0, flex: 1 }}>
      <Stack
        gap="8px"
        sx={{
          px: "10px",
          pt: sidebar ? "4px" : "10px",
          pb: "10px",
          borderBottom: sidebar ? 0 : 1,
          borderColor: "divider",
        }}>
        <TextField
          size="small"
          fullWidth
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("assistant_search_conversations")}
          inputProps={{ "aria-label": t("assistant_search_conversations") }}
          InputProps={{
            startAdornment: (
              <InputAdornment position="start">
                <Icon
                  iconName={ICON_NAME.SEARCH}
                  style={{ fontSize: 13, color: theme.palette.text.secondary }}
                />
              </InputAdornment>
            ),
          }}
          sx={{
            "& .MuiOutlinedInput-root": {
              borderRadius: "999px",
              fontSize: 13,
              bgcolor: "background.paper",
              "& fieldset": { borderColor: "divider" },
              "&:hover fieldset": { borderColor: alpha(theme.palette.text.primary, 0.24) },
              "&.Mui-focused fieldset": { borderColor: "primary.main", borderWidth: 1 },
            },
            "& .MuiOutlinedInput-input": { py: "8px" },
          }}
        />
        {projectId && (
          <Stack direction="row" gap="6px">
            {scopeChip("project", t("assistant_scope_this_project"))}
            {scopeChip("all", t("all"))}
          </Stack>
        )}
      </Stack>
      <Box sx={{ flex: 1, overflowY: "auto", px: "6px", pb: "8px" }}>
        {isLoading && <CircularProgress size={16} sx={{ m: "16px" }} />}
        {error && (
          <Alert severity="error" sx={{ m: "8px" }}>
            {t(assistantErrorKey(error))}
          </Alert>
        )}
        {!isLoading && !error && conversations.length === 0 && (
          <Typography sx={{ px: "12px", py: "10px", fontSize: 12.5, color: mutedText }}>
            {t(q ? "assistant_no_matches" : "assistant_no_conversations")}
          </Typography>
        )}
        {sections.map(
          ([label, list]) =>
            list.length > 0 && (
              <Box key={label}>
                <Typography
                  sx={{
                    display: "block",
                    px: "12px",
                    pt: "10px",
                    pb: "4px",
                    fontSize: 11,
                    fontWeight: 800,
                    letterSpacing: "0.4px",
                    color: mutedText,
                  }}>
                  {t(label)}
                </Typography>
                <List dense disablePadding sx={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                  {list.map(row)}
                </List>
              </Box>
            )
        )}
      </Box>
      {/* The Content page's item menu: icon, label, and Delete in the error colour. */}
      <Menu
        anchorEl={menu?.anchor ?? null}
        open={!!menu}
        // Escape or a click outside hands the focus back to "…". A pick opens its dialog once the
        // menu is gone: a closing menu still holds the focus and would pull it out of the dialog.
        disableRestoreFocus
        onClose={() => {
          menu?.anchor.focus();
          setMenu(null);
        }}
        TransitionProps={{
          onExited: () => {
            if (picked.current?.kind === "rename") setRenaming(picked.current.conversation);
            if (picked.current?.kind === "delete") setDeleting(picked.current.conversation);
            picked.current = null;
          },
        }}
        anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
        transformOrigin={{ vertical: "top", horizontal: "right" }}
        PaperProps={{
          sx: {
            minWidth: 180,
            mt: "4px",
            borderRadius: CARD_RADIUS,
            border: 1,
            borderColor: "divider",
            boxShadow: surfaceShadows(theme).hover,
          },
        }}
        MenuListProps={{ dense: true, sx: { py: "6px" } }}>
        {(
          [
            {
              key: "rename",
              icon: ICON_NAME.EDIT,
              color: undefined,
              run: (conversation: ConversationSummary) => (picked.current = { kind: "rename", conversation }),
            },
            {
              key: "delete",
              icon: ICON_NAME.TRASH,
              color: "error.main",
              run: (conversation: ConversationSummary) => (picked.current = { kind: "delete", conversation }),
            },
          ] as const
        ).map((item) => (
          <MenuItem
            key={item.key}
            onClick={() => {
              if (!menu) return;
              item.run(menu.conversation);
              setMenu(null);
            }}
            sx={{ gap: "12px", px: "14px", py: "7px", fontSize: 13, color: item.color ?? "text.primary" }}>
            <Icon iconName={item.icon} style={{ fontSize: 14, color: "inherit" }} />
            {t(item.key)}
          </MenuItem>
        ))}
      </Menu>
      {renaming && (
        <NameDialog
          title={t("assistant_rename_title")}
          icon={ICON_NAME.EDIT}
          cta={t("rename")}
          initialName={conversationTitle(renaming, translate)}
          maxLength={200}
          onClose={() => setRenaming(null)}
          onSubmit={(name) => rename(renaming, name)}
        />
      )}
      {deleting && (
        <AppDialog
          open
          onClose={() => setDeleting(null)}
          icon={ICON_NAME.TRASH}
          tone="warning"
          title={t("assistant_delete_title")}
          footer={
            <AppDialogFooter
              onCancel={() => setDeleting(null)}
              cancelAutoFocus
              primaryLabel={t("delete")}
              onPrimary={() => void remove()}
              primaryColor="error"
            />
          }>
          <DialogContentText>
            {t("assistant_delete_body", plain({ title: conversationTitle(deleting, translate) }))}
          </DialogContentText>
        </AppDialog>
      )}
    </Stack>
  );
}
