"use client";

// "Reset to the dataset's style" in a part's popover header: puts the part back as the dataset's default style has it
// (useDatasetReference), its classifications included (resetParts), removing what the dataset's style has not, as one
// edit the panel's undo takes back. It shows only while the part differs from the dataset's, what the server computed
// aside, and once the dataset's style has loaded; not in class or rule scope, where the popover edits a class's or a
// rule's own values.
import { IconButton, Tooltip } from "@mui/material";
import { useTranslation } from "react-i18next";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import { resetParts } from "@/lib/style/editor/reset";
import type { Path } from "@/lib/style/editor/store";
import { sameAsWritten } from "@/lib/style/json";

import {
  useEditor,
  useScope,
  useStyleData,
  useStyleSelector,
} from "@/components/map/panels/styleEditor/context";
import { useDatasetReference } from "@/components/map/panels/styleEditor/datasetDefault";

export function ResetToDataset({ paths }: { paths: Path[] }) {
  const { t } = useTranslation("common");
  const store = useEditor();
  const scope = useScope();
  const { layerId, geometry } = useStyleData();
  const reference = useDatasetReference(layerId, geometry, store.document.kind);
  const differs = useStyleSelector(
    (doc) => !!reference && !sameAsWritten(doc, resetParts(doc, reference, paths, geometry))
  );
  if (!reference || scope || !differs) return null;
  const label = t("style_editor.reset_to_dataset");
  return (
    <Tooltip title={label}>
      {/* The header's buttons (the part's delete): their size, the header keeps its height. */}
      <IconButton
        aria-label={label}
        sx={{ my: -1 }}
        onClick={() => store.update((doc) => resetParts(doc, reference, paths, geometry))}>
        <Icon iconName={ICON_NAME.REFRESH} sx={{ fontSize: 16 }} />
      </IconButton>
    </Tooltip>
  );
}
