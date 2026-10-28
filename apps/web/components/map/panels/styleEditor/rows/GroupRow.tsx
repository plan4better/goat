// A part of the symbol (Fill, Outline, Line, …) as one row: a swatch and a summary that open the part's editor, and
// the value mode button when the row is one property. NavRow is the same without a mode: a row that opens an editor.
import { Box, Tooltip, Typography } from "@mui/material";
import { type ReactNode, memo, useState } from "react";
import { useTranslation } from "react-i18next";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import { useIsOpener } from "@/components/map/panels/styleEditor/popovers/usePopover";
import { FieldButton } from "@/components/map/panels/styleEditor/rows/FieldButton";
import { Row } from "@/components/map/panels/styleEditor/rows/Row";

/** A swatch: a CSS background (a color, a gradient, a hatch); `wide` for ramps, `small` inside a pill. */
export interface Swatch {
  background: string;
  wide?: boolean;
  small?: boolean;
}

/** The prototype's `.rsw`: 16 px (12 px small), a 40 x 12 strip for ramps, a hairline inner edge. */
export function SwatchBox({ swatch }: { swatch: Swatch }) {
  const size = swatch.small ? 12 : 16;
  return (
    <Box
      sx={{
        width: swatch.wide ? 40 : size,
        height: swatch.wide ? 12 : size,
        flex: "none",
        borderRadius: swatch.wide || swatch.small ? "3px" : "4px",
        boxShadow: (theme) => `inset 0 0 0 1px ${theme.palette.divider}`,
        background: swatch.background,
      }}
    />
  );
}

/** A small rising curve: the value changes by zoom. */
export function CurveGlyph() {
  return (
    <svg width="16" height="12" viewBox="0 0 16 12" aria-hidden="true" style={{ flex: "none" }}>
      <path d="M1 11 C 6 11, 9 2, 15 1" fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

/** A dot after a value that differs from all features (class scope). */
export function OverrideDot() {
  const { t } = useTranslation("common");
  return (
    <Tooltip title={t("style_editor.differs_for_some_features")}>
      <Box
        component="span"
        sx={{ width: 6, height: 6, borderRadius: "50%", bgcolor: "primary.main", flex: "none" }}
      />
    </Tooltip>
  );
}

export interface ValueButtonProps {
  value: ReactNode;
  swatch?: Swatch;
  /** Drawn before the value instead of a swatch: an icon. */
  glyph?: ReactNode;
  curve?: boolean;
  overrideDot?: boolean;
  warn?: string;
  /** The field's name when its value does not say it (an emoji alone). */
  ariaLabel?: string;
  onOpen: (anchor: HTMLElement) => void;
}

/** A value in a field (prototype v39): swatch, summary and a chevron, opening its editor or picker. */
export function ValueButton({
  value,
  swatch,
  glyph,
  curve,
  overrideDot,
  warn,
  ariaLabel,
  onOpen,
  buttonRef,
  expanded,
  active,
}: ValueButtonProps & {
  buttonRef: (el: HTMLButtonElement | null) => void;
  expanded: boolean;
  /** Its editor is open, opened from it or from elsewhere (the mode menu). */
  active: boolean;
}) {
  return (
    <FieldButton
      onClick={onOpen}
      ariaLabel={ariaLabel}
      buttonRef={buttonRef}
      expanded={expanded}
      active={active}
      end={<Icon iconName={ICON_NAME.CHEVRON_RIGHT} sx={{ fontSize: 10, color: "text.secondary" }} />}>
      {swatch && <SwatchBox swatch={swatch} />}
      {glyph}
      {curve && <CurveGlyph />}
      <Typography component="span" variant="body2" fontWeight="bold" noWrap sx={{ flex: 1, minWidth: 0 }}>
        {value}
      </Typography>
      {overrideDot && <OverrideDot />}
      {warn && (
        <Tooltip title={warn}>
          <Box
            component="span"
            sx={{ width: 6, height: 6, borderRadius: "50%", bgcolor: "warning.main", flex: "none" }}
          />
        </Tooltip>
      )}
    </FieldButton>
  );
}

export interface GroupRowProps extends ValueButtonProps {
  label: ReactNode;
  off?: boolean;
  active?: boolean;
  mode?: ReactNode;
}

export const GroupRow = memo(function GroupRow({ label, off, active, mode, ...value }: GroupRowProps) {
  const [button, setButton] = useState<HTMLButtonElement | null>(null);
  const expanded = useIsOpener(button);
  return (
    <Row label={label} actions={mode} off={off} active={active || expanded}>
      <ValueButton {...value} buttonRef={setButton} expanded={expanded} active={!!active || expanded} />
    </Row>
  );
});

export interface NavRowProps extends ValueButtonProps {
  label?: ReactNode;
  active?: boolean;
}

export const NavRow = memo(function NavRow({ label, active, ...value }: NavRowProps) {
  const [button, setButton] = useState<HTMLButtonElement | null>(null);
  const expanded = useIsOpener(button);
  return (
    <Row label={label} active={active || expanded}>
      <ValueButton {...value} buttonRef={setButton} expanded={expanded} active={!!active || expanded} />
    </Row>
  );
});
