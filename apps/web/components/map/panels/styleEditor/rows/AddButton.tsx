// The panel's add action (prototype: the ghost button): a plus and green text, no fill. Section headers keep their
// own "+" icon (PanelSection); every other "add" in the editor (a style, a class, a condition, a color, a palette of
// one's own) is this.
import { Button, type SxProps, type Theme } from "@mui/material";
import type { MouseEvent, ReactNode } from "react";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

export interface AddButtonProps {
  children: ReactNode;
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
  disabled?: boolean;
  sx?: SxProps<Theme>;
}

export function AddButton({ children, onClick, disabled, sx }: AddButtonProps) {
  return (
    <Button
      variant="text"
      size="small"
      disabled={disabled}
      startIcon={<Icon iconName={ICON_NAME.PLUS} sx={{ fontSize: "12px !important" }} />}
      onClick={onClick}
      sx={[
        {
          alignSelf: "flex-start",
          height: 32,
          px: 2.5,
          borderRadius: 2,
          fontSize: 13,
          fontWeight: 700,
          textTransform: "none",
        },
        ...(Array.isArray(sx) ? sx : [sx]),
      ]}>
      {children}
    </Button>
  );
}
