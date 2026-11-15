"use client";

import type { PaperProps } from "@mui/material";
import type { PopperPlacementType } from "@mui/material/Popper";

import PopoverPaper from "@/components/common/PopoverPaper";
import { HEADER_POPOVER_WIDTH } from "@/components/header/HeaderPopover";

/** Every header popover hangs from the right edge of its trigger, arrow-less. */
export const HEADER_POPOVER_PLACEMENT: PopperPlacementType = "bottom-end";

type Props = Omit<PaperProps, "elevation" | "variant"> & {
  /** CSS width; the default is the one shared by every header popover. */
  width?: string | number;
};

/**
 * The card of the header's popovers (jobs, What's new, the onboarding tray,
 * the account menu): the app's popover card at their shared width. The gap
 * below the trigger is `ArrowPopper`'s.
 */
const HeaderPopoverPaper = ({ width = HEADER_POPOVER_WIDTH, sx, children, ...rest }: Props) => (
  <PopoverPaper sx={[{ width }, ...(Array.isArray(sx) ? sx : [sx])]} {...rest}>
    {children}
  </PopoverPaper>
);

export default HeaderPopoverPaper;
