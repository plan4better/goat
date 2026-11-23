// The value of a property that is not fixed (by zoom, by attribute, by classes): a strip or curve and a summary
// in the panel's field, opening its editor (a chevron) or a menu under it (a caret).
import { Box, Tooltip, Typography } from "@mui/material";
import { type ReactNode, memo } from "react";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import { FieldButton, FieldTrailingIcon } from "@/components/map/panels/styleEditor/rows/FieldButton";
import { CurveGlyph } from "@/components/map/panels/styleEditor/rows/GroupRow";

export interface FormButtonProps {
  /** A CSS background for the strip (a gradient, stepped classes). */
  strip?: string;
  curve?: boolean;
  /** Before the text, such as the field's kind. */
  start?: ReactNode;
  text: ReactNode;
  onOpen: (anchor: HTMLElement) => void;
  note?: string;
  /** Opens a menu under it (a caret) rather than an editor (a chevron), and shows as open while it is. */
  popup?: "listbox";
  open?: boolean;
  /** The field's name where no label is beside it. */
  ariaLabel?: string;
}

export const FormButton = memo(function FormButton({
  strip,
  curve,
  start,
  text,
  onOpen,
  note,
  popup,
  open,
  ariaLabel,
}: FormButtonProps) {
  return (
    <FieldButton
      ariaLabel={ariaLabel}
      onClick={onOpen}
      popup={popup}
      expanded={popup ? !!open : undefined}
      active={open}
      end={
        <>
          {note && (
            <Tooltip title={note}>
              <Box component="span" sx={{ display: "flex", mr: 1 }}>
                <Icon iconName={ICON_NAME.CIRCLEINFO} sx={{ fontSize: 12, color: "text.secondary" }} />
              </Box>
            </Tooltip>
          )}
          <FieldTrailingIcon kind={popup ? "caret" : "chevron"} />
        </>
      }>
      {start}
      {strip && <Box sx={{ width: 40, height: 12, flex: "none", borderRadius: "3px", background: strip }} />}
      {curve && <CurveGlyph />}
      <Typography component="span" variant="body2" fontWeight="bold" noWrap sx={{ flex: 1, minWidth: 0 }}>
        {text}
      </Typography>
    </FieldButton>
  );
});
