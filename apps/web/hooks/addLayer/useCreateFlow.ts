import { zodResolver } from "@hookform/resolvers/zod";
import { useCallback, useEffect, useMemo, useState } from "react";
import { type FieldErrors, type UseFormRegister, useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { toast } from "react-toastify";
import { v4 as uuidv4 } from "uuid";

import { createEmptyLayer } from "@/lib/api/layers";
import { useJobs } from "@/lib/api/processes";
import { addRunningJobIds } from "@/lib/store/jobs/slice";
import type { CreatableFieldKind, CreateEmptyLayerInput, FieldDefinition } from "@/lib/validations/layer";
import { createEmptyLayerSchema, isCreatableKind } from "@/lib/validations/layer";

import type { FlowController } from "@/hooks/addLayer/flow";
import { useShareNotice } from "@/hooks/addLayer/useShareNotice";
import { useAppDispatch } from "@/hooks/store/ContextHooks";

/**
 * Creating an empty layer: name, geometry, fields — no UI.
 *
 * One view rather than the two steps the dialog it replaces used: the field editor
 * is the substance, and a first screen holding only a name and four buttons was a
 * gate rather than a step.
 */

export type GeometryChoice = "point" | "line" | "polygon" | "table";

export type CreateFlowState = {
  register: UseFormRegister<CreateEmptyLayerInput>;
  errors: FieldErrors<CreateEmptyLayerInput>;
  /** `table` stands for "no geometry", which the payload sends as null. */
  geometry: GeometryChoice;
  setGeometry: (choice: GeometryChoice) => void;
  fields: FieldDefinition[];
  setFields: (fields: FieldDefinition[]) => void;
  selectedFieldId: string | null;
  setSelectedFieldId: (id: string | null) => void;
};

export type CreateFlow = FlowController & { create: CreateFlowState };

/** A new layer with no attributes at all is rarely what anyone wants. */
const seedField = (): FieldDefinition => ({
  id: uuidv4(),
  name: "name",
  kind: "string",
  is_computed: false,
  display_config: {},
});

export const useCreateFlow = ({
  projectId,
  onDone,
}: {
  projectId?: string;
  onDone?: () => void;
}): CreateFlow => {
  const { t } = useTranslation("common");
  const dispatch = useAppDispatch();
  const { mutate: mutateJobs } = useJobs({ read: false });
  const notice = useShareNotice(projectId);

  const [isBusy, setIsBusy] = useState(false);
  const [selectedFieldId, setSelectedFieldId] = useState<string | null>(null);

  const {
    register,
    getValues,
    setValue,
    watch,
    reset: resetForm,
    formState: { errors, isValid },
  } = useForm<CreateEmptyLayerInput>({
    mode: "onChange",
    resolver: zodResolver(createEmptyLayerSchema),
    defaultValues: { name: t("untitled_layer"), geometryType: "point", fields: [] },
  });

  const fields = watch("fields");
  const geometryType = watch("geometryType");
  const geometry: GeometryChoice = geometryType === null ? "table" : geometryType;

  // Seeded once, and only while untouched, so a field the user deleted stays deleted.
  useEffect(() => {
    if (fields.length > 0) return;
    const seeded = seedField();
    setValue("fields", [seeded], { shouldValidate: true });
    setSelectedFieldId(seeded.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setGeometry = useCallback(
    (choice: GeometryChoice) => {
      setValue("geometryType", choice === "table" ? null : choice, { shouldValidate: true });
    },
    [setValue]
  );

  const setFields = useCallback(
    (next: FieldDefinition[]) => setValue("fields", next, { shouldValidate: true }),
    [setValue]
  );

  const reset = useCallback(() => {
    setIsBusy(false);
    setSelectedFieldId(null);
    resetForm();
  }, [resetForm]);

  const submit = useCallback(async () => {
    if (!projectId) return;
    const data = getValues();
    try {
      setIsBusy(true);
      const response = await createEmptyLayer(
        {
          name: data.name,
          geometry_type: data.geometryType,
          // Every kind the editor offers here is creatable; the filter is a belt
          // against a caller seeding something computed.
          fields: data.fields
            .filter((field) => isCreatableKind(field.kind))
            .map((field) => ({
              name: field.name,
              kind: field.kind as CreatableFieldKind,
              // The vocabulary travels with the field: it is the one part of a
              // column the create dialog can ask for that storage type does not
              // carry, so dropping it here loses it silently.
              ...(field.allowed_values?.length
                ? { allowed_values: field.allowed_values, allow_other: !!field.allow_other }
                : {}),
              // Where a serial number starts counting; the server defaults to 1.
              ...(field.kind === "serial" && field.start !== undefined ? { start: field.start } : {}),
            })),
        },
        projectId
      );
      const jobId = response?.jobID;
      if (jobId) {
        mutateJobs();
        dispatch(addRunningJobIds([jobId]));
      }
      toast.info(t("creating_layer"));
      // Only a submitted layer clears the editor: after a failure the fields
      // stay so the user can retry, not rebuild fifteen columns.
      reset();
      onDone?.();
    } catch (error) {
      toast.error(t("error_creating_layer"));
      console.error("error", error);
      setIsBusy(false);
    }
  }, [projectId, getValues, mutateJobs, dispatch, t, reset, onDone]);

  const action = useMemo(
    () => ({
      label: t("create_layer"),
      disabled: !isValid || isBusy || !projectId,
      reason: projectId ? undefined : t("create_layer_needs_project"),
      notice,
      run: submit,
    }),
    [isValid, isBusy, projectId, submit, t, notice]
  );

  return {
    action,
    isBusy,
    reset,
    create: {
      register,
      errors,
      geometry,
      setGeometry,
      fields,
      setFields,
      selectedFieldId,
      setSelectedFieldId,
    },
  };
};
