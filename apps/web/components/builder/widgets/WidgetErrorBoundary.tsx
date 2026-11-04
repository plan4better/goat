import { Component, type ErrorInfo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { ICON_NAME } from "@p4b/ui/components/Icon";

import EmptySection from "@/components/common/EmptySection";

function WidgetCannotBeShown() {
  const { t } = useTranslation("common");
  return <EmptySection icon={ICON_NAME.CIRCLEINFO} label={t("widget_cannot_be_shown")} />;
}

interface WidgetErrorBoundaryProps {
  widgetId: string;
  /** Changes with the widget's config: a failed widget tries again after an edit. */
  resetKey: string;
  /** In the editor the failed widget says so; a published dashboard leaves it out. */
  showNotice: boolean;
  children: ReactNode;
}

interface WidgetErrorBoundaryState {
  failed: boolean;
}

/**
 * Keeps a widget that fails to render (a config it cannot handle, data it does
 * not expect) to itself. Without it the error unmounts everything up to the
 * app's error page, the whole project page included.
 */
export default class WidgetErrorBoundary extends Component<
  WidgetErrorBoundaryProps,
  WidgetErrorBoundaryState
> {
  state: WidgetErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): WidgetErrorBoundaryState {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`Widget ${this.props.widgetId} failed to render`, error, info.componentStack);
  }

  componentDidUpdate(previous: WidgetErrorBoundaryProps) {
    if (this.state.failed && previous.resetKey !== this.props.resetKey) {
      this.setState({ failed: false });
    }
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return this.props.showNotice ? <WidgetCannotBeShown /> : null;
  }
}
