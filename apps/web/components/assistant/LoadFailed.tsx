"use client";

import { Button, Dialog, Stack, Typography, useTheme } from "@mui/material";
import { Component, type ComponentType, type ErrorInfo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { reloadPage } from "@/lib/utils/reloadPage";

import { mutedText, neutralPillSx } from "@/components/assistant/styles";

/**
 * A part of the dock that cannot be shown, and the way on: "Reload page" by
 * default, since after a deploy the code the open page asks for is gone from
 * the server, or a retry the caller offers.
 */
export function LoadFailedNotice({
  message,
  retry,
  onClose,
}: {
  message: string;
  retry?: () => void;
  onClose?: () => void;
}) {
  const { t } = useTranslation("common");
  const theme = useTheme();
  return (
    <Stack alignItems="center" justifyContent="center" gap="12px" sx={{ flex: 1, minHeight: 0, p: "24px" }}>
      <Typography role="alert" sx={{ fontSize: 13.5, textAlign: "center", color: mutedText(theme) }}>
        {message}
      </Typography>
      <Stack direction="row" gap="8px">
        {onClose && (
          <Button size="small" variant="outlined" color="inherit" onClick={onClose} sx={neutralPillSx(theme)}>
            {t("close")}
          </Button>
        )}
        <Button
          size="small"
          variant="outlined"
          color="inherit"
          onClick={() => (retry ? retry() : reloadPage())}
          sx={neutralPillSx(theme)}>
          {t(retry ? "assistant_retry" : "assistant_reload_page")}
        </Button>
      </Stack>
    </Stack>
  );
}

/** In place of a part of the dock whose code did not load, or that failed to show. */
export function PartLoadFailed() {
  const { t } = useTranslation("common");
  return <LoadFailedNotice message={t("assistant_part_load_failed")} />;
}

/**
 * A lazily loaded module with `Fallback` as its component when its code does
 * not load: `next/dynamic` would keep the failure and take the app down with it.
 */
export function orLoadFailed<P>(
  load: Promise<{ default: ComponentType<P> }>,
  Fallback: ComponentType<NoInfer<P>>
): Promise<{ default: ComponentType<P> }> {
  return load.catch(() => ({ default: Fallback }));
}

/** In place of a dialog the dock opens whose code did not load. */
export function DialogLoadFailed({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation("common");
  return (
    <Dialog open onClose={onClose} maxWidth="xs" fullWidth>
      <LoadFailedNotice message={t("assistant_part_load_failed")} onClose={onClose} />
    </Dialog>
  );
}

interface DockErrorBoundaryProps {
  /** The open conversation: another one shows again. */
  resetKey: string | null;
  children: ReactNode;
}

/**
 * Keeps a failure in the dock's conversation (a part whose code is gone, data
 * it does not expect) to the dock: its header stays, and the notice offers a
 * reload instead of the error replacing the whole app with its error page.
 */
export class DockErrorBoundary extends Component<DockErrorBoundaryProps, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("The AI dock failed to render", error, info.componentStack);
  }

  componentDidUpdate(previous: DockErrorBoundaryProps) {
    if (this.state.failed && previous.resetKey !== this.props.resetKey) {
      this.setState({ failed: false });
    }
  }

  render() {
    return this.state.failed ? <PartLoadFailed /> : this.props.children;
  }
}
