"use client";

import { Box, Button, Stack, Typography } from "@mui/material";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import UserAvatar from "@/components/dashboard/common/UserAvatar";

/** What the uploader takes and core can store (decision 19: `imghdr` knows no SVG). */
export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif"] as const;
export const IMAGE_MAX_BYTES = 1024 * 1024;

const PROBLEM_TEXT = {
  type: "settings_image_type_error",
  size: "settings_image_size_error",
  read: "settings_image_read_error",
} as const;

export const imageProblem = (file: File): "type" | "size" | null =>
  !(IMAGE_TYPES as readonly string[]).includes(file.type)
    ? "type"
    : file.size > IMAGE_MAX_BYTES
      ? "size"
      : null;

/** A picture for a user, an organization or a team: the 64px avatar (picture
 * or initials), a button that opens the file chooser and a hint. A chosen
 * file becomes a data URL in the card's draft; a wrong or unreadable one says
 * why, and the button's description names the hint and the problem. */
export default function ImagePicker({
  id,
  name,
  seed,
  value,
  onChange,
  buttonLabel,
  hint,
  variant = "circular",
  disabled,
}: {
  id: string;
  /** For the initials. */
  name: string;
  /** Seeds the initials' colour. */
  seed: string;
  value?: string | null;
  onChange: (dataUrl: string) => void;
  buttonLabel: string;
  hint: string;
  variant?: "circular" | "rounded";
  disabled?: boolean;
}) {
  const { t } = useTranslation("common");
  const input = useRef<HTMLInputElement>(null);
  const [problem, setProblem] = useState<"type" | "size" | "read" | null>(null);
  const hintId = `${id}-hint`;
  const problemId = `${id}-problem`;

  const pick = (file: File | undefined) => {
    if (!file) return;
    const issue = imageProblem(file);
    setProblem(issue);
    if (issue) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") onChange(reader.result);
    };
    reader.onerror = () => setProblem("read");
    reader.readAsDataURL(file);
  };

  return (
    <Stack direction="row" spacing={4} alignItems="center">
      <UserAvatar
        id={seed}
        name={name}
        src={value}
        size={64}
        sx={variant === "rounded" ? { borderRadius: "14px" } : undefined}
      />
      <Box sx={{ minWidth: 0 }}>
        <input
          ref={input}
          id={id}
          type="file"
          accept={IMAGE_TYPES.join(",")}
          disabled={disabled}
          style={{ display: "none" }}
          onChange={(event) => {
            pick(event.target.files?.[0]);
            event.target.value = "";
          }}
        />
        <Button
          variant="outlined"
          size="small"
          disabled={disabled}
          startIcon={<Icon iconName={ICON_NAME.UPLOAD} style={{ fontSize: 14 }} htmlColor="inherit" />}
          onClick={() => input.current?.click()}
          aria-describedby={problem ? `${hintId} ${problemId}` : hintId}
          sx={{ borderRadius: 999 }}>
          {buttonLabel}
        </Button>
        <Typography id={hintId} variant="caption" component="p" color="text.secondary" sx={{ mt: 1 }}>
          {hint}
        </Typography>
        {problem && (
          <Typography
            id={problemId}
            role="alert"
            variant="caption"
            component="p"
            color="error"
            sx={{ mt: 0.5 }}>
            {t(PROBLEM_TEXT[problem])}
          </Typography>
        )}
      </Box>
    </Stack>
  );
}
