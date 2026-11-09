import type { DeepPartial } from "keycloakify/tools/DeepPartial";

import KcApp from "./KcApp";
import { getKcContext, type KcContext } from "./kcContext";

/** A login page with mocked Keycloak data, for working on the theme outside Keycloak. */
export function createPagePreview<PageId extends KcContext["pageId"]>(params: {
  pageId: PageId;
}) {
  const { pageId } = params;

  function PagePreview(params: {
    kcContext?: DeepPartial<Extract<KcContext, { pageId: PageId }>>;
  }) {
    const { kcContext } = getKcContext({
      mockPageId: pageId,
      storyPartialKcContext: params.kcContext,
    });
    return <KcApp kcContext={kcContext} />;
  }

  return { PagePreview };
}
