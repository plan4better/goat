"use client";

import { Box, IconButton, Stack, Typography, useTheme } from "@mui/material";
import prettyBytes from "pretty-bytes";
import { useTranslation } from "react-i18next";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

/**
 * The file a dialog has taken, in place of its drop zone: what it is called
 * and how big it is, with the one control the file has — taking it back out.
 *
 * The short form of `UploadFileRow`, for a dialog whose file needs no name,
 * folder or settings of its own.
 */
const ChosenFileRow = ({
  file,
  onRemove,
  disabled,
  icon = ICON_NAME.FILE,
}: {
  file: File;
  onRemove: () => void;
  disabled?: boolean;
  /** What the file becomes — a map for a project archive, a layer for a dataset. */
  icon?: ICON_NAME;
}) => {
  const { t } = useTranslation("common");
  const theme = useTheme();
  return (
    <Stack
      direction="row"
      alignItems="center"
      spacing={3}
      sx={{
        p: 3,
        borderRadius: 1.5,
        border: `1px solid ${theme.palette.divider}`,
        backgroundColor: theme.palette.background.paper,
      }}>
      <Box
        sx={{
          width: 40,
          height: 40,
          borderRadius: 1.5,
          flexShrink: 0,
          display: "grid",
          placeItems: "center",
          backgroundColor: theme.palette.action.hover,
        }}>
        <Icon iconName={icon} style={{ fontSize: 15 }} htmlColor={theme.palette.text.secondary} />
      </Box>
      <Typography
        variant="body2"
        fontWeight={600}
        // A filename can be one unbroken word longer than the row: it breaks
        // anywhere rather than pushing the card open.
        sx={{ flex: 1, minWidth: 0, overflowWrap: "anywhere" }}>
        {file.name} · {prettyBytes(file.size)}
      </Typography>
      <IconButton
        onClick={onRemove}
        disabled={disabled}
        aria-label={t("upload_remove_file")}
        sx={{ p: 2, flexShrink: 0 }}>
        <Icon iconName={ICON_NAME.XCLOSE} style={{ fontSize: 14 }} />
      </IconButton>
    </Stack>
  );
};

export default ChosenFileRow;
