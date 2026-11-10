"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import LoadingButton from "@mui/lab/LoadingButton";
import { Alert, Box, Link, MenuItem, Stack, Typography, useTheme } from "@mui/material";
import { signOut, useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { Trans, useTranslation } from "react-i18next";
import type * as z from "zod";

import AuthContainer from "@p4b/ui/components/AuthContainer";
import AuthLayout from "@p4b/ui/components/AuthLayout";

import { createOrganization } from "@/lib/api/organizations";
import { useFeatures, useOrganizationCreation } from "@/lib/api/users";
import { ORG_DEFAULT_AVATAR, privacyPolicyUrl } from "@/lib/constants";
import { postOrganizationSchema } from "@/lib/validations/organization";

import { useOrganizationSetup } from "@/hooks/onboarding/OrganizationCreate";

import LabeledField from "@/components/common/LabeledField";

type FormData = z.infer<typeof postOrganizationSchema>;

export default function OrganizationOnBoarding() {
  const theme = useTheme();
  const { status, data: session, update } = useSession();
  const router = useRouter();
  const { t, i18n } = useTranslation("common");
  const { orgTypesOptions } = useOrganizationSetup();
  // Where only administrators create organizations, everyone else waits for
  // an invitation. Without an answer the form is shown; core refuses the
  // creation itself.
  const { organizationCreation, isError: creationError } = useOrganizationCreation();
  // The trial note belongs to the SaaS (billing on); the newsletter is asked at sign-up.
  const { features } = useFeatures();
  const mayCreate = organizationCreation?.allowed === true || !!creationError;

  useEffect(() => {
    if (organizationCreation?.allowed === false) {
      router.replace("/onboarding/organization/waiting");
    }
  }, [organizationCreation?.allowed, router]);

  const [isBusy, setIsBusy] = useState<boolean>(false);
  const [failed, setFailed] = useState(false);

  const {
    handleSubmit,
    register,
    watch,
    formState: { errors },
    control,
  } = useForm<FormData>({
    mode: "onChange",
    resolver: zodResolver(postOrganizationSchema),
    defaultValues: {
      avatar: ORG_DEFAULT_AVATAR,
      // Asked at sign-up (Keycloak), not here.
      newsletter_subscribe: false,
    },
  });

  const watchFormValues = watch();

  const allowSubmit = useMemo(() => {
    return watchFormValues.name && watchFormValues.type && !errors.name && !errors.type;
  }, [errors.name, errors.type, watchFormValues]);

  async function onSubmit(data: FormData) {
    setFailed(false);
    setIsBusy(true);
    try {
      await createOrganization(data);
    } catch (_error) {
      // Stay here: the form keeps what was typed and says what happened.
      setFailed(true);
      setIsBusy(false);
      return;
    }
    update();
    router.push("/");
  }

  const privacyUrl = privacyPolicyUrl(i18n.language?.startsWith("de") ? "de" : "en");
  const email = session?.user?.email;

  return (
    <AuthLayout>
      {status == "authenticated" && mayCreate && (
        <AuthContainer
          headerTitle={
            <Stack spacing={2}>
              <Typography variant="h5" component="h1">
                {t("new_organization_title")}
              </Typography>
              <Typography variant="body2" color="text.secondary">
                {t("new_organization_subtitle")}
              </Typography>
            </Stack>
          }
          headerAlert={failed && <Alert severity="error">{t("organization_creation_error")}</Alert>}
          body={
            <Box component="form" noValidate onSubmit={handleSubmit(onSubmit)}>
              <Stack spacing={5}>
                <LabeledField
                  id="organization-name"
                  label={t("organization_name_label")}
                  required
                  autoComplete="organization"
                  {...register("name")}
                  error={errors.name?.message}
                  help={t("organization_name_desc")}
                />
                <Controller
                  name="type"
                  control={control}
                  render={({ field }) => (
                    <LabeledField
                      id="organization-type"
                      label={t("organization_type_label")}
                      required
                      select
                      name={field.name}
                      ref={field.ref}
                      value={field.value ?? ""}
                      onChange={(event) => field.onChange(event.target.value)}
                      onBlur={field.onBlur}
                      error={errors.type?.message}
                      SelectProps={{ MenuProps: { sx: { maxHeight: "350px" } } }}>
                      {orgTypesOptions
                        .filter((option) => option.value)
                        .map((option) => (
                          <MenuItem key={option.value} value={option.value}>
                            {option.label}
                          </MenuItem>
                        ))}
                    </LabeledField>
                  )}
                />
                {features?.billing && (
                  <Typography variant="body2" color="text.secondary">
                    {t("organization_onboarding_trial_note")}
                  </Typography>
                )}
                <LoadingButton
                  loading={isBusy}
                  variant="contained"
                  fullWidth
                  name="organization-submit"
                  type="submit"
                  disabled={!allowSubmit}>
                  {t("organization_create_submit")}
                </LoadingButton>
              </Stack>
              <Typography
                variant="caption"
                component="p"
                color="text.secondary"
                sx={{ mt: 3, textAlign: "center" }}>
                <Trans
                  t={t}
                  i18nKey="organization_accept_terms"
                  components={{
                    privacy: privacyUrl ? (
                      <Link
                        href={privacyUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        color="inherit"
                        underline="always"
                      />
                    ) : (
                      <span />
                    ),
                  }}
                />
              </Typography>
              {/* Which account this is, so a sign-up with the wrong address is noticed here. */}
              <Stack
                direction="row"
                flexWrap="wrap"
                justifyContent="center"
                alignItems="baseline"
                columnGap={2}
                sx={{ mt: 5, pt: 4, borderTop: `1px solid ${theme.palette.divider}` }}>
                {email && (
                  <Typography variant="caption" color="text.secondary" sx={{ overflowWrap: "anywhere" }}>
                    {t("onboarding_signed_in_as", { email })}
                  </Typography>
                )}
                <Link
                  component="button"
                  type="button"
                  variant="caption"
                  underline="hover"
                  onClick={() => signOut({ callbackUrl: "/" })}>
                  {t("logout")}
                </Link>
              </Stack>
            </Box>
          }
        />
      )}
    </AuthLayout>
  );
}
