"use client";

import CancelIcon from "@mui/icons-material/Cancel";
import { Box, Chip, InputBase, Typography } from "@mui/material";
import { type ClipboardEvent, type KeyboardEvent, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

const SEPARATORS = /[\s,;]+/;

/** Parts of a text as addresses: trimmed and lowercased (as core stores
 * them), empty ones dropped. The one rule for typed and pasted text. */
const normalize = (parts: string[]): string[] =>
  parts.map((part) => part.trim().toLowerCase()).filter(Boolean);

/** Addresses in a typed or pasted text: split on commas, semicolons and
 * white space, trimmed and lowercased (as core stores them). */
export const splitAddresses = (text: string): string[] => normalize(text.split(SEPARATORS));

/** `current` and then each new address once. */
const merge = (current: string[], added: string[]): string[] => {
  const next = [...current];
  for (const address of added) if (!next.includes(address)) next.push(address);
  return next;
};

/**
 * Addresses as chips (the invite dialog): a comma, semicolon, space or Enter
 * ends one, a paste is split, Backspace in the empty field takes the last chip
 * back, leaving the field keeps what was typed. `problems` makes a chip red and
 * names its reason in the help line.
 */
export default function EmailChipsInput({
  id,
  label,
  value,
  onChange,
  problems,
  placeholder,
  placeholderMore,
  help,
  onSubmitEmpty,
  disabled,
}: {
  id: string;
  label: string;
  value: string[];
  onChange: (next: string[]) => void;
  problems: Record<string, string>;
  placeholder: string;
  placeholderMore: string;
  help: string;
  onSubmitEmpty?: () => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation("common");
  const [text, setText] = useState("");
  const input = useRef<HTMLInputElement | null>(null);
  const helpId = `${id}-help`;
  const reasons = value
    .filter((address) => problems[address])
    .map((address) => `${address}: ${problems[address]}`);

  const commit = (raw: string) => {
    const parts = splitAddresses(raw);
    if (parts.length) onChange(merge(value, parts));
    setText("");
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      if (text.trim()) commit(text);
      else onSubmitEmpty?.();
    } else if (event.key === "Backspace" && text === "" && value.length > 0) {
      event.preventDefault();
      onChange(value.slice(0, -1));
    }
  };

  const onPaste = (event: ClipboardEvent<HTMLInputElement>) => {
    event.preventDefault();
    // At the caret, as a paste lands: "anna@" and a pasted "x.de" are one address.
    const { selectionStart, selectionEnd } = event.currentTarget;
    const pasted = event.clipboardData.getData("text/plain");
    commit(text.slice(0, selectionStart ?? text.length) + pasted + text.slice(selectionEnd ?? text.length));
  };

  return (
    <Box>
      <Typography
        component="label"
        htmlFor={id}
        variant="body2"
        sx={{ display: "block", fontWeight: 700, mb: 1.5 }}>
        {label}
      </Typography>
      <Box
        onClick={() => input.current?.focus()}
        sx={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          gap: 1,
          minHeight: 40,
          px: 1.5,
          py: 1,
          border: 1,
          borderColor: reasons.length ? "error.main" : "divider",
          borderRadius: "8px",
          cursor: "text",
          "&:focus-within": { borderColor: reasons.length ? "error.main" : "primary.main" },
        }}>
        {value.map((address) => (
          <Chip
            key={address}
            size="small"
            label={address}
            color={problems[address] ? "error" : "default"}
            variant={problems[address] ? "outlined" : "filled"}
            data-invalid={problems[address] ? "true" : undefined}
            onDelete={
              disabled
                ? undefined
                : () => {
                    onChange(value.filter((other) => other !== address));
                    // The chip goes, so the focus goes back to the field
                    // rather than to the page.
                    input.current?.focus();
                  }
            }
            deleteIcon={
              <CancelIcon
                titleAccess={t("settings_members_remove_address", {
                  email: address,
                  interpolation: { escapeValue: false },
                })}
              />
            }
          />
        ))}
        <InputBase
          id={id}
          inputRef={input}
          value={text}
          disabled={disabled}
          placeholder={value.length ? placeholderMore : placeholder}
          onChange={(event) => {
            const parts = event.target.value.split(SEPARATORS);
            const rest = parts.pop() ?? "";
            const done = normalize(parts);
            if (done.length) onChange(merge(value, done));
            setText(rest);
          }}
          onKeyDown={onKeyDown}
          onBlur={() => {
            if (text.trim()) commit(text);
          }}
          inputProps={{
            // On the <input> itself: InputBase puts an onPaste of its own on
            // the wrapper, where the event knows no caret.
            onPaste,
            "aria-describedby": helpId,
            "aria-invalid": reasons.length > 0 || undefined,
            autoComplete: "off",
            inputMode: "email",
          }}
          sx={{ flex: 1, minWidth: 160, fontSize: 14 }}
        />
      </Box>
      <Typography
        id={helpId}
        variant="caption"
        component="p"
        color={reasons.length ? "error" : "text.secondary"}
        sx={{ mt: 1 }}>
        {reasons.length ? reasons.join("; ") : help}
      </Typography>
    </Box>
  );
}
