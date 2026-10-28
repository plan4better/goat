// A button in MUI's outlined input: a value that opens an editor looks and focuses like a box you type in. It draws
// the focused outline while its editor or menu is open (`active`) and a ring in the text color while the keyboard
// focuses it; a click's focus, which stays after the editor closes, leaves the outline at rest.
import { type InputBaseComponentProps, OutlinedInput, type SxProps, type Theme } from "@mui/material";
import { type ReactNode, type Ref, forwardRef } from "react";

import {
  FOCUSED_OUTLINE,
  fieldOutline,
  fieldSx,
  focusRing,
} from "@/components/map/panels/styleEditor/rows/fieldBox";

/** The input slot as a button: drops the props only a text input understands. */
const ButtonSlot = forwardRef(function ButtonSlot(
  props: InputBaseComponentProps,
  ref: Ref<HTMLButtonElement>
) {
  const {
    value: _value,
    onChange: _onChange,
    readOnly: _readOnly,
    placeholder: _placeholder,
    autoComplete: _autoComplete,
    required: _required,
    rows: _rows,
    type: _type,
    ...rest
  } = props;
  return <button {...(rest as object)} ref={ref} type="button" />;
});

export interface FieldButtonProps {
  children: ReactNode;
  onClick: (anchor: HTMLElement) => void;
  expanded?: boolean;
  /** Its editor or menu is open. */
  active?: boolean;
  buttonRef?: Ref<HTMLButtonElement>;
  ariaLabel?: string;
  start?: ReactNode;
  end?: ReactNode;
  sx?: SxProps<Theme>;
}

export function FieldButton({
  children,
  onClick,
  expanded,
  active,
  buttonRef,
  ariaLabel,
  start,
  end,
  sx,
}: FieldButtonProps) {
  return (
    <OutlinedInput
      size="small"
      value=""
      inputComponent={ButtonSlot}
      inputRef={buttonRef}
      inputProps={{
        children,
        "aria-expanded": expanded,
        "data-active": active || undefined,
        "aria-label": ariaLabel,
        onClick: (event: React.MouseEvent<HTMLElement>) => onClick(event.currentTarget),
      }}
      startAdornment={start}
      endAdornment={end}
      sx={[
        fieldSx as object,
        (theme) => ({
          "&.Mui-focused .MuiOutlinedInput-notchedOutline": {
            borderColor: fieldOutline(theme),
            borderWidth: 1,
          },
          "&.Mui-focused:hover .MuiOutlinedInput-notchedOutline": { borderColor: fieldOutline(theme, true) },
          "& .MuiInputBase-input:focus-visible ~ .MuiOutlinedInput-notchedOutline": focusRing(theme),
          ...(active && { "&&& .MuiOutlinedInput-notchedOutline": FOCUSED_OUTLINE }),
        }),
        {
          flex: 1,
          cursor: "pointer",
          pl: start ? 1 : 0,
          pr: end ? 1 : 0,
          "& .MuiInputBase-input": {
            display: "flex",
            alignItems: "center",
            gap: 2,
            height: "100%",
            textAlign: "left",
            cursor: "pointer",
            font: "inherit",
            // The icons and glyphs take the Selector's icon color; the value's text is the Selector's (body2, bold).
            color: "text.secondary",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          },
        },
        ...(Array.isArray(sx) ? sx : [sx]),
      ]}
    />
  );
}
