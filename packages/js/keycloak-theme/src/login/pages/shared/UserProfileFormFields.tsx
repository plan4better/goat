import {
  Box,
  Checkbox,
  Link,
  MenuItem,
  TextField,
  Typography,
  useTheme,
} from "@mui/material";
import { Stepper, Step, StepLabel } from "@mui/material";
import FormControlLabel from "@mui/material/FormControlLabel";
import type { Attribute } from "keycloakify/login/kcContext/KcContext";
import { useFormValidation } from "keycloakify/login/lib/useFormValidation";
import { useMemo, useEffect, useState, Fragment } from "react";

import type { I18n } from "../../i18n";
import { getCountries } from "../../i18n";
import { getThemeProperty } from "../../themeProperties";

interface Steps {
  [key: number]: string[];
}

export type UserProfileFormFieldsProps = {
  kcContext: Parameters<typeof useFormValidation>[0]["kcContext"];
  i18n: I18n;
  onIsFormSubmittableValueChange: (isFormSubmittable: boolean) => void;
  activeStep?: number;
  steps?: Steps;
  BeforeField?: (props: { attribute: Attribute }) => React.JSX.Element | null;
  AfterField?: (props: { attribute: Attribute }) => React.JSX.Element | null;
  getIncrementedTabIndex: () => number;
};

export type AttributeOption = string | { value: string; label: string };
export type AttributeOptions = AttributeOption[];

export function UserProfileFormFields(props: UserProfileFormFieldsProps) {
  const theme = useTheme();
  const {
    kcContext,
    onIsFormSubmittableValueChange,
    i18n,
    activeStep,
    steps,
    getIncrementedTabIndex,
  } = props;

  const { advancedMsg } = i18n;

  const {
    formValidationState: { fieldStateByAttributeName, isFormSubmittable },
    formValidationDispatch,
    attributesWithPassword,
  } = useFormValidation({
    kcContext,
    i18n,
  });
  const { msg, advancedMsgStr } = i18n;
  const privacyUrl = getThemeProperty(kcContext, "privacyUrl");

  const attributesWithPasswordOrdered = useMemo(() => {
    if (steps === undefined) {
      return attributesWithPassword;
    }
    const attributesWithPasswordOrdered: Attribute[] = [];
    for (const step of Object.values(steps)) {
      for (const attributeName of step) {
        const attribute = attributesWithPassword.find(
          ({ name }) => name === attributeName,
        );
        if (attribute !== undefined) {
          attributesWithPasswordOrdered.push(attribute);
        }
      }
    }
    return attributesWithPasswordOrdered;
  }, [attributesWithPassword, steps]);

  useEffect(() => {
    onIsFormSubmittableValueChange(isFormSubmittable);
  }, [isFormSubmittable, onIsFormSubmittableValueChange]);

  const areAllFieldsRequired = useMemo(
    () => attributesWithPasswordOrdered.every(({ required }) => required),
    [attributesWithPasswordOrdered],
  );

  // The terms and the newsletter are checkboxes of their own, not text fields.
  // Both are stored as the time they were ticked. Register starts them empty;
  // update and IdP review start them from the stored value, so the box shows
  // what the user agreed to before and resubmitting does not clear the consent.
  const termsAndConditions = attributesWithPasswordOrdered.find(
    ({ name }) => name === "terms_and_conditions",
  );
  const subscribeToNewsletter = attributesWithPasswordOrdered.find(
    ({ name }) => name === "subscribe_to_newsletter",
  );
  const textFieldAttributes = useMemo(
    () =>
      attributesWithPasswordOrdered.filter(
        ({ name }) =>
          name !== "terms_and_conditions" &&
          name !== "subscribe_to_newsletter",
      ),
    [attributesWithPasswordOrdered],
  );

  const [termsAcceptedAt, setTermsAcceptedAt] = useState(
    () => termsAndConditions?.value ?? "",
  );
  const [newsletterConsentAt, setNewsletterConsentAt] = useState(
    () => subscribeToNewsletter?.value ?? "",
  );

  // The checkbox posts its `value` when ticked and nothing when not, so the
  // value is the ISO timestamp of the moment it was ticked.
  const handleConsentChange =
    (
      name: "terms_and_conditions" | "subscribe_to_newsletter",
      setConsentAt: (value: string) => void,
    ) =>
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const newValue = event.target.checked ? new Date().toISOString() : "";
      setConsentAt(newValue);
      formValidationDispatch({ action: "update value", name, newValue });
    };
  const handleTermsAndConditionChange = handleConsentChange(
    "terms_and_conditions",
    setTermsAcceptedAt,
  );
  const handleSubscribeToNewsletterChange = handleConsentChange(
    "subscribe_to_newsletter",
    setNewsletterConsentAt,
  );

  // Options Dropdown for all fields that have a predefined list of values
  const attributeOptions = useMemo(() => {
    const options: { [key: string]: AttributeOptions } = {};
    textFieldAttributes.forEach((attribute) => {
      if (attribute.validators.options !== undefined) {
        // EdgeCase: Check if attributes.name is country
        // For country attributes we are getting the options from library
        if (attribute.name === "country") {
          const countries = getCountries(i18n.currentLanguageTag);
          options[attribute.name] = countries;
        } else {
          // translate options
          const options_i18n: AttributeOptions = [];
          attribute.validators.options.options.forEach((element: string) => {
            const option = advancedMsgStr(element);
            options_i18n.push({
              value: element,
              label: option,
            });
          });
          options[attribute.name] = options_i18n;
        }
      }
    });
    return options;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [i18n.currentLanguageTag]);

  return (
    <>
      {activeStep !== undefined && steps !== undefined && (
        <Stepper
          activeStep={activeStep}
          sx={{
            mb: theme.spacing(8),
          }}
        >
          {Object.keys(steps).map((label) => (
            <Step sx={{ paddingRight: 0 }} key={label}>
              <StepLabel> </StepLabel>
            </Step>
          ))}
        </Stepper>
      )}

      {textFieldAttributes.map((attribute, i) => {
        const { value, displayableErrors } =
          fieldStateByAttributeName[attribute.name];

        // find which step is attribute.name
        let isVisible = false;
        if (
          activeStep !== undefined &&
          steps !== undefined &&
          steps[activeStep + 1].includes(attribute.name)
        ) {
          isVisible = true;
        } else if (activeStep === undefined || steps === undefined) {
          isVisible = true;
        }

        return (
          <Fragment key={i}>
            <TextField
              sx={{
                mb: theme.spacing(4),
                display: isVisible ? "block" : "none",
              }}
              fullWidth
              type={(() => {
                switch (attribute.name) {
                  case "password-confirm":
                  case "password":
                    return "password";
                  default:
                    return "text";
                }
              })()}
              id={attribute.name}
              name={attribute.name}
              defaultValue={value}
              aria-invalid={displayableErrors.length !== 0}
              disabled={attribute.readOnly}
              autoComplete={attribute.autocomplete}
              onBlur={() => {
                formValidationDispatch({
                  action: "focus lost",
                  name: attribute.name,
                });
              }}
              aria-label={attribute.name}
              tabIndex={getIncrementedTabIndex()}
              onChange={(event) => {
                const { value } = event.target;
                formValidationDispatch({
                  action: "update value",
                  name: attribute.name,
                  newValue: value,
                });
              }}
              autoFocus={i === 0}
              spellCheck={false}
              required={!areAllFieldsRequired && attribute.required}
              label={advancedMsg(attribute.displayName ?? "")}
              helperText={(() => {
                const displayableErrors = fieldStateByAttributeName[
                  attribute.name
                ].displayableErrors.filter(
                  ({ validatorName }) =>
                    !(
                      validatorName === "pattern" && attribute.name === "email"
                    ),
                );

                if (displayableErrors.length !== 0) {
                  return displayableErrors.map(({ errorMessage }, i) => (
                    <span key={i}>{errorMessage}&nbsp;</span>
                  ));
                }
                switch (attribute.name) {
                  case "password": {
                    const { min } = attribute.validators.length ?? {};
                    if (min === undefined) {
                      break;
                    }
                    return msg("minimumLength", `${parseInt(min)}`);
                  }
                }
                {
                  const { pattern } = attribute.validators;
                  if (pattern !== undefined) {
                    const { "error-message": errorMessageKey } = pattern;
                    if (errorMessageKey !== undefined) {
                      return advancedMsg(errorMessageKey);
                    }
                  }
                }
                return undefined;
              })()}
              select={attribute.name in attributeOptions}
              error={displayableErrors.length !== 0}
            >
              {attribute.name in attributeOptions &&
                attributeOptions[attribute.name] !== undefined &&
                attributeOptions[attribute.name].map(
                  (option: string | AttributeOption) => {
                    if (typeof option === "string") {
                      return (
                        <MenuItem key={option} value={option}>
                          {option}
                        </MenuItem>
                      );
                    } else {
                      return (
                        <MenuItem key={option.value} value={option.value}>
                          {option.label}
                        </MenuItem>
                      );
                    }
                  },
                )}
            </TextField>
          </Fragment>
        );
      })}
      {/* Terms and Conditions */}
      {termsAndConditions && (activeStep == 1 || activeStep === undefined) && (
        <FormControlLabel
          control={
            <Checkbox
              id="terms_and_conditions"
              name="terms_and_conditions"
              color="primary"
              checked={termsAcceptedAt !== ""}
              value={termsAcceptedAt}
              onChange={handleTermsAndConditionChange}
              tabIndex={getIncrementedTabIndex()}
            />
          }
          label={
            <Box
              sx={{
                display: "flex",
              }}
            >
              <Typography variant="body2">
                {msg("accept")}
                {privacyUrl ? (
                  <Link
                    sx={{
                      marginLeft: "2px",
                    }}
                    href={privacyUrl}
                    target="_blank"
                  >
                    {msg("terms")}
                  </Link>
                ) : (
                  <Box component="span" sx={{ marginLeft: "2px" }}>
                    {msg("terms")}
                  </Box>
                )}
              </Typography>
            </Box>
          }
        />
      )}
      {/* Subscribe To Newsletter */}
      {subscribeToNewsletter &&
        (activeStep == 1 || activeStep === undefined) && (
          <FormControlLabel
            sx={{
              mb: theme.spacing(2),
            }}
            control={
              <Checkbox
                id="subscribe_to_newsletter"
                name="subscribe_to_newsletter"
                color="primary"
                checked={newsletterConsentAt !== ""}
                value={newsletterConsentAt}
                onChange={handleSubscribeToNewsletterChange}
                tabIndex={getIncrementedTabIndex()}
              />
            }
            label={
              <Box
                sx={{
                  display: "flex",
                }}
              >
                <Typography variant="body2">
                  {msg("subscribeToNewsletter")}
                </Typography>
              </Box>
            }
          />
        )}
      {/* The trial emails are part of the trial; the newsletter above is not.
          Only a realm whose operator sends such emails says so, with the
          annotation trialEmailsNote: "true" on the attribute (realm/README.md). */}
      {subscribeToNewsletter?.annotations?.trialEmailsNote === "true" &&
        (activeStep == 1 || activeStep === undefined) && (
          <Typography variant="caption" color="text.secondary" component="p">
            {msg("trialEmailsNote")}
          </Typography>
        )}
    </>
  );
}
