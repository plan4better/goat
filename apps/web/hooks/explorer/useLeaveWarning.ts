/**
 * Unsaved changes live only in this tab (the session is the browser's):
 * reloading or closing it asks first.
 */
import { useEffect } from "react";

export function useLeaveWarning(unsaved: boolean): void {
  useEffect(() => {
    if (!unsaved) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      // Older browsers need a value; every current one shows its own text.
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [unsaved]);
}
