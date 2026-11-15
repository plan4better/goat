"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { LoadingButton } from "@mui/lab";
import { Box, Typography } from "@mui/material";
import { useCallback, useEffect, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { toast } from "react-toastify";

import { ICON_NAME } from "@p4b/ui/components/Icon";

import { statusOf } from "@/lib/api/apiError";
import { createCustomDomain, recheckCustomDomain } from "@/lib/api/customDomains";
import {
  type CustomDomain,
  type CustomDomainCreate,
  customDomainCreateSchema,
} from "@/lib/validations/customDomain";

import AppDialog, { AppDialogFooter } from "@/components/common/AppDialog";

import { StepCertIssuing } from "./StepCertIssuing";
import { StepConfigureDns } from "./StepConfigureDns";
import { StepEnter } from "./StepEnter";

type Step = "enter" | "configure_dns" | "cert_issuing";
const STEPS: Step[] = ["enter", "configure_dns", "cert_issuing"];
const STEP_LABELS = [
  "settings_domains_step_domain",
  "settings_domains_step_dns",
  "settings_domains_step_cert",
];
/** The `<form>` `StepEnter` renders, submitted by the footer's primary via
 * `primaryForm`: the button lives outside it, in the shared footer. */
const ENTER_FORM_ID = "add-domain-enter-form";
/** The reset waits for the closing fade, so step 1 does not flash. */
const RESET_AFTER_CLOSE_MS = 200;

/** Reading a domain never checks it (F13): while the DNS step is open the
 * dialog asks core to check it this often. */
export const RECHECK_EVERY_MS = 30_000;

/** "Domain hinzufügen" in three steps: the address, the DNS record (checked
 * every 30 seconds while the step is open, and on "Jetzt prüfen"), the
 * certificate. */
export function AddDomainDialog({
  open,
  onClose,
  organizationId,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  organizationId: string;
  /** Called after a create or a check, so the page reads its list again. */
  onCreated?: () => void;
}) {
  const { t } = useTranslation("common");
  const [step, setStep] = useState<Step>("enter");
  const [domain, setDomain] = useState<CustomDomain | null>(null);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  // Closed (Fertig, Schließen, the X) until the reset after the fade: no more
  // checks from then on, even while the caller still renders the dialog.
  const [closed, setClosed] = useState(false);
  // The field's error shows once it was left or a submit was tried, not on
  // the first keystroke (the settings forms' rule).
  const [tried, setTried] = useState(false);
  const checkingRef = useRef(false);
  const resetTimer = useRef<number | undefined>(undefined);
  const {
    register,
    handleSubmit,
    watch,
    setError,
    reset,
    formState: { errors, isValid, touchedFields },
  } = useForm<CustomDomainCreate>({
    mode: "onChange",
    resolver: zodResolver(customDomainCreateSchema),
    defaultValues: { base_domain: "" },
  });

  const check = useCallback(
    async (loud: boolean) => {
      // One check at a time: a tick during "Jetzt prüfen" waits for the next.
      if (!domain || checkingRef.current) return;
      checkingRef.current = true;
      setChecking(true);
      try {
        const next = await recheckCustomDomain(organizationId, domain.id);
        setDomain(next);
        onCreated?.();
        if (next.dns_status === "verified") setStep("cert_issuing");
      } catch {
        if (loud) toast.error(t("settings_domains_recheck_error"));
      } finally {
        checkingRef.current = false;
        setChecking(false);
      }
    },
    [domain, organizationId, onCreated, t]
  );

  // The interval reads the latest `check` through a ref: the page passes a new
  // `onCreated` on every render, which must not restart the 30-second clock.
  const checkRef = useRef(check);
  useEffect(() => {
    checkRef.current = check;
  }, [check]);
  const domainId = domain?.id;
  useEffect(() => {
    if (!open || closed || step !== "configure_dns" || !domainId) return;
    const timer = window.setInterval(() => void checkRef.current(false), RECHECK_EVERY_MS);
    return () => window.clearInterval(timer);
  }, [open, closed, step, domainId]);

  useEffect(() => () => window.clearTimeout(resetTimer.current), []);

  const close = () => {
    setClosed(true);
    onClose();
    window.clearTimeout(resetTimer.current);
    resetTimer.current = window.setTimeout(() => {
      setStep("enter");
      setDomain(null);
      setTried(false);
      reset();
      setClosed(false);
    }, RESET_AFTER_CLOSE_MS);
  };
  const submit = () => {
    setTried(true);
    void create();
  };

  const create = handleSubmit(async ({ base_domain }) => {
    setBusy(true);
    try {
      const created = await createCustomDomain(organizationId, base_domain);
      setDomain(created);
      onCreated?.();
      setStep(created.dns_status === "verified" ? "cert_issuing" : "configure_dns");
    } catch (error) {
      if (statusOf(error) === 409) setError("base_domain", { message: "settings_domains_name_taken" });
      else toast.error(t("settings_domains_create_error"));
    } finally {
      setBusy(false);
    }
  });

  const current = STEPS.indexOf(step);
  const title =
    step === "enter"
      ? t("settings_domains_add_title")
      : step === "configure_dns"
        ? t("settings_domains_dns_title")
        : t("settings_domains_cert_title");
  const footer =
    step === "enter" ? (
      <AppDialogFooter
        onCancel={close}
        cancelDisabled={busy}
        primaryLabel={t("settings_domains_next")}
        onPrimary={submit}
        primaryType="submit"
        primaryForm={ENTER_FORM_ID}
        primaryDisabled={!isValid}
        primaryLoading={busy}
      />
    ) : step === "configure_dns" ? (
      <AppDialogFooter
        primaryLabel={t("settings_domains_done")}
        onPrimary={close}
        extra={
          <LoadingButton variant="text" loading={checking} onClick={() => void check(true)}>
            <Typography variant="body2" fontWeight="bold">
              {t("settings_domains_check_now")}
            </Typography>
          </LoadingButton>
        }
      />
    ) : (
      <AppDialogFooter primaryLabel={t("close")} onPrimary={close} />
    );

  return (
    <AppDialog
      open={open}
      onClose={close}
      icon={ICON_NAME.LINK}
      title={title}
      subtitle={
        step === "configure_dns" && domain ? (
          <Box component="span" sx={{ fontFamily: "monospace", wordBreak: "break-all" }}>
            {domain.base_domain}
          </Box>
        ) : undefined
      }
      maxWidth={600}
      closeDisabled={busy}
      bodySx={{ pt: 2 }}
      footer={footer}>
      <Box
        component="ol"
        aria-label={t("settings_domains_steps_label")}
        sx={{ display: "flex", flexWrap: "wrap", gap: 4, listStyle: "none", p: 0, m: 0, mb: 4 }}>
        {STEPS.map((candidate, index) => {
          const done = index < current;
          const here = index === current;
          return (
            <Box
              component="li"
              key={candidate}
              aria-current={here ? "step" : undefined}
              sx={{
                display: "flex",
                alignItems: "center",
                gap: 1.5,
                fontSize: 13,
                fontWeight: here ? 700 : 500,
                color: here ? "primary.main" : done ? "text.primary" : "text.secondary",
              }}>
              <Box
                aria-hidden
                sx={{
                  width: 20,
                  height: 20,
                  borderRadius: "50%",
                  display: "grid",
                  placeItems: "center",
                  fontSize: 11,
                  fontWeight: 700,
                  border: 1,
                  borderColor: here ? "primary.main" : "divider",
                }}>
                {done ? "✓" : index + 1}
              </Box>
              {t(STEP_LABELS[index])}
            </Box>
          );
        })}
      </Box>
      {step === "enter" && (
        <StepEnter
          formId={ENTER_FORM_ID}
          register={register}
          errors={touchedFields.base_domain || tried ? errors : {}}
          value={watch("base_domain") ?? ""}
          onSubmit={submit}
          onAttempt={() => setTried(true)}
        />
      )}
      {step === "configure_dns" && domain && <StepConfigureDns domain={domain} />}
      {step === "cert_issuing" && <StepCertIssuing />}
    </AppDialog>
  );
}

export default AddDomainDialog;
