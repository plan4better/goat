"use client";

import { Box, Checkbox, List, ListItem, ListItemText, Stack, Typography } from "@mui/material";
import { useId } from "react";
import { useTranslation } from "react-i18next";

import UserAvatar from "@/components/dashboard/common/UserAvatar";
import { DialogSearchField } from "@/components/modals/content/ContentDialogChrome";

export interface Person {
  id: string;
  /** Already the display name (`personName`): the address when there is no name. */
  name: string;
  email: string;
  avatar?: string | null;
  /** The organization role's word. */
  roleWord?: string;
}

/** The body of "Mitglieder hinzufügen": a search by name or address, how many
 * are chosen, and a checkbox row per person who is not in the team. */
export default function PeoplePicker({
  people,
  selected,
  onToggle,
  query,
  onQuery,
}: {
  people: Person[];
  selected: string[];
  onToggle: (id: string) => void;
  query: string;
  onQuery: (query: string) => void;
}) {
  const { t } = useTranslation("common");
  const uid = useId();
  const needle = query.trim().toLowerCase();
  const shown = needle
    ? people.filter(
        (person) => person.name.toLowerCase().includes(needle) || person.email.toLowerCase().includes(needle)
      )
    : people;

  return (
    <Stack spacing={3}>
      {/* The share dialog's search for people (`SharePeopleTab.tsx`). */}
      <DialogSearchField
        value={query}
        onChange={onQuery}
        placeholder={t("settings_team_add_search")}
        clearLabel={t("clear")}
      />
      {/* Nobody left to add: the line below says so, not "0 Personen" as well. */}
      {people.length > 0 && (
        <Typography role="status" variant="body2" color="text.secondary">
          {selected.length > 0
            ? t("settings_team_add_selected", { k: selected.length, n: people.length })
            : t("settings_team_add_outside", { count: people.length })}
        </Typography>
      )}
      {people.length === 0 ? (
        <Typography variant="body2">{t("settings_team_add_all_in")}</Typography>
      ) : shown.length === 0 ? (
        <Typography variant="body2">{t("settings_team_add_no_match")}</Typography>
      ) : (
        <List disablePadding sx={{ maxHeight: 360, overflowY: "auto" }}>
          {shown.map((person) => {
            const detail = [person.email !== person.name ? person.email : null, person.roleWord]
              .filter(Boolean)
              .join(" · ");
            const detailId = `${uid}-${person.id}`;
            return (
              <ListItem key={person.id} disablePadding>
                {/* The row is the checkbox's label: a click anywhere on it
                    ticks the box, and the box itself takes the focus, so its
                    state is read out. */}
                <Box
                  component="label"
                  sx={{
                    display: "flex",
                    alignItems: "center",
                    gap: 2,
                    width: "100%",
                    minWidth: 0,
                    px: 2,
                    py: 1,
                    borderRadius: "8px",
                    cursor: "pointer",
                    "&:hover": { backgroundColor: "action.hover" },
                  }}>
                  <Checkbox
                    checked={selected.includes(person.id)}
                    onChange={() => onToggle(person.id)}
                    inputProps={{
                      "aria-label": person.name,
                      "aria-describedby": detail ? detailId : undefined,
                    }}
                  />
                  <UserAvatar id={person.id} name={person.name} src={person.avatar} size={32} />
                  <ListItemText
                    primary={person.name}
                    secondary={detail || undefined}
                    primaryTypographyProps={{ variant: "body2", fontWeight: 700, noWrap: true }}
                    secondaryTypographyProps={{ variant: "caption", noWrap: true, id: detailId }}
                    sx={{ minWidth: 0 }}
                  />
                </Box>
              </ListItem>
            );
          })}
        </List>
      )}
    </Stack>
  );
}
