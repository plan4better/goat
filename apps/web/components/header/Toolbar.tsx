"use client";

import {
  AppBar,
  Divider,
  IconButton,
  Toolbar as MUIToolbar,
  Stack,
  type Theme,
  useTheme,
} from "@mui/material";
import React from "react";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

/** The top bar's height, without its bottom border. The assistant dock's header uses it too, so the two line up. */
export const TOOLBAR_HEIGHT = 52;

/** The top bar's bottom border; shared with the assistant dock's header. */
export const toolbarBorder = (theme: Theme): string => `1px solid ${theme.palette.divider}`;

export type MapToolbarProps = {
  LeftToolbarChild?: React.ReactNode;
  CenterToolbarChild?: React.ReactNode;
  RightToolbarChild?: React.ReactNode;
  height: number;
  showHambugerMenu?: boolean;
  onMenuIconClick?: () => void;
  /** What of the left column always stays visible (its first control), in px. */
  leftMinWidth?: number;
};

export function Toolbar(props: MapToolbarProps) {
  const {
    LeftToolbarChild,
    CenterToolbarChild,
    RightToolbarChild,
    height,
    showHambugerMenu,
    onMenuIconClick,
    leftMinWidth = 0,
  } = props;

  const theme = useTheme();

  return (
    <AppBar
      position="relative"
      elevation={0}
      color="primary"
      sx={{
        zIndex: (theme) => theme.zIndex.drawer + 2,
        borderBottom: toolbarBorder,
      }}>
      <MUIToolbar
        variant="dense"
        sx={{
          minHeight: height,
          height: height,
          boxShadow: "0px 0px 10px 0px rgba(58, 53, 65, 0.1)",
        }}>
        {showHambugerMenu && (
          <>
            {/* Shown below md by CSS so the server-rendered HTML is right before hydration. */}
            <IconButton onClick={onMenuIconClick} sx={{ display: { xs: "inline-flex", md: "none" } }}>
              <Icon iconName={ICON_NAME.HAMBURGER_MENU} fontSize="inherit" />
            </IconButton>

            <Divider
              orientation="vertical"
              flexItem
              sx={{ ml: 2, mr: 3, display: { xs: "block", md: "none" } }}
            />
          </>
        )}

        {/* Three columns rather than an absolutely-centred middle: the side columns
            share the leftover space equally, which keeps the centre child centred
            while there is room. When there is not (a narrow window, or the assistant
            dock beside the page), the right column keeps its buttons, the left one
            truncates down to `leftMinWidth`, and only then the centre child shrinks. */}
        <Stack
          direction="row"
          alignItems="center"
          sx={{
            gap: theme.spacing(2),
            flex: "1 1 0",
            minWidth: leftMinWidth,
            overflow: "hidden",
            whiteSpace: "nowrap",
          }}>
          {LeftToolbarChild}
        </Stack>

        {CenterToolbarChild && (
          <Stack
            direction="row"
            alignItems="center"
            justifyContent="center"
            sx={{
              flex: "0 1 auto",
              minWidth: 0,
              mx: theme.spacing(2),
            }}>
            {CenterToolbarChild}
          </Stack>
        )}

        <Stack
          direction="row"
          alignItems="center"
          justifyContent="flex-end"
          sx={{
            flex: "1 1 0",
            minWidth: "max-content",
          }}>
          {RightToolbarChild}
        </Stack>
      </MUIToolbar>
    </AppBar>
  );
}
