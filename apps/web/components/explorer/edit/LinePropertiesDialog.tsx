/**
 * A line's properties, edited, from its action bar or menu (decided 26 Nov
 * 2026: panels show, dialogs edit). Its own fields as a form; each change is the draft the Apply
 * bar applies, so Preview hands it there, as the service dialog does.
 * Delete line, in red at the left of the footer, goes to the Apply bar's
 * delete card instead. Cancel lets go of what was typed.
 */
import { Button, Typography } from "@mui/material";
import { useTranslation } from "react-i18next";

import { ICON_NAME } from "@p4b/ui/components/Icon";

import { routeFieldProblems } from "@/lib/explorer/edit/ops/routes";
import { setEditDialog, setEditDraft } from "@/lib/store/explorer/slice";

import { useAppDispatch, useAppSelector } from "@/hooks/store/ContextHooks";

import AppDialog, { AppDialogFooter } from "@/components/common/AppDialog";
import { RouteDetails } from "@/components/explorer/edit/RouteDetails";

export function LinePropertiesDialog() {
  const dialog = useAppSelector((s) => s.explorer.edit.dialog);
  return dialog?.kind === "line" ? <Dialog route_idx={dialog.route_idx} /> : null;
}

function Dialog({ route_idx }: { route_idx: number }) {
  const { t } = useTranslation("common");
  const dispatch = useAppDispatch();
  const draft = useAppSelector((s) => s.explorer.edit.draft);
  const mine = draft?.kind === "route-details" && draft.route_idx === route_idx ? draft : null;
  const ok = !!mine && Object.keys(routeFieldProblems(mine.values)).length === 0;
  const close = () => dispatch(setEditDialog(null));
  const cancel = () => {
    if (mine) dispatch(setEditDraft(null));
    close();
  };
  return (
    <AppDialog
      open
      onClose={cancel}
      icon={ICON_NAME.SLIDERS}
      title={t("explorer_action_properties")}
      maxWidth={520}
      footer={
        <AppDialogFooter
          extra={
            <Button
              color="error"
              onClick={() => {
                dispatch(setEditDraft({ kind: "line-delete", route_idx, stops: false }));
                close();
              }}>
              <Typography variant="body2" fontWeight="bold" color="inherit">
                {t("explorer_delete_line")}
              </Typography>
            </Button>
          }
          cancelLabel={t("cancel")}
          onCancel={cancel}
          primaryLabel={t("explorer_preview")}
          primaryDisabled={!ok}
          onPrimary={close}
        />
      }>
      <RouteDetails route_idx={route_idx} />
    </AppDialog>
  );
}
