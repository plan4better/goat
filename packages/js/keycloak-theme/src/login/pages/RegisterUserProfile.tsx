import {
  Box,
  Button,
  Stack,
  Tooltip,
  Typography,
  useTheme,
} from "@mui/material";
import Link from "@mui/material/Link";
import type { PageProps } from "keycloakify/login/pages/PageProps";
import { useRef, useState } from "react";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import ReCAPTCHA from "react-google-recaptcha";

import type { I18n } from "../i18n";
import type { KcContext } from "../kcContext";
import { UserProfileFormFields } from "./shared/UserProfileFormFields";

// One step: the fields come from the realm's user profile (realm/user-profile.json),
// shown in this order (no stepper: there is a single list and no active step).
// The username is only asked for when the realm does not use the email as the
// username (registrationEmailAsUsername): the GOAT realm does, so it is left out.
const fieldOrder = (registrationEmailAsUsername: boolean) => ({
  1: [
    "firstName",
    "lastName",
    ...(registrationEmailAsUsername ? [] : ["username"]),
    "email",
    "password",
    "password-confirm",
    "terms_and_conditions",
    "subscribe_to_newsletter",
  ],
});

export default function RegisterUserProfile(
  props: PageProps<
    Extract<KcContext, { pageId: "register-user-profile.ftl" }>,
    I18n
  >,
) {
  const theme = useTheme();
  const { kcContext, i18n, doUseDefaultCss, Template } = props;
  const { url, messagesPerField, recaptchaRequired, recaptchaSiteKey, realm } =
    kcContext;
  const { msg, msgStr } = i18n;
  const [isFormSubmittable, setIsFormSubmittable] = useState(false);
  const [isCaptchaValid, setIsCaptchaValid] = useState(false);
  const captchaRef = useRef(null);
  const getIncrementedTabIndex = (() => {
    let counter = 1;
    return () => counter++;
  })();

  return (
    <Template
      {...{ kcContext, i18n, doUseDefaultCss }}
      displayInfo={true}
      displayMessage={messagesPerField.exists("global")}
      displayRequiredFields={false}
      i18n={i18n}
      infoNode={
        <Stack
          spacing={theme.spacing(4)}
          sx={{
            textAlign: "center",
          }}
        >
          <Typography variant="body2">
            {msg("alreadyHaveAccount")}{" "}
            <Link href={url.loginUrl}>{msg("doLogIn")}</Link>
          </Typography>
        </Stack>
      }
      headerNode={msg("doRegister")}
    >
      <Box component="form" action={url.registrationAction} method="post">
        <UserProfileFormFields
          kcContext={kcContext}
          onIsFormSubmittableValueChange={setIsFormSubmittable}
          steps={fieldOrder(realm.registrationEmailAsUsername)}
          i18n={i18n}
          getIncrementedTabIndex={getIncrementedTabIndex}
        />

        {recaptchaRequired && (
          <ReCAPTCHA
            id="recaptcha"
            hl={i18n.currentLanguageTag}
            theme={theme.palette.mode == "dark" ? "dark" : "light"}
            sx={{
              mt: theme.spacing(4),
            }}
            sitekey={recaptchaSiteKey}
            onChange={() => setIsCaptchaValid(true)}
            onExpired={() => setIsCaptchaValid(false)}
            onErrored={() => setIsCaptchaValid(false)}
            ref={captchaRef}
          />
        )}
        <div>
          {(() => {
            const button = (
              <Button
                sx={{
                  mt: theme.spacing(4),
                }}
                fullWidth
                disabled={
                  !isFormSubmittable || (recaptchaRequired && !isCaptchaValid)
                }
                type="submit"
                tabIndex={getIncrementedTabIndex()}
              >
                {msgStr("getStarted")}
              </Button>
            );

            return isFormSubmittable ? (
              button
            ) : (
              <Tooltip title={msg("formNotFilledProperly")}>
                <span>{button}</span>
              </Tooltip>
            );
          })()}
        </div>
      </Box>
    </Template>
  );
}
