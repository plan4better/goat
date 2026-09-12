"""Split Overture transportation segments into routable pieces.

Overture keeps segment geometry stable and scopes attributes to sub-ranges
instead of cutting: connectors sit at ``at`` positions that may be interior, and
properties like ``speed_limits`` carry ``between: [a, b]``. A routing edge needs
one value per attribute and a node at each end, so the network has to be cut at
every connector position and every attribute-change boundary.

Behaviour follows Overture's reference implementation
(``OvertureMaps/transportation-splitter``) so that output is comparable:

* split points come from a *recursive* scan for ``between`` at any nesting depth,
  not a fixed field list — a property Overture adds later is picked up for free;
* scoped values are filtered by **overlap length in metres**, and a surviving
  ``between`` is rewritten relative to the piece rather than dropped outright;
* output ids are ``{id}@{start_lr}-{end_lr}``, which is what makes them unique;
* split coordinates are rounded to 7 decimals (~1 cm) so ids and geometry are
  stable across runs;
* ``prohibited_transitions`` and ``destinations`` reference *other* features, so
  they are filtered by endpoint connector rather than by linear reference.

Two deliberate divergences, both because the output feeds a routing graph:

* ``split_at_connectors`` defaults to **True** (the reference defaults to False).
  An interior connector is a junction; not splitting there loses it from the
  graph.
* a segment whose every candidate piece is a sliver still yields one piece,
  rather than vanishing and disconnecting the network.

See README.md for the contract this sits inside.
"""

import logging
from dataclasses import dataclass, field
from typing import (
    Any,
    Dict,
    Iterable,
    Iterator,
    List,
    Optional,
    Self,
    Sequence,
    Set,
    Tuple,
)

from goatlib.bundles.importers.street_network.overture import linear_ref

logger = logging.getLogger(__name__)

Coord = Tuple[float, float]

# The key Overture uses for geometric scoping.
LR_SCOPE_KEY = "between"

# Properties whose values reference other segments/connectors. Splitting
# invalidates those references, so they are filtered by which connectors a piece
# ends at instead of by linear reference.
REFERENCE_COLUMNS = ("prohibited_transitions", "destinations")


@dataclass
class SplitConfig:
    """Knobs mirroring the reference splitter's ``SplitConfig``."""

    # Split at every connector, including interior ones. The reference defaults
    # this off; a routing graph needs it on or interior junctions are lost.
    split_at_connectors: bool = True

    # Decimal places for split-point coordinates. 7 is ~1 cm and is the
    # reference default; it also makes synthetic ids stable.
    point_precision: int = 7

    # How far a linear-reference split point must be from an existing split
    # before it earns its own connector rather than snapping to that one.
    lr_split_point_min_dist_meters: float = 0.01

    # A scoped value overlapping a piece by less than this does not apply to it.
    min_overlapping_length_meters: float = 0.01

    # Pieces shorter than this are dropped rather than emitted as slivers.
    min_piece_length_meters: float = 0.01

    # Fields whose `between` ranges must NOT force a split. `sources` records
    # which upstream dataset contributed each stretch — a provenance boundary,
    # not an attribute change, and honouring it produced 2% more edges on
    # Augsburg for no routing benefit. Mirrors the reference splitter's
    # `lr_columns_to_exclude`.
    lr_columns_to_exclude: Tuple[str, ...] = ("sources",)


DEFAULT_CONFIG = SplitConfig()


@dataclass
class SplitStats:
    """What a split run did, for logging and the import summary."""

    segments_in: int = 0
    segments_out: int = 0
    nodes_in: int = 0
    nodes_out: int = 0
    # Nodes the uploaded connectors file didn't contain: attribute boundaries with
    # no connector, plus connectors referenced from outside the extract's bbox.
    nodes_reconstructed: int = 0
    # Connectors in the upload that no output edge references.
    nodes_unreferenced: int = 0
    slivers_dropped: int = 0
    segments_skipped: List[str] = field(default_factory=list)


@dataclass
class SplitResult:
    segments: List[Dict[str, Any]]
    connectors: List[Dict[str, Any]]
    stats: SplitStats


class SplitStream:
    """The split pieces, yielded as they are made.

    The whole point is that nothing holds them: a city extract splits 359k
    segments into ~893k pieces, and keeping those, the flattened copy of them
    and the writer's copy alive at once is where a street-network import spent
    most of its memory.

    ``connectors`` and ``stats`` are only complete once the iterator is
    exhausted — which nodes a piece references is not known until the piece
    exists, and the node layer is exactly the referenced ones. Iterate once,
    then read them.
    """

    def __init__(
        self: Self,
        segments: Iterable[Dict[str, Any]],
        connectors: Iterable[Dict[str, Any]],
        *,
        config: SplitConfig = DEFAULT_CONFIG,
    ) -> None:
        self._segments = segments
        self._connectors = connectors
        self._config = config
        self.stats = SplitStats(segments_in=0, nodes_in=0)
        self._synthetic: Dict[str, Dict[str, Any]] = {}
        self._referenced: Set[str] = set()
        self._split = False

    def __iter__(self: Self) -> Iterator[Dict[str, Any]]:
        config = self._config
        stats = self.stats
        # First pass over the connectors: their ids are all the split needs to
        # know a boundary already has a node. Ids rather than records, because
        # the records are what cost the memory.
        known_ids: Set[str] = set()
        for connector in self._connectors:
            known_ids.add(connector["id"])
            stats.nodes_in += 1
        synthetic = self._synthetic
        # Which nodes the edges actually use, accumulated as the pieces go by:
        # the alternative is re-reading every piece afterwards, which is the
        # list this class exists to avoid.
        referenced = self._referenced
        segments_out = 0

        for segment in self._segments:
            stats.segments_in += 1
            coords = segment.get("coordinates") or []
            if len(coords) < 2:
                # A one-point "line" has no length to reference positions against.
                stats.segments_skipped.append(str(segment.get("id")))
                continue

            segment_length_m = linear_ref.total_length(coords)
            if segment_length_m <= 0.0:
                stats.segments_skipped.append(str(segment.get("id")))
                continue

            positions = _split_positions(segment, segment_length_m, config)
            pieces, dropped = _split_segment(
                segment, coords, positions, segment_length_m, config
            )
            stats.slivers_dropped += dropped

            for piece in pieces:
                _assign_endpoint_connectors(
                    piece,
                    segment,
                    known_ids=known_ids,
                    synthetic=synthetic,
                    segment_length_m=segment_length_m,
                    config=config,
                )
                _apply_reference_columns(piece, segment)
                for endpoint in piece.get("connectors") or []:
                    referenced.add(endpoint["connector_id"])
                segments_out += 1
                yield piece

        # Every referenced id is either one the file held or one just minted, so
        # the node count is known without materialising the nodes themselves.
        stats.segments_out = segments_out
        stats.nodes_out = len(referenced)
        stats.nodes_reconstructed = len(synthetic)
        stats.nodes_unreferenced = stats.nodes_in + len(synthetic) - len(referenced)
        self._split = True
        if stats.segments_skipped:
            logger.warning(
                "Skipped %d unusable segment(s): %s",
                len(stats.segments_skipped),
                ", ".join(stats.segments_skipped[:5]),
            )
        logger.info(
            "Split %d segment(s) into %d piece(s); %d node(s) "
            "(%d reconstructed, %d unreferenced dropped), %d sliver(s) dropped",
            stats.segments_in,
            stats.segments_out,
            stats.nodes_out,
            stats.nodes_reconstructed,
            stats.nodes_unreferenced,
            stats.slivers_dropped,
        )

    def nodes(self: Self) -> Iterator[Dict[str, Any]]:
        """The node layer's rows: exactly the connectors the edges reference.

        A second pass over the connectors file. An extract covers whatever bbox
        it was clipped to, so it holds connectors belonging to segments we do
        not have (other subtypes, roads just outside); emitting those would
        scatter isolated points across the nodes layer.

        Only valid once the pieces have been iterated — which nodes are
        referenced is decided by the pieces, and asking earlier would quietly
        emit a subset.
        """
        if not self._split:
            raise RuntimeError(
                "nodes() needs the split pieces first: iterate the stream, then "
                "ask for the nodes they reference"
            )
        for connector in self._connectors:
            if connector["id"] in self._referenced:
                yield connector
        for connector in self._synthetic.values():
            if connector["id"] in self._referenced:
                yield connector


def split_network(
    segments: Iterable[Dict[str, Any]],
    connectors: Sequence[Dict[str, Any]],
    *,
    config: SplitConfig = DEFAULT_CONFIG,
) -> SplitResult:
    """Split every segment, minting connectors for boundaries that lack one.

    ``segments`` and ``connectors`` are Overture records as plain dicts, with
    geometry already decoded to a coordinate list under ``coordinates``
    (segments) or ``coordinate`` (connectors).

    Every piece at once. `SplitStream` is the same work without holding them,
    which is what an import of any size should use.
    """
    stream = SplitStream(segments, connectors, config=config)
    out_segments = list(stream)
    return SplitResult(
        segments=out_segments, connectors=list(stream.nodes()), stats=stream.stats
    )


# --- split points ---------------------------------------------------------


def collect_linear_references(
    value: Any, found: Optional[Set[float]] = None
) -> Set[float]:
    """Every ``between`` boundary anywhere in a record, plus the two endpoints.

    Recursive rather than driven by a field list, matching the reference's
    ``get_lrs``: Overture can introduce a scoped property at any depth, and a
    missed boundary silently produces an edge with two conflicting values.
    """
    if found is None:
        found = {0.0, 1.0}
    if value is None:
        return found

    if isinstance(value, list):
        for item in value:
            collect_linear_references(item, found)
    elif isinstance(value, dict):
        scope = value.get(LR_SCOPE_KEY)
        if scope:
            for boundary in scope:
                if boundary is not None:
                    found.add(float(boundary))
        for key, item in value.items():
            if key != LR_SCOPE_KEY and item is not None:
                collect_linear_references(item, found)
    return found


def _split_positions(
    segment: Dict[str, Any], segment_length_m: float, config: SplitConfig
) -> List[float]:
    """Ordered split positions: connectors (optionally) plus LR boundaries.

    Connector positions are seeded first so that an LR boundary landing within
    ``lr_split_point_min_dist_meters`` of one snaps onto it rather than minting a
    near-duplicate node — the reference's behaviour, and the reason the threshold
    is a distance rather than a fraction of length.
    """
    positions: List[float] = [0.0, 1.0]
    if config.split_at_connectors:
        for connector in segment.get("connectors") or []:
            at = connector.get("at")
            if at is not None:
                positions.append(float(at))

    scoped = collect_linear_references(
        _without_reference_columns(segment, config.lr_columns_to_exclude)
    )
    tolerance = _fraction_for(config.lr_split_point_min_dist_meters, segment_length_m)

    ordered = sorted(set(positions))
    for boundary in sorted(scoped):
        if all(abs(boundary - existing) > tolerance for existing in ordered):
            ordered.append(boundary)
            ordered.sort()
    return _preserve_endpoints(ordered, tolerance)


def _preserve_endpoints(positions: List[float], tolerance: float) -> List[float]:
    """Collapse near-duplicates while keeping 0.0 and 1.0 exact.

    A position just short of 1.0 sorts first and would otherwise absorb it,
    leaving the last piece short and taking a synthetic connector in place of the
    segment's real end node.
    """
    snapped: List[float] = []
    for position in positions:
        if snapped and position - snapped[-1] <= tolerance:
            continue
        snapped.append(position)
    if snapped[-1] != 1.0:
        if 1.0 - snapped[-1] <= tolerance:
            snapped[-1] = 1.0
        else:
            snapped.append(1.0)
    if snapped[0] != 0.0:
        snapped.insert(0, 0.0)
    return snapped


# --- pieces ---------------------------------------------------------------


def _split_segment(
    segment: Dict[str, Any],
    coords: Sequence[Coord],
    positions: Sequence[float],
    segment_length_m: float,
    config: SplitConfig,
) -> Tuple[List[Dict[str, Any]], int]:
    pieces: List[Dict[str, Any]] = []
    dropped = 0

    for start, end in zip(positions, positions[1:]):
        if segment_length_m * (end - start) < config.min_piece_length_meters:
            dropped += 1
            continue
        pieces.append(
            _piece_record(segment, coords, start, end, segment_length_m, config)
        )

    # A segment whose every candidate piece was a sliver still has to survive as
    # one edge, or the network loses connectivity there. The slivers are still
    # counted — the stat reports what the split positions asked for, not what
    # this fallback rescued.
    if not pieces:
        pieces.append(
            _piece_record(segment, coords, 0.0, 1.0, segment_length_m, config)
        )
    return pieces, dropped


def _piece_record(
    segment: Dict[str, Any],
    coords: Sequence[Coord],
    start: float,
    end: float,
    segment_length_m: float,
    config: SplitConfig,
) -> Dict[str, Any]:
    piece = {
        key: value
        for key, value in segment.items()
        if key not in REFERENCE_COLUMNS and key != "coordinates"
    }
    piece_coords = [
        _round_coord(c, config.point_precision)
        for c in linear_ref.substring(coords, start, end)
    ]
    piece["coordinates"] = piece_coords
    piece["original_id"] = segment.get("id")
    piece["start_lr"] = start
    piece["end_lr"] = end
    # Composite id, as the reference forms it — the original id alone repeats
    # across every piece of the same segment.
    piece["id"] = f"{segment.get('id')}@{start}-{end}"

    piece_start_m = start * segment_length_m
    piece_length_m = linear_ref.total_length(piece_coords)
    for key in list(piece.keys()):
        if key in _PIECE_OWN_KEYS:
            continue
        piece[key] = apply_lr_scope(
            piece[key],
            piece_start_m=piece_start_m,
            piece_length_m=piece_length_m,
            segment_length_m=segment_length_m,
            min_overlap_m=config.min_overlapping_length_meters,
        )
    return piece


# Keys the splitter owns; never rewritten by LR scoping.
_PIECE_OWN_KEYS = frozenset({"coordinates", "original_id", "start_lr", "end_lr", "id"})


def apply_lr_scope(
    value: Any,
    *,
    piece_start_m: float,
    piece_length_m: float,
    segment_length_m: float,
    min_overlap_m: float,
) -> Any:
    """Recursively drop scoped values that miss this piece, rescale those that hit.

    Mirrors the reference's ``apply_lr_scope``. A value overlapping the piece for
    less than ``min_overlap_m`` does not apply; one covering the whole piece has
    its ``between`` removed; a partial overlap keeps a ``between`` rewritten
    relative to the piece. The last case cannot arise while we split at every
    boundary, but implementing it keeps the two behaviours comparable and means
    the code stays correct if splitting is ever relaxed.
    """
    if value is None:
        return None

    if isinstance(value, list):
        out_list = [
            cleaned
            for cleaned in (
                apply_lr_scope(
                    item,
                    piece_start_m=piece_start_m,
                    piece_length_m=piece_length_m,
                    segment_length_m=segment_length_m,
                    min_overlap_m=min_overlap_m,
                )
                for item in value
            )
            if cleaned is not None
        ]
        return out_list or None

    if isinstance(value, dict):
        out_dict: Dict[str, Any] = {}
        scope = value.get(LR_SCOPE_KEY)
        if scope is not None:
            if not isinstance(scope, list) or len(scope) != 2:
                raise ValueError(
                    f"'{LR_SCOPE_KEY}' must be a pair of linear references, got {scope!r}"
                )
            applies, rescaled = _rescale_scope(
                scope,
                piece_start_m=piece_start_m,
                piece_length_m=piece_length_m,
                segment_length_m=segment_length_m,
                min_overlap_m=min_overlap_m,
            )
            if not applies:
                return None
            if rescaled is not None:
                out_dict[LR_SCOPE_KEY] = rescaled

        for key, item in value.items():
            if key == LR_SCOPE_KEY:
                continue
            cleaned = apply_lr_scope(
                item,
                piece_start_m=piece_start_m,
                piece_length_m=piece_length_m,
                segment_length_m=segment_length_m,
                min_overlap_m=min_overlap_m,
            )
            if cleaned is not None:
                out_dict[key] = cleaned

        return out_dict or None

    return value


def _rescale_scope(
    scope: Sequence[Any],
    *,
    piece_start_m: float,
    piece_length_m: float,
    segment_length_m: float,
    min_overlap_m: float,
) -> Tuple[bool, Optional[List[float]]]:
    start_m = (float(scope[0]) if scope[0] else 0.0) * segment_length_m
    end_m = (float(scope[1]) if scope[1] else 1.0) * segment_length_m

    # Move into the piece's own frame, then clip to it.
    overlap_start_m = max(start_m - piece_start_m, 0.0)
    overlap_end_m = min(end_m - piece_start_m, piece_length_m)
    overlap_m = overlap_end_m - overlap_start_m
    if overlap_m < min_overlap_m:
        return (False, None)

    if piece_length_m - overlap_m < min_overlap_m:
        # Covers the whole piece: the piece *is* the range, so drop the scope.
        return (True, None)
    return (
        True,
        [overlap_start_m / piece_length_m, overlap_end_m / piece_length_m],
    )


# --- connectors -----------------------------------------------------------


def _assign_endpoint_connectors(
    piece: Dict[str, Any],
    segment: Dict[str, Any],
    *,
    known_ids: Set[str],
    synthetic: Dict[str, Dict[str, Any]],
    segment_length_m: float,
    config: SplitConfig,
) -> None:
    """Give the piece exactly two connectors, reconstructing any node we lack.

    Two cases need a node invented, and both are normal:

    * an attribute-change boundary is a split point with no connector behind it,
      so the node does not exist at all and gets a deterministic synthetic id;
    * a segment declares a ``connector_id`` that the uploaded connectors file
      doesn't contain. Overture is planet-scale, so every extract is clipped, and
      a segment crossing the clip boundary references a connector outside it.
      Here the id is real and GERS-resolvable — only its geometry is missing, and
      the piece's endpoint is exactly where it sits.

    Without the second case those edges would point at nodes absent from the
    layer, leaving the graph open at every boundary.
    """
    parent = segment.get("connectors") or []
    tolerance = _fraction_for(config.lr_split_point_min_dist_meters, segment_length_m)
    endpoints: List[Dict[str, Any]] = []

    for lr, coord_index in ((piece["start_lr"], 0), (piece["end_lr"], -1)):
        declared = _connector_at(parent, lr, tolerance)
        connector_id = declared or _synthetic_id(segment.get("id"), lr)
        if connector_id not in known_ids and connector_id not in synthetic:
            synthetic[connector_id] = {
                "id": connector_id,
                "coordinate": piece["coordinates"][coord_index],
                "theme": "transportation",
                "type": "connector",
                "synthetic": True,
            }
        endpoints.append({"connector_id": connector_id, "at": lr})

    piece["connectors"] = endpoints


def _connector_at(
    connectors: Iterable[Dict[str, Any]], lr: float, tolerance: float
) -> Optional[str]:
    for connector in connectors:
        at = connector.get("at")
        if at is not None and abs(float(at) - lr) <= tolerance:
            connector_id = connector.get("connector_id")
            return str(connector_id) if connector_id is not None else None
    return None


def _synthetic_id(original_id: Optional[str], lr: float) -> str:
    # Fixed-width position so the id is stable across runs and independent of
    # float repr.
    return f"{original_id}@{lr:.9f}"


# --- properties that reference other features -----------------------------


def _apply_reference_columns(piece: Dict[str, Any], segment: Dict[str, Any]) -> None:
    """Carry over turn restrictions and destinations that apply to this piece.

    These reference other segments and connectors, so linear referencing cannot
    place them: a restriction belongs to the piece whose endpoint connector its
    sequence starts from, with ``when.heading`` deciding which endpoint. Copying
    them onto every piece — the naive alternative — would multiply one
    restriction into as many as the segment has pieces.
    """
    connectors = piece.get("connectors") or []
    piece["prohibited_transitions"] = _filter_by_start_connector(
        segment.get("prohibited_transitions"),
        connectors,
        connector_of=lambda tr: _first_sequence_connector(tr),
    )
    piece["destinations"] = _filter_by_start_connector(
        segment.get("destinations"),
        connectors,
        connector_of=lambda d: d.get("from_connector_id"),
    )


def _filter_by_start_connector(
    rules: Any,
    connectors: Sequence[Dict[str, Any]],
    *,
    connector_of: Any,
) -> Optional[List[Dict[str, Any]]]:
    if not rules:
        return None
    if len(connectors) != 2:
        return None

    backward_id = connectors[0].get("connector_id")
    forward_id = connectors[1].get("connector_id")
    kept: List[Dict[str, Any]] = []

    for rule in rules:
        reference = connector_of(rule)
        if reference is None:
            continue
        heading = (rule.get("when") or {}).get("heading")
        # Travelling forward, the rule fires at the piece's far end; backward, at
        # its near end. Without a heading it only has to touch the piece at all.
        if heading == "forward" and forward_id != reference:
            continue
        if heading == "backward" and backward_id != reference:
            continue
        if reference not in (backward_id, forward_id):
            continue
        kept.append(rule)

    return kept or None


def _first_sequence_connector(rule: Dict[str, Any]) -> Optional[str]:
    sequence = rule.get("sequence") or []
    if not sequence:
        return None
    connector_id = sequence[0].get("connector_id")
    return str(connector_id) if connector_id is not None else None


# --- helpers --------------------------------------------------------------


def _without_reference_columns(
    segment: Dict[str, Any], excluded: Tuple[str, ...] = ()
) -> Dict[str, Any]:
    """Drop fields that must not contribute split positions.

    Reference columns carry no ``between`` and are filtered separately; ``excluded``
    additionally removes fields whose ranges are real but not worth a split.
    """
    skip = set(REFERENCE_COLUMNS) | set(excluded)
    return {k: v for k, v in segment.items() if k not in skip}


def _fraction_for(distance_m: float, length_m: float) -> float:
    """A distance expressed as a fraction of a segment's length."""
    return distance_m / length_m if length_m > 0.0 else 0.0


def _round_coord(coord: Coord, precision: int) -> Coord:
    return (round(coord[0], precision), round(coord[1], precision))
