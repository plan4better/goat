"use client";

import { Box, Stack, Typography, useTheme } from "@mui/material";
import { useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

/**
 * Where a file is chosen: click to browse, or drop it here.
 *
 * A drop target rather than a file input, because dragging a file from a folder is how
 * people hand a file to anything else. The input is still there — hidden, and it is what
 * the click opens — so the keyboard and screen-reader path is the platform's own.
 */
const UploadDropzone = ({
  accept,
  error,
  onChange,
}: {
  accept: string[];
  error?: string;
  onChange: (file: File | null) => void;
}) => {
  const { t } = useTranslation("common");
  const theme = useTheme();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [over, setOver] = useState(false);

  const take = useCallback(
    (files: FileList | null) => {
      onChange(files && files.length > 0 ? files[0] : null);
    },
    [onChange]
  );

  // Lit only while a file is over it. Having accepted one is not a reason to keep
  // shouting: the row beside it is what states the file now.
  const border = error
    ? theme.palette.error.main
    : over
      ? theme.palette.primary.main
      : theme.palette.divider;

  return (
    <Stack spacing={2} sx={{ height: "100%" }}>
      <Box
        component="button"
        type="button"
        onClick={() => inputRef.current?.click()}
        // `dragOver` must be prevented for a drop to be allowed at all.
        onDragOver={(event: React.DragEvent) => {
          event.preventDefault();
          event.stopPropagation();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(event: React.DragEvent) => {
          event.preventDefault();
          // The editor listens for file drops on the window, to import a file
          // dropped anywhere on the map. This zone has just taken the file, so
          // the event must not reach it — otherwise one drop both queues the
          // file here and imports it in the background.
          event.stopPropagation();
          setOver(false);
          take(event.dataTransfer.files);
        }}
        sx={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 3,
          width: "100%",
          px: 5,
          py: 10,
          // Fills its column so the zone and the file beside it are the same height.
          flex: 1,
          minHeight: 300,
          font: "inherit",
          cursor: "pointer",
          textAlign: "center",
          borderRadius: "12px",
          border: `1.5px dashed ${border}`,
          backgroundColor: over ? theme.palette.action.hover : "transparent",
          transition: theme.transitions.create(["border-color", "background-color"], {
            duration: theme.transitions.duration.shortest,
          }),
        }}>
        <Box
          sx={{
            width: 48,
            height: 48,
            borderRadius: "50%",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: theme.palette.primary.main,
          }}>
          <Icon
            iconName={ICON_NAME.UPLOAD}
            style={{ fontSize: 28 }}
            htmlColor={theme.palette.primary.contrastText}
          />
        </Box>
        {/* The same invitation whether or not something is queued: adding replaces, so
            there is no second verb to learn. */}
        <Typography variant="body1" fontWeight={600} sx={{ overflowWrap: "anywhere" }}>
          {t("upload_drop_or_browse")}
        </Typography>
      </Box>

      <input
        ref={inputRef}
        type="file"
        hidden
        accept={accept.join(",")}
        onChange={(event) => take(event.target.files)}
      />

      {/* The formats are stated once, above the zone, by whoever hosts it. Only the
          error belongs here, next to the control that caused it. */}
      {error && (
        <Typography variant="caption" color="error">
          {error}
        </Typography>
      )}
    </Stack>
  );
};

export default UploadDropzone;
