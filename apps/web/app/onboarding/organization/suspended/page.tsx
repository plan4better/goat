"use client";

import { Button, Stack, Typography } from "@mui/material";
import { signOut, useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";

import AuthContainer from "@p4b/ui/components/AuthContainer";
import AuthLayout from "@p4b/ui/components/AuthLayout";

import { useOrganization } from "@/lib/api/users";
import { CONTACT_URL } from "@/lib/constants";

export default function OrganizationSuspended() {
  const { t } = useTranslation("common");
  const { status } = useSession();
  const router = useRouter();
  const { organization, isLoading: isOrgLoading } = useOrganization();

  useEffect(() => {
    if (organization?.suspended === false) {
      router.push("/");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [organization]);

  return (
    <AuthLayout>
      <>
        {status == "authenticated" && !isOrgLoading && organization?.suspended && (
          <AuthContainer
            headerTitle={
              <Typography variant="h5">
                {t(organization.on_trial ? "organization_trial_ended" : "organization_suspended")}
              </Typography>
            }
            body={
              <>
                <Stack spacing={4}>
                  <Typography variant="body1">
                    {t(organization.on_trial ? "organization_trial_ended_message" : "organization_suspended_message")}
                  </Typography>
                  {CONTACT_URL && (
                    <Button
                      variant="outlined"
                      color="primary"
                      sx={{ mt: 2 }}
                      onClick={() => {
                        window.open(CONTACT_URL, "_blank");
                      }}>
                      <Typography variant="body1" fontWeight="bold" color="inherit">
                        {t("contact_us")}
                      </Typography>
                    </Button>
                  )}
                  <Button variant="text" color="error" onClick={() => signOut({ callbackUrl: "/" })}>
                    {t("logout")}
                  </Button>
                </Stack>
              </>
            }
          />
        )}
      </>
    </AuthLayout>
  );
}
