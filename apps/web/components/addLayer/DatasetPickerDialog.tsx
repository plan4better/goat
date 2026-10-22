"use client";

import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  Tooltip,
  Typography,
  useMediaQuery,
  useTheme,
} from "@mui/material";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { ICON_NAME } from "@p4b/ui/components/Icon";

import type { ContentItem } from "@/lib/validations/content";

import DatasetPickerBody from "@/components/addLayer/DatasetPickerBody";
import { ContentDialogHeader, contentDialogPaperSx } from "@/components/modals/content/ContentDialogChrome";

export type DatasetPickerDialogProps = {
  open: boolean;
  onClose: () => void;
  /** The one item chosen; nothing is added to any project. */
  onPick: (item: ContentItem) => void;
  /** Whether the host can take this item (e.g. it needs edit rights). */
  canPick?: (item: ContentItem) => boolean;
  /** Shown when the picked item fails `canPick`. */
  cannotPickLabel?: string;
};

/** The open shelf, and the pick it holds. Mounted only while the dialog is
 * open, so the pick — like the shelf's scope, folder and search — starts
 * fresh every time it is opened, whoever closed it. */
const DatasetPickerShelf = ({
  onClose,
  onPick,
  canPick,
  cannotPickLabel,
}: Omit<DatasetPickerDialogProps, "open">) => {
  const { t } = useTranslation("common");
  const theme = useTheme();
  const fullScreen = useMediaQuery(theme.breakpoints.down("md"));
  const [picked, setPicked] = useState<ContentItem | null>(null);
  const blocked = !!picked && !!canPick && !canPick(picked);

  return (
    <Dialog
      open
      onClose={onClose}
      maxWidth={false}
      fullScreen={fullScreen}
      PaperProps={{ sx: contentDialogPaperSx(1360, fullScreen) }}>
      <ContentDialogHeader
        icon={ICON_NAME.DATABASE}
        title={t("my_datasets")}
        onClose={onClose}
        closeLabel={t("close")}
        divider
      />
      {/* The shelf brings its own scroller, so the content area keeps none. */}
      <DialogContent sx={{ p: 0, overflow: "hidden" }}>
        <DatasetPickerBody mode="pick" picked={picked} onPickedChange={setPicked} fullHeight={fullScreen} />
      </DialogContent>
      <DialogActions
        disableSpacing
        // The doubled `&` is load-bearing here for the same reason as in the Add
        // Layer frame: the theme zeroes a dialog footer's top padding through a
        // selector that outranks a plain `sx` rule.
        sx={{
          "&&.MuiDialogActions-root": {
            borderTop: `1px solid ${theme.palette.divider}`,
            py: 4,
            px: 6,
          },
          justifyContent: "flex-end",
          gap: 2,
        }}>
        {blocked && cannotPickLabel && (
          <Typography variant="body2" color="error.main" sx={{ mr: "auto" }}>
            {cannotPickLabel}
          </Typography>
        )}
        <Button variant="text" onClick={onClose}>
          <Typography variant="body2" fontWeight="bold">
            {t("cancel")}
          </Typography>
        </Button>
        <Tooltip title={picked ? "" : t("pick_dataset_first")}>
          <Box component="span" sx={{ display: "inline-flex" }}>
            <Button
              variant="contained"
              color="primary"
              disabled={!picked || blocked}
              onClick={() => {
                if (!picked || blocked) return;
                onPick(picked);
                onClose();
              }}>
              <Typography variant="body2" fontWeight="bold" color="inherit">
                {t("use_dataset")}
              </Typography>
            </Button>
          </Box>
        </Tooltip>
      </DialogActions>
    </Dialog>
  );
};

/**
 * The dataset shelf for a host that wants one item back — the workflow
 * editor's dataset node and SQL tool — rather than layers added to a map.
 *
 * Nothing is mounted until it is opened, so the shelf's queries only run
 * while it is on screen and a host may render this permanently.
 */
const DatasetPickerDialog = ({ open, ...props }: DatasetPickerDialogProps) =>
  open ? <DatasetPickerShelf {...props} /> : null;

export default DatasetPickerDialog;
