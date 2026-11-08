"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { type BaseSyntheticEvent, useCallback, useEffect, useRef, useState } from "react";
import {
  type DefaultValues,
  type FieldValues,
  type Path,
  type UseFormReturn,
  useForm,
} from "react-hook-form";
import { useTranslation } from "react-i18next";
import type { ZodType, ZodTypeDef } from "zod";

export interface CardForm<V extends FieldValues> {
  form: UseFormReturn<V>;
  dirty: boolean;
  valid: boolean;
  saving: boolean;
  /** A field's error, translated, once it was touched or changed or a save was tried. */
  errorOf: (name: Path<V>) => string | undefined;
  /** Puts the saved values back. */
  discard: () => void;
  /** Validates and saves: the `onSubmit` of the card's form. */
  submit: (event?: BaseSyntheticEvent) => Promise<void>;
}

/**
 * The save rule of a card with text fields (decision 15): the card holds a
 * draft of `values`; Speichern validates it and calls `save`, which says
 * whether it saved (true: the draft becomes the saved values; false: the draft
 * stays, the caller has said why). Closing or reloading the tab with a draft
 * asks first. The messages of `schema` are i18n keys.
 *
 * `values` must be referentially stable (`useMemo` over the loaded record):
 * each new object counts as new saved values and refills a clean form. Values
 * reloaded during `save` (an `await mutate()`) replace the sent draft once the
 * save returns true. `save` catches and reports its own errors: a throw is
 * swallowed and keeps the draft without a word to the user.
 */
export function useCardForm<V extends FieldValues>(
  schema: ZodType<V, ZodTypeDef, V>,
  values: V | undefined,
  save: (next: V) => Promise<boolean>
): CardForm<V> {
  const { t } = useTranslation("common");
  const form = useForm<V>({
    mode: "onChange",
    resolver: zodResolver(schema),
    defaultValues: values as DefaultValues<V> | undefined,
  });
  const { formState, reset, getFieldState, handleSubmit } = form;
  const [saving, setSaving] = useState(false);
  const [tried, setTried] = useState(false);
  const dirty = formState.isDirty;

  // Saved values fill the form once it is clean: when they arrive, when they
  // change while nothing is typed, and when a save that reloaded them while
  // the form was still dirty has reset it. A draft is never overwritten.
  const applied = useRef(values);
  useEffect(() => {
    if (!values || dirty || values === applied.current) return;
    applied.current = values;
    reset(values);
  }, [values, dirty, reset]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const submit = useCallback(
    async (event?: BaseSyntheticEvent) => {
      setTried(true);
      await handleSubmit(async (next) => {
        setSaving(true);
        let saved = false;
        try {
          saved = await save(next);
        } catch {
          saved = false;
        } finally {
          setSaving(false);
        }
        if (saved) {
          reset(next);
          setTried(false);
        }
      })(event);
    },
    [handleSubmit, reset, save]
  );

  const errorOf = (name: Path<V>): string | undefined => {
    const state = getFieldState(name, formState);
    const message = state.error?.message;
    if (!message || !(state.isTouched || state.isDirty || tried)) return undefined;
    return t(message);
  };

  return {
    form,
    dirty,
    valid: formState.isValid,
    saving,
    errorOf,
    discard: () => {
      if (values) reset(values);
      setTried(false);
    },
    submit,
  };
}
