import { Box, DialogContentText } from "@mui/material";
import { useState } from "react";

import { ICON_NAME } from "@p4b/ui/components/Icon";

import AppDialog, { AppDialogFooter } from "@/components/common/AppDialog";
import LabeledField from "@/components/common/LabeledField";

interface ConfirmDialogProps {
  title: string;
  body;
  open: boolean;
  closeText?: string;
  onClose?: () => void;
  confirmText?: string;
  onConfirm?: () => void;
  matchText?: string;
  matchLabel?: string;
  /** The confirmed action is running: the primary spins, and Cancel and the X wait. */
  loading?: boolean;
}

const ConfirmModal: React.FC<ConfirmDialogProps> = ({
  open,
  title,
  body,
  closeText,
  onClose,
  confirmText,
  onConfirm,
  matchText,
  matchLabel,
  loading,
}) => {
  const [matchTextValue, setMatchTextValue] = useState("");

  const close = () => {
    if (matchText) {
      setMatchTextValue("");
    }
    onClose?.();
  };

  return (
    <AppDialog
      open={open}
      onClose={close}
      // Every confirmation this dialog draws ends in a destructive button, so
      // it always wears the amber tile.
      icon={ICON_NAME.CIRCLEINFO}
      tone="warning"
      title={title}
      closeLabel={closeText || "Close"}
      closeDisabled={loading}
      footer={
        <AppDialogFooter
          cancelLabel={closeText || "Close"}
          onCancel={close}
          cancelDisabled={loading}
          primaryLabel={confirmText || "Confirm"}
          onPrimary={() => onConfirm?.()}
          primaryColor="error"
          primaryDisabled={!!matchText && matchTextValue !== matchText}
          primaryLoading={loading}
        />
      }>
      <DialogContentText component="div">{body}</DialogContentText>
      {matchText && (
        // Add Layer's field (decision 7): the label in bold above a small
        // field, as every other field of a settings dialog.
        <Box sx={{ mt: 4, mb: 2 }}>
          <LabeledField
            id="matchText"
            label={matchLabel ?? matchText}
            placeholder={matchText}
            onChange={(e) => setMatchTextValue(e.target.value)}
            value={matchTextValue}
          />
        </Box>
      )}
    </AppDialog>
  );
};

export default ConfirmModal;
