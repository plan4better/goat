"use client";

// Issues in the panel: rows read theirs with useIssueAt (a dot and the message), an editor shows an issue with its
// fix button, and issues about data that changed under a stored style show one notice at the top.
import { Alert, Box, Button, Typography } from "@mui/material";
import { type ReactNode, createContext, useContext, useMemo } from "react";
import { useTranslation } from "react-i18next";

import { applyFix, issueTarget } from "@/lib/style/editor/issues";
import type { Path } from "@/lib/style/editor/store";
import type { StyleIssue } from "@/lib/style/save";

import { useEditor } from "@/components/map/panels/styleEditor/context";

const IssuesContext = createContext<{ byPath: Map<Path, StyleIssue[]>; all: StyleIssue[] }>({
  byPath: new Map(),
  all: [],
});

/** Maps the issues of the last save to rows; it renders again only when a save brings new issues. */
export function IssuesProvider({ issues, children }: { issues: StyleIssue[]; children: ReactNode }) {
  const store = useEditor();
  const value = useMemo(() => {
    const byPath = new Map<Path, StyleIssue[]>();
    for (const issue of issues) {
      const target = issueTarget(store.document, issue.path);
      if (target) byPath.set(target.path, [...(byPath.get(target.path) ?? []), issue]);
    }
    return { byPath, all: issues };
  }, [issues, store]);
  return <IssuesContext.Provider value={value}>{children}</IssuesContext.Provider>;
}

/** The issues of a row's path, or of several (and of anything under them). */
export function useIssueAt(path: Path | Path[]): StyleIssue[] {
  const { byPath } = useContext(IssuesContext);
  const key = Array.isArray(path) ? path.join("|") : path;
  return useMemo(() => {
    const paths = key.split("|");
    return [...byPath.entries()]
      .filter(([p]) => paths.some((at) => p === at || p.startsWith(`${at}.`)))
      .flatMap(([, list]) => list);
  }, [byPath, key]);
}

export function useIssues(): StyleIssue[] {
  return useContext(IssuesContext).all;
}

const SEVERITY = { error: "error", warning: "warning", info: "info", damaged: "warning" } as const;

/** One issue with its message and, when the issue carries one, its fix. */
export function IssueNotice({ issue }: { issue: StyleIssue }) {
  const { t } = useTranslation("common");
  const store = useEditor();
  const fix = issue.fix;
  const label = fix
    ? t(`style_editor.fix_${fix.op}`, {
        value: String(fix.value ?? ""),
        target: fix.target ?? "",
        field: fix.field ?? "",
      })
    : undefined;
  return (
    <Alert
      severity={SEVERITY[issue.level]}
      sx={{ py: 0, px: 2, "& .MuiAlert-message": { fontSize: "0.75rem" } }}
      action={
        fix && (
          <Button size="small" color="inherit" onClick={() => store.update((doc) => applyFix(doc, fix))}>
            {label}
          </Button>
        )
      }>
      {issue.message}
    </Alert>
  );
}

/** Issues the server marks damaged (a data change broke part of a stored style): the map draws the rest. */
export function DamagedNotice() {
  const { t } = useTranslation("common");
  const damaged = useIssues().filter((issue) => issue.level === "damaged");
  if (!damaged.length) return null;
  return (
    <Alert severity="warning" sx={{ mx: 2, my: 1 }}>
      <Typography variant="body2">{t("style_editor.damaged_notice")}</Typography>
      <Box component="ul" sx={{ m: 0, pl: 4 }}>
        {damaged.map((issue, i) => (
          <Typography component="li" variant="caption" key={`${issue.path}-${i}`}>
            {issue.message}
          </Typography>
        ))}
      </Box>
    </Alert>
  );
}
