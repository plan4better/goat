"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import LoadingButton from "@mui/lab/LoadingButton";
import {
  Alert,
  Box,
  Button,
  Stack,
  TextField,
  Typography,
  useTheme,
} from "@mui/material";
import { signOut, useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import type * as z from "zod";

import AuthContainer from "@p4b/ui/components/AuthContainer";
import AuthLayout from "@p4b/ui/components/AuthLayout";

import { createOrganization } from "@/lib/api/organizations";
import { useFeatures, useOrganizationCreation } from "@/lib/api/users";
import { ORG_DEFAULT_AVATAR } from "@/lib/constants";
import { postOrganizationSchema } from "@/lib/validations/organization";

import type { ResponseResult } from "@/types/common";

import { useOrganizationSetup } from "@/hooks/onboarding/OrganizationCreate";

import { RhfSelectField } from "@/components/common/form-inputs/SelectField";

type FormData = z.infer<typeof postOrganizationSchema>;

export default function OrganizationOnBoarding() {
  const theme = useTheme();
  const { status, update } = useSession();
  const router = useRouter();
  const { t, orgTypesOptions } = useOrganizationSetup();
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
  const [responseResult, setResponseResult] = useState<ResponseResult>({
    message: "",
    status: undefined,
  });

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
    setResponseResult({ message: "", status: undefined });
    setIsBusy(true);
    try {
      await createOrganization(data);
    } catch (_error) {
      setResponseResult({
        message: t("common:organization_creation_error"),
        status: "error",
      });
    } finally {
      setIsBusy(false);
    }
    update();
    router.push("/");
  }

  return (
    <AuthLayout>
      {status == "authenticated" && mayCreate && (
        <AuthContainer
          headerTitle={
            <Stack sx={{ mb: 8 }} spacing={2}>
              <Typography variant="h5">{t("common:new_organization_title")}</Typography>
              <Typography variant="body2">{t("common:new_organization_subtitle")}</Typography>
            </Stack>
          }
          headerAlert={
            responseResult.status && <Alert severity={responseResult.status}>{responseResult.message}</Alert>
          }
          body={
            <Box component="form" onSubmit={handleSubmit(onSubmit)}>
              <Stack spacing={theme.spacing(4)}>
                <TextField
                  fullWidth
                  required
                  helperText={errors.name ? errors.name?.message : t("common:organization_name_desc")}
                  label={t("common:organization_name_label")}
                  id="name"
                  {...register("name")}
                  error={errors.name ? true : false}
                />

                <RhfSelectField
                  options={orgTypesOptions}
                  control={control}
                  name="type"
                  required
                  label={t("common:organization_type_label")}
                />

                <Stack spacing={3}>
                  {features?.billing && (
                    <Typography variant="body1">{t("common:organization_onboarding_trial_note")}</Typography>
                  )}
                  <Typography variant="body2">{t("common:organization_accept_terms")}</Typography>
                </Stack>
              </Stack>
              <LoadingButton
                loading={isBusy}
                variant="contained"
                sx={{ mt: theme.spacing(4) }}
                fullWidth
                name="organization-submit"
                type="submit"
                disabled={!allowSubmit}>
                {t("common:lets_get_started")}
              </LoadingButton>
              <Stack>
                <Button
                  sx={{
                    mt: theme.spacing(4),
                  }}
                  fullWidth
                  onClick={() => signOut({ callbackUrl: "/" })}
                  variant="text"
                  color="error">
                  {t("common:logout")}
                </Button>
              </Stack>
            </Box>
          }
        />
      )}
    </AuthLayout>
  );
}
