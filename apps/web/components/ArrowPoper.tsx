import { Box, ClickAwayListener, Grow } from "@mui/material";
import Paper from "@mui/material/Paper";
import type { PopperPlacementType } from "@mui/material/Popper";
import MuiPopper from "@mui/material/Popper";
import { styled } from "@mui/material/styles";
import type { ReactElement } from "react";
import { useState } from "react";
import React from "react";

import { POPOVER_GAP } from "@p4b/ui/theme/popoverSurface";

interface Props {
  content: ReactElement;
  children: ReactElement<Record<string, unknown>>;
  open: boolean;
  onClose?: () => void;
  arrow?: boolean;
  placement?: PopperPlacementType;
  disablePortal?: boolean;
  isClickAwayEnabled?: boolean;
  popperStyle?: React.CSSProperties;
  // Auto-flip placement when the popper would overflow the viewport
  // (e.g. a "right"-placed menu near the right edge flips to "left").
  // Off by default to preserve fixed-placement behavior for existing callers.
  enableFlip?: boolean;
}

const Popper = styled(MuiPopper, {
  shouldForwardProp: (prop) => prop !== "arrow",
})(({ theme }) => ({
  zIndex: 1300, // Higher than MUI modal (1300) to ensure it appears above report elements
  "& > div": {
    position: "relative",
  },
  '&[data-popper-placement*="bottom"]': {
    "& > div": {
      marginTop: POPOVER_GAP,
    },
    "& .MuiPopper-arrow": {
      top: 0,
      left: 0,
      marginTop: "-0.9em",
      width: "3em",
      height: "1em",
      "&::before": {
        borderWidth: "0 1em 1em 1em",
        borderColor: `transparent transparent ${theme.palette.background.paper} transparent`,
      },
    },
  },
  '&[data-popper-placement*="top"]': {
    "& > div": {
      marginBottom: POPOVER_GAP,
    },
    "& .MuiPopper-arrow": {
      bottom: 0,
      left: 0,
      marginBottom: "-0.9em",
      width: "3em",
      height: "1em",
      "&::before": {
        borderWidth: "1em 1em 0 1em",
        borderColor: `${theme.palette.background.paper} transparent transparent transparent`,
      },
    },
  },
  '&[data-popper-placement*="right"]': {
    "& > div": {
      marginLeft: POPOVER_GAP,
    },
    "& .MuiPopper-arrow": {
      left: 0,
      marginLeft: "-0.9em",
      height: "3em",
      width: "1em",
      "&::before": {
        borderWidth: "1em 1em 1em 0",
        borderColor: `transparent ${theme.palette.background.paper} transparent transparent`,
      },
    },
  },
  '&[data-popper-placement*="left"]': {
    "& > div": {
      marginRight: POPOVER_GAP,
    },
    "& .MuiPopper-arrow": {
      right: 0,
      marginRight: "-0.9em",
      height: "3em",
      width: "1em",
      "&::before": {
        borderWidth: "1em 0 1em 1em",
        borderColor: `transparent transparent transparent ${theme.palette.background.paper}`,
      },
    },
  },
}));

const Arrow = styled("div")({
  position: "absolute",
  fontSize: 7,
  width: "3em",
  height: "3em",
  "&::before": {
    content: '""',
    margin: "auto",
    display: "block",
    width: 0,
    height: 0,
    borderStyle: "solid",
  },
});

export function ArrowPopper({
  placement = "top",
  disablePortal = true,
  arrow = true,
  open,
  onClose = () => undefined,
  content,
  children,
  isClickAwayEnabled = true,
  popperStyle,
  enableFlip = false,
}: Props) {
  const [arrowRef, setArrowRef] = useState<HTMLElement | null>(null);
  const [childNode, setChildNode] = useState<HTMLElement | null>(null);

  return (
    <div>
      {React.cloneElement(children, { ...children.props, ref: setChildNode })}
      <Popper
        open={open}
        anchorEl={childNode}
        placement={placement}
        transition
        style={popperStyle}
        disablePortal={disablePortal}
        modifiers={[
          {
            name: "flip",
            enabled: enableFlip,
            options: {
              altBoundary: true,
              rootBoundary: "viewport",
              padding: 8,
            },
          },
          {
            name: "preventOverflow",
            enabled: true,
            options: {
              altAxis: true,
              altBoundary: true,
              tether: false,
              rootBoundary: "viewport",
              padding: 8,
            },
          },
          {
            name: "arrow",
            enabled: true,
            options: {
              element: arrowRef,
            },
          },
        ]}>
        {({ TransitionProps }) => (
          <Grow {...TransitionProps} timeout={150}>
            {/* Structure only: the content brings its own Paper, so these two
             * wrappers stay invisible — a painted wrapper shows as a square
             * corner behind any content with a larger radius or a margin. */}
            <Paper elevation={0} sx={{ backgroundColor: "transparent", backgroundImage: "none" }}>
              <ClickAwayListener
                onClickAway={() => {
                  if (isClickAwayEnabled) {
                    onClose();
                  }
                }}>
                <Paper elevation={0} sx={{ backgroundColor: "transparent", backgroundImage: "none" }}>
                  {arrow ? <Arrow ref={setArrowRef} className="MuiPopper-arrow" /> : null}
                  <Box>{content}</Box>
                </Paper>
              </ClickAwayListener>
            </Paper>
          </Grow>
        )}
      </Popper>
    </div>
  );
}
