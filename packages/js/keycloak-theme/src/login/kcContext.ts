import { createGetKcContext } from "keycloakify/login";
import { createContext } from "react";

//NOTE: In most of the cases you do not need to overload the KcContext, you can
// just call createGetKcContext(...) without type arguments.
// You want to overload the KcContext only if:
// - You have custom plugins that add some values to the context (like https://github.com/micedre/keycloak-mail-whitelisting that adds authorizedMailDomains)
// - You want to add support for extra pages that are not yey featured by default, see: https://docs.keycloakify.dev/contributing#adding-support-for-a-new-page
export const { getKcContext } = createGetKcContext({
  mockData: [
    {
      pageId: "login.ftl",
      locale: {
        //When we test the login page we do it in english
        currentLanguageTag: "en",
      },

      //Uncomment the following line for hiding the Alert message
      //message: undefined,
      //Uncomment the following line for showing an Error message
      message: { type: "error", summary: "This is an error" },
    },
    {
      locale: {
        currentLanguageTag: "en",
      },
      pageId: "register-user-profile.ftl",
      recaptchaRequired: true,
      recaptchaSiteKey: "6Lfr41UmAAAAAMXV9Q2YVZJ8ND0OYs48mCIFAi8h",
      profile: {
        attributes: [
          {
            required: true,
            value: undefined,
            name: "username",
          },
          {
            value: undefined,
            name: "terms_and_conditions",
            required: true,
          },
          {
            value: undefined,
            name: "subscribe_to_newsletter",
            required: false,
            annotations: { trialEmailsNote: "true" },
          },
        ],
      },
    },
  ],
});

export const { kcContext } = getKcContext({
  // Uncomment to test the login page for development.
  //mockPageId: "login.ftl",
});

export type KcContext = NonNullable<ReturnType<typeof getKcContext>["kcContext"]>;

// eslint-disable-next-line @typescript-eslint/no-empty-function
export const ColorModeContext = createContext({ toggleColorMode: () => {} });