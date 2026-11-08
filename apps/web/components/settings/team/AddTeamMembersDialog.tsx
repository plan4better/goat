"use client";

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "react-toastify";

import { ICON_NAME } from "@p4b/ui/components/Icon";

import { createTeamMember } from "@/lib/api/teams";

import AppDialog, { AppDialogFooter } from "@/components/common/AppDialog";
import PeoplePicker, { type Person } from "@/components/settings/common/PeoplePicker";

const PLAIN = { interpolation: { escapeValue: false } } as const;

/** "Mitglieder hinzufügen": people of the organization not in the team yet
 * (invitations cannot be added), one request each. Who was added is reported
 * and leaves the picker once the list reloads; who failed is named and stays
 * chosen, so a second click tries only them. */
export default function AddTeamMembersDialog({
  teamId,
  teamName,
  candidates,
  onClose,
  onChanged,
}: {
  teamId: string;
  teamName: string;
  candidates: Person[];
  onClose: () => void;
  /** Reads the team's members again. */
  onChanged: () => Promise<unknown>;
}) {
  const { t } = useTranslation("common");
  const [selected, setSelected] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  // Only who is still offered counts as chosen: after the reload, someone who
  // failed because they are in the team by now drops out of the choice.
  const chosen = selected.filter((id) => candidates.some((candidate) => candidate.id === id));

  const add = async () => {
    setBusy(true);
    const added: Person[] = [];
    const failed: Person[] = [];
    try {
      for (const id of chosen) {
        const person = candidates.find((candidate) => candidate.id === id);
        if (!person) continue;
        try {
          await createTeamMember(teamId, id);
          added.push(person);
        } catch {
          failed.push(person);
        }
      }
      // A failed reload must not hide what was sent: the outcome is reported either way.
      await onChanged().catch(() => undefined);
    } finally {
      setBusy(false);
    }
    if (added.length === 1) toast.success(t("settings_team_added_one", { name: added[0].name, ...PLAIN }));
    else if (added.length > 1) toast.success(t("settings_team_added_many", { n: added.length }));
    if (failed.length === 0) {
      onClose();
      return;
    }
    toast.error(
      t("settings_team_add_failed", { names: failed.map((person) => person.name).join(", "), ...PLAIN })
    );
    setSelected(failed.map((person) => person.id));
  };

  return (
    <AppDialog
      open
      onClose={onClose}
      icon={ICON_NAME.ADD_USER}
      title={t("settings_team_add_title")}
      subtitle={t("settings_team_add_subtitle", { team: teamName, ...PLAIN })}
      maxWidth={560}
      closeDisabled={busy}
      footer={
        <AppDialogFooter
          onCancel={onClose}
          cancelDisabled={busy}
          primaryLabel={
            chosen.length > 1
              ? t("settings_team_add_confirm_n", { n: chosen.length })
              : t("settings_team_add_confirm")
          }
          primaryDisabled={chosen.length === 0}
          primaryLoading={busy}
          onPrimary={() => void add()}
        />
      }>
      <PeoplePicker
        people={candidates}
        selected={chosen}
        onToggle={(id) =>
          setSelected((current) =>
            current.includes(id) ? current.filter((other) => other !== id) : [...current, id]
          )
        }
        query={query}
        onQuery={setQuery}
      />
    </AppDialog>
  );
}
