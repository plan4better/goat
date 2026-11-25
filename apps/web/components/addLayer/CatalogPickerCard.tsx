"use client";

import { memo, useCallback, useEffect, useMemo, useState } from "react";

import { useCatalogCollectionItems } from "@/lib/api/catalog";
import { datasetCard } from "@/lib/catalog/card";
import { catalogBundleType } from "@/lib/catalog/kind";
import { cardSelectionState } from "@/lib/catalog/selection";
import type { CatalogCollection } from "@/lib/validations/catalog";

import type { CatalogSelection } from "@/hooks/addLayer/useCatalogFlow";

import CatalogCard from "@/components/dashboard/catalog/CatalogCard";

/**
 * One catalog result, as something to pick rather than to open.
 *
 * The card itself is the catalog page's, so a dataset looks the same wherever it is
 * met; this adds only what picking needs — which layer ids the card stands for, and
 * the tri-state that summarises them.
 *
 * A bundle's layers are fetched only once this card needs them — when it is opened or
 * its checkbox is used. Fetching for every bundle on screen was a request per card
 * and an extra subscription per card, for a checkbox that starts out empty anyway.
 * SWR shares the request with the member list underneath, so opening costs nothing
 * extra once armed.
 */
const CatalogPickerCard = ({
  collection,
  selection,
  starred,
  onToggleStar,
}: {
  collection: CatalogCollection;
  selection: CatalogSelection;
  starred: boolean;
  /**
   * Takes the id rather than closing over it, so the list can hand every card the
   * same function. An arrow built per card is a new prop on every render, which is
   * enough on its own to re-render all of them each time a page is appended.
   */
  onToggleStar: (id: string) => void;
}) => {
  const card = useMemo(() => datasetCard(collection), [collection]);
  // A typed bundle (not generic) is picked whole, by its own id, like a
  // one-layer dataset: core adds it as one shared bundle and refuses its layers.
  const isBundle = card.memberCount > 1 && !!card.bundleId && !catalogBundleType(collection);

  /** Set once this card is opened or picked; until then its layers are nobody's business. */
  const [armed, setArmed] = useState(false);
  /** A checkbox used before the layers arrived: applied as soon as they do. */
  const [pendingSelectAll, setPendingSelectAll] = useState(false);

  // Only bundles need their members enumerated; a single-layer dataset already
  // knows the one id it stands for.
  const { items } = useCatalogCollectionItems(isBundle && armed ? card.bundleId : undefined, {
    limit: 50,
  });

  /**
   * The ids this card stands for. A bundle enumerates its members, so its layers
   * can be ticked one by one; a single-layer dataset stands for its own Collection
   * id, which core resolves to the layer inside it — asking for that id here would
   * be a request per card for something the add already knows how to look up.
   */
  const memberIds = useMemo(() => {
    if (isBundle) return items.map((item) => item.id);
    // The id itself, not parsed back out of the card's percent-encoded href —
    // the POST encodes it again, and an id with a reserved character would go
    // over double-encoded and 404.
    return [collection.id];
  }, [isBundle, items, collection.id]);

  const state = cardSelectionState(memberIds, selection.ids);
  const toggleStar = useCallback(() => onToggleStar(collection.id), [onToggleStar, collection.id]);

  const toggle = useCallback(() => {
    if (isBundle && (!armed || items.length === 0)) {
      // Nothing to select yet — not armed, or armed by expanding and the
      // members still loading: arm the fetch and remember what the click meant,
      // rather than calling setMany([]) and losing the click.
      setArmed(true);
      setPendingSelectAll(true);
      return;
    }
    selection.setMany(memberIds, state.nextSelected);
  }, [isBundle, armed, items.length, selection, memberIds, state.nextSelected]);

  useEffect(() => {
    if (!pendingSelectAll || !items.length) return;
    selection.setMany(
      items.map((item) => item.id),
      true
    );
    setPendingSelectAll(false);
  }, [pendingSelectAll, items, selection]);

  return (
    <CatalogCard
      card={card}
      // Tiles: a picker is scanned, not read. The card's own grid layout.
      view="grid"
      starred={starred}
      onToggleStar={toggleStar}
      // Opening it is also a reason to know its layers: the checkbox above then
      // summarises what is ticked inside.
      onExpandedChange={(open) => open && setArmed(true)}
      selection={{
        selected: state.selected,
        indeterminate: state.indeterminate,
        onToggle: toggle,
        ...(isBundle && {
          isMemberSelected: (memberId: string) => selection.ids.includes(memberId),
          onToggleMember: (memberId: string) => selection.toggle(memberId),
        }),
      }}
    />
  );
};

export default memo(CatalogPickerCard);
