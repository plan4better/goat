"use client";

import { Stack, TextField } from "@mui/material";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import type { ICON_NAME } from "@p4b/ui/components/Icon";

import AppDialog, { AppDialogFooter } from "@/components/common/AppDialog";

interface NameDialogProps {
  /** The dialog's own heading — what is being created ("New folder"). */
  title: string;
  /** Shown in the header's tinted icon tile. */
  icon: ICON_NAME;
  /** An example of a good name, not a label — the title already says what
   * this is. */
  placeholder?: string;
  /** The primary button's label ("Create folder"). */
  cta: string;
  /** Pre-fills the field, for a rename: the name starts selected, and the
   * button stays disabled until it differs from this one. */
  initialName?: string;
  onClose: () => void;
  /** Rejecting keeps the dialog open and shows the reason under the field;
   * resolving leaves closing to the caller. */
  onSubmit: (name: string) => Promise<void>;
  /** The longest name the server accepts. */
  maxLength?: number;
  /** Whether the caller has everything a submit needs — a project's
   * destination folder, say. The button stays disabled until it does, so a
   * fast typist cannot submit into a location that is still loading. */
  ready?: boolean;
}

/**
 * Create-with-a-name: one field, one button. Everything else a new folder or
 * project needs (its space, its parent folder, a project's default view) comes
 * from where the caller is, not from a form. Enter submits, Escape closes, and
 * the button stays disabled until there is a name to submit.
 */
const NameDialog = ({
  title,
  icon,
  placeholder,
  cta,
  initialName,
  maxLength,
  onClose,
  onSubmit,
  ready = true,
}: NameDialogProps) => {
  const { t } = useTranslation("common");
  const [name, setName] = useState(initialName ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmed = name.trim();
  const unchanged = initialName !== undefined && trimmed === initialName.trim();
  const canSubmit = trimmed.length > 0 && !unchanged && !busy && ready;

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(trimmed);
    } catch (submitError) {
      // The server's own message when it sent one — it names the actual
      // refusal (a duplicate name, a missing folder) better than a generic
      // line would.
      const message = submitError instanceof Error ? submitError.message : "";
      setError(message || t("error"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AppDialog
      open
      onClose={onClose}
      icon={icon}
      title={title}
      maxWidth={420}
      closeDisabled={busy}
      footer={
        <AppDialogFooter
          onCancel={onClose}
          cancelDisabled={busy}
          primaryLabel={cta}
          onPrimary={() => void submit()}
          primaryDisabled={!canSubmit}
          primaryLoading={busy}
        />
      }>
      <Stack sx={{ pt: 1 }}>
        <TextField
          autoFocus
          size="small"
          fullWidth
          value={name}
          placeholder={placeholder}
          error={!!error}
          helperText={error}
          inputProps={{ "aria-label": title, autoComplete: "off", maxLength }}
          onFocus={(event) => {
            if (initialName !== undefined) event.target.select();
          }}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void submit();
          }}
        />
      </Stack>
    </AppDialog>
  );
};

export default NameDialog;
