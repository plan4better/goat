// A button in MUI's outlined input: a value that opens an editor looks and focuses like a box you type in. It draws
// the focused outline while its editor or menu is open (`active`) and a ring in the text color while the keyboard
// focuses it; a click's focus, which stays after the editor closes, leaves the outline at rest.
import {
  type InputBaseComponentProps,
  OutlinedInput,
  type SxProps,
  type Theme,
  Tooltip,
} from "@mui/material";
import { type ReactNode, type Ref, forwardRef } from "react";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import {
  FIELD_INSET,
  FOCUSED_OUTLINE,
  TRAILING_ICON_SIZE,
  fieldOutline,
  fieldSx,
  focusRing,
} from "@/components/map/panels/styleEditor/rows/fieldBox";

/** The input slot as a button: drops the props only a text input understands. A tooltip describes the button itself,
 * so it opens on hover and on keyboard focus. */
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
    tooltip,
    "aria-describedby": describedBy,
    ...rest
  } = props;
  const disabled = (rest as { disabled?: boolean }).disabled;
  // An unset description leaves the button to the tooltip's.
  const button = (
    <button
      {...(rest as object)}
      {...(describedBy ? { "aria-describedby": describedBy } : {})}
      ref={ref}
      type="button"
    />
  );
  if (!tooltip) return button;
  // A disabled button fires no events: the tooltip listens on a wrapper the size of the button.
  return (
    <Tooltip title={tooltip} describeChild>
      {disabled ? (
        <span style={{ display: "flex", flex: 1, minWidth: 0, height: "100%" }}>{button}</span>
      ) : (
        button
      )}
    </Tooltip>
  );
});

export interface FieldButtonProps {
  children: ReactNode;
  onClick: (anchor: HTMLElement) => void;
  expanded?: boolean;
  /** Its editor or menu is open. */
  active?: boolean;
  buttonRef?: Ref<HTMLButtonElement>;
  ariaLabel?: string;
  /** The whole value on hover and on keyboard focus, where a long value is cut with an ellipsis. */
  tooltip?: string;
  /** Opens a menu: "listbox" for the field's options (the button is a combobox), "menu" for actions or modes. */
  popup?: "listbox" | "menu";
  start?: ReactNode;
  end?: ReactNode;
  /** Shown, but not to be opened: what it opens waits for something (a file's info). */
  disabled?: boolean;
  sx?: SxProps<Theme>;
}

export function FieldButton({
  children,
  onClick,
  expanded,
  active,
  buttonRef,
  ariaLabel,
  tooltip,
  popup,
  start,
  end,
  disabled,
  sx,
}: FieldButtonProps) {
  return (
    <OutlinedInput
      size="small"
      value=""
      disabled={disabled}
      inputComponent={ButtonSlot}
      inputRef={buttonRef}
      inputProps={{
        children,
        "aria-expanded": expanded,
        "data-active": active || undefined,
        "aria-label": ariaLabel,
        "aria-haspopup": popup,
        tooltip,
        role: popup === "listbox" ? "combobox" : undefined,
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
          // Disabled, MUI greys the text and the outline; the swatch, glyphs and trailing icon dim with it.
          "&.Mui-disabled": {
            "&, & .MuiInputBase-input": { cursor: "default" },
            "& .MuiInputBase-input > :not(.MuiTypography-root), & > .MuiSvgIcon-root": { opacity: 0.5 },
          },
          pl: start ? 1 : 0,
          // A trailing icon keeps the text's inset from the right border, with a gap before it for the truncated text.
          pr: end ? FIELD_INSET : 0,
          "& .MuiInputBase-input": {
            ...(end ? { pr: 2 } : {}),
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

/** A field's trailing icon: the caret of a field that opens a menu, the chevron of one that opens an editor. */
export function FieldTrailingIcon({ kind }: { kind: "caret" | "chevron" }) {
  return (
    <Icon
      iconName={kind === "caret" ? ICON_NAME.CHEVRON_DOWN : ICON_NAME.CHEVRON_RIGHT}
      sx={{ fontSize: TRAILING_ICON_SIZE, color: "text.secondary", flex: "none" }}
    />
  );
}
