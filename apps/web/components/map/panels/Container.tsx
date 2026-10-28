import { Box, Divider, IconButton, Paper, Stack, Tooltip, Typography, useTheme } from "@mui/material";
import React, { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import type { MapSidebarItem } from "@/types/map/sidebar";

interface ContainerProps {
  header?: React.ReactNode;
  title?: string;
  direction?: "left" | "right";
  body?: React.ReactNode;
  action?: React.ReactNode;
  close?: (item: MapSidebarItem | undefined) => void;
  disablePadding?: boolean;
  backgroundColor?: string;
  disableClose?: boolean;
}

export default function Container(props: ContainerProps) {
  const { header, body, action, close, title, disableClose } = props;
  const [showTooltip, setShowTooltip] = useState(false);
  const textRef = useRef<HTMLSpanElement>(null);

  const theme = useTheme();
  const { t } = useTranslation("common");

  useEffect(() => {
    const checkOverflow = () => {
      if (textRef.current) {
        const isOverflowing = textRef.current.scrollWidth > textRef.current.clientWidth;
        setShowTooltip(isOverflowing);
      }
    };

    checkOverflow();
    window.addEventListener("resize", checkOverflow);
    return () => window.removeEventListener("resize", checkOverflow);
  }, [title]);

  return (
    <Stack
      sx={{
        height: "100%",
      }}>
      {(header || title) && (
        <>
          <Stack
            sx={{
              paddingTop: theme.spacing(2),
              paddingLeft: theme.spacing(3),
              paddingRight: theme.spacing(3),
              justifyContent: "space-between",
              alignItems: "center",
            }}
            direction="row">
            {header ? (
              <Box
                sx={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: "20px",
                  width: "100%",
                }}>
                {header}
                {disableClose !== true && close && (
                  <IconButton aria-label={t("close")} onClick={() => close(undefined)}>
                    <Icon iconName={ICON_NAME.CLOSE} fontSize="small" />
                  </IconButton>
                )}
              </Box>
            ) : (
              <Box
                sx={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: "20px",
                  width: "100%",
                }}>
                <Tooltip title={title} arrow placement="top" disableHoverListener={!showTooltip}>
                  <Typography
                    variant="body1"
                    fontWeight="bold"
                    ref={textRef}
                    sx={{
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      flex: "1 1 0",
                      minWidth: 0,
                    }}>
                    {title}
                  </Typography>
                </Tooltip>
                {disableClose !== true && close && (
                  <IconButton aria-label={t("close")} onClick={() => close(undefined)}>
                    <Icon iconName={ICON_NAME.CLOSE} fontSize="small" />
                  </IconButton>
                )}
              </Box>
            )}
          </Stack>
          <Divider sx={{ pb: 0, mb: 0 }} />
        </>
      )}
      {body && (
        <Stack
          direction="column"
          sx={{
            pt: 2,
            pb: 7,
            ...(!props.disablePadding && {
              px: 3,
            }),
            overflowY: "auto",
            height: "100%",
            "&::-webkit-scrollbar": {
              width: "6px",
            },
            "&::-webkit-scrollbar-thumb": {
              background: "#2836484D",
              borderRadius: "3px",
              "&:hover": {
                background: "#28364880",
              },
            },
          }}>
          {body}
        </Stack>
      )}
      {action && (
        <>
          <Divider sx={{ py: 0, my: 0 }} />
          <Paper
            sx={{
              borderRadius: "0",
              backgroundColor: "transparent",
            }}>
            <Stack
              direction="row"
              sx={{
                py: theme.spacing(4),
                px: theme.spacing(3),
                // The action bar is the panel's chrome: it keeps its full height and
                // the body scrolls instead. Without this the flex layout shrinks it
                // and clips the buttons inside it.
                flexShrink: 0,
              }}>
              {action}
            </Stack>
          </Paper>
        </>
      )}
    </Stack>
  );
}
