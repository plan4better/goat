/**
 * Generic Bundle Input Component
 *
 * Renders a bundle selector based on an OGC process input schema
 * (x-ui.widget === "bundle-selector"). Lists the bundles in the current
 * project, optionally restricted to those with a ready artifact of a given kind
 * (widget_options.artifact_kind, e.g. "pt_network_graph"). The selected
 * bundle's UUID is stored directly as the field value.
 *
 * Restricted to the project, not to everything the user can access: a tool's
 * result is a layer in this project, and routing it on a network the project
 * does not contain gives an answer nobody can see the inputs for. Adding the
 * bundle to the project is what makes it available.
 */
import { useParams } from "next/navigation";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { ICON_NAME } from "@p4b/ui/components/Icon";

import { useBundles } from "@/lib/api/bundles";
import { useProjectLayerGroups } from "@/lib/api/projects";

import type { SelectorItem } from "@/types/map/common";
import type { ProcessedInput } from "@/types/map/ogc-processes";

import Selector from "@/components/map/panels/common/Selector";

/**
 * The selector's value for "no bundle of my own — use the network GOAT ships".
 *
 * An option rather than the initial state, exactly as the GTFS upload asks the
 * same question: the section only appears where the project holds a network, so
 * which one to route on is a decision worth making rather than inheriting. It is
 * not a bundle id and is never sent — `GenericTool` drops it from the payload,
 * and the tool falls back to the default network on its own.
 */
export const DEFAULT_NETWORK_BUNDLE = "default";

interface BundleInputProps {
  input: ProcessedInput;
  value: string | undefined;
  onChange: (value: string | undefined) => void;
  disabled?: boolean;
}

export default function BundleInput({ input, value, onChange, disabled }: BundleInputProps) {
  const { t } = useTranslation("common");

  const opts = input.uiMeta?.widget_options ?? {};
  const { data: bundles } = useBundles({
    bundleType: opts.bundle_type as string | undefined,
    artifactKind: opts.artifact_kind as string | undefined,
  });

  // A bundle is in the project when one of its layer groups is backed by it —
  // and that group is also what it is called here. The group starts out named
  // after the bundle but can be renamed in the tree, so listing the bundle's
  // own name would show one thing in the tree and another in this dropdown.
  const { layerGroups } = useProjectLayerGroups(useParams().projectId as string);
  const groupNameByBundle = useMemo(
    () =>
      new Map(
        (layerGroups ?? [])
          .filter((group) => !!group.bundle_id)
          .map((group) => [group.bundle_id as string, group.name])
      ),
    [layerGroups]
  );

  const bundleItems: SelectorItem[] = useMemo(
    () => [
      // The network GOAT ships leads the list, as the answer most runs want —
      // but it is not preselected: picking it is still a choice someone makes.
      {
        value: DEFAULT_NETWORK_BUNDLE,
        // Two keys because the two shipped networks are not labelled alike:
        // the street network names the area it covers, the timetable does not.
        label: t(opts.bundle_type === "pt_network_gtfs" ? "default_pt_network" : "default_network"),
        // The same glyph as the bundles below it: the row stands in the same
        // list for the same decision.
        icon: ICON_NAME.CUBE,
      },
      ...(bundles ?? [])
        .filter((bundle) => groupNameByBundle.has(bundle.id))
        .map((bundle) => ({
          value: bundle.id,
          // The bundle's own name as a fallback: a group with no name of its
          // own would otherwise render as an unlabelled row.
          label: groupNameByBundle.get(bundle.id) || bundle.name,
          icon: ICON_NAME.CUBE,
        })),
    ],
    [bundles, groupNameByBundle, opts.bundle_type, t]
  );

  const selectedItem = useMemo(
    () => (value ? bundleItems.find((item) => item.value === value) : undefined),
    [value, bundleItems]
  );

  const handleChange = (item: SelectorItem | SelectorItem[] | undefined) => {
    const selected = Array.isArray(item) ? item[0] : item;
    onChange(selected?.value as string | undefined);
  };

  const label = input.uiMeta?.label || input.title;
  const tooltip = input.uiMeta?.description || input.description || "";

  return (
    <Selector
      selectedItems={selectedItem}
      setSelectedItems={handleChange}
      items={bundleItems}
      label={label}
      tooltip={tooltip}
      placeholder={t("select_bundle")}
      emptyMessage={t("no_bundles_found")}
      emptyMessageIcon={ICON_NAME.CUBE}
      disabled={disabled}
    />
  );
}
