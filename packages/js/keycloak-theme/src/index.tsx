import { createPagePreview } from "login/createPagePreview";
import { lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";

import { kcContext as kcLoginThemeContext } from "./login/kcContext";

const KcLoginThemeApp = lazy(() => import("./login/KcApp"));
const { PagePreview } = createPagePreview({
  pageId: "login-reset-password.ftl",
});

// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
createRoot(document.getElementById("root")!).render(
  <Suspense>
    {(() => {
      if (kcLoginThemeContext !== undefined) {
        return <KcLoginThemeApp kcContext={kcLoginThemeContext} />;
      }
      return <PagePreview />;
    })()}
  </Suspense>
);
