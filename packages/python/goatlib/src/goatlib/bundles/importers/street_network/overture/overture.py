"""Overture importer: a zip of GeoParquet -> a street network's edges + nodes.

Accepts a ``.zip`` holding one segments and one connectors GeoParquet file in
official Overture transportation schema. The zip is identified either by name
(``*overture*.zip``, mirroring the GTFS convention) or by sniffing its entries —
both bundle types are zips, so the name alone cannot decide.

Import splits the network at every connector and every linearly-referenced
attribute boundary, then flattens the result into the member layers. Splitting is
not optional: unsplit Overture segments carry interior connectors and
``between``-scoped attributes, which is not a routable graph. A failure here fails
the import.

The splitting and flattening themselves live in ``goatlib.bundles.importers.street_network.overture``;
this module is only the importer that drives them. Both are absolute imports, so
the shared name is unambiguous.
"""

import logging
import os
import shutil
import zipfile
from typing import List, NamedTuple, Optional, Tuple

from goatlib.bundles.importers.base import (
    BundleImporter,
    ExtractedLayer,
    ValidationResult,
    register_importer,
)
from goatlib.models.bundle import BundleTypeName

# pyarrow, and the reader/splitter/flatten/writer modules that pull duckdb and
# shapely, are imported inside the methods that use them rather than here.
# Importing this module registers the importer, and `core` does exactly that
# via the registry while depending on goatlib WITHOUT the `full` extra -- a
# module-scope import of the geospatial stack makes core unable to start.

logger = logging.getLogger(__name__)

# Entry-name fragments identifying the two roles inside the zip. Matched loosely
# so an extract named `munich_segments.geoparquet` works, since that is what a
# bbox query or `overturemaps download` tends to produce.
_SEGMENT_MARKERS = ("segment",)
_CONNECTOR_MARKERS = ("connector",)


class _Entries(NamedTuple):
    """The two archive entries the import needs, either possibly absent."""

    segments: Optional[str]
    connectors: Optional[str]

    @property
    def complete(self) -> bool:
        return self.segments is not None and self.connectors is not None


_GEOPARQUET_SUFFIXES = (".geoparquet", ".parquet")

# Columns the flattened edges layer must expose for the routing artifact.
_REQUIRED_SEGMENT_COLUMNS = ("id", "geometry", "connectors")
_REQUIRED_CONNECTOR_COLUMNS = ("id", "geometry")


class OvertureImporter(BundleImporter):
    bundle_type = BundleTypeName.street_network
    accepted_extensions = (".zip",)

    def matches_filename(self, filename: str) -> bool:
        lower = filename.lower()
        return lower.endswith(".zip") and "overture" in lower

    def matches_source(self, source_path: str) -> bool:
        """True when the zip holds both a segments and a connectors GeoParquet.

        The content check is what lets an extract keep whatever name the user
        gave it; it only reads the archive directory, not the parquet payloads.
        """
        if not zipfile.is_zipfile(source_path):
            return False
        try:
            with zipfile.ZipFile(source_path) as zf:
                names = zf.namelist()
        except zipfile.BadZipFile:
            return False
        return _locate(names).complete

    # -- validation --------------------------------------------------------

    def validate(self, source_path: str) -> ValidationResult:
        if not zipfile.is_zipfile(source_path):
            return ValidationResult(
                valid=False, errors=["File is not a valid .zip archive"]
            )

        errors: List[str] = []
        with zipfile.ZipFile(source_path) as zf:
            entries = _locate(zf.namelist())

        detected = []
        missing = []
        if entries.segments is None:
            missing.append("edges")
            errors.append(
                "No segments GeoParquet found (expected an entry like "
                "'segments.geoparquet')"
            )
        else:
            detected.append("edges")
        if entries.connectors is None:
            missing.append("nodes")
            errors.append(
                "No connectors GeoParquet found (expected an entry like "
                "'connectors.geoparquet')"
            )
        else:
            detected.append("nodes")

        if entries.complete:
            # Reading the two schemas is cheap — parquet footers only — and
            # catches a wrong-theme extract before a job is queued.
            errors.extend(self._check_columns(source_path, entries))

        return ValidationResult(
            valid=not missing and not errors,
            detected_roles=detected,
            missing_required_roles=missing,
            errors=errors,
        )

    def _check_columns(self, source_path: str, entries: _Entries) -> List[str]:
        import pyarrow.parquet as pq

        errors: List[str] = []
        with zipfile.ZipFile(source_path) as zf:
            for entry, required, label in (
                (entries.segments, _REQUIRED_SEGMENT_COLUMNS, "segments"),
                (entries.connectors, _REQUIRED_CONNECTOR_COLUMNS, "connectors"),
            ):
                if entry is None:
                    continue
                try:
                    with zf.open(entry) as fh:
                        schema = pq.read_schema(fh)
                except Exception as e:
                    errors.append(
                        f"{label} file '{entry}' is not readable parquet: {e}"
                    )
                    continue
                absent = [c for c in required if c not in schema.names]
                if absent:
                    errors.append(
                        f"{label} file '{entry}' is missing column(s): "
                        f"{', '.join(absent)}"
                    )
        return errors

    # -- extraction --------------------------------------------------------

    def extract_layers(self, source_path: str, workdir: str) -> List[ExtractedLayer]:
        from goatlib.bundles.importers.street_network.overture.flatten import (
            flatten_connector,
            flatten_edges,
        )
        from goatlib.bundles.importers.street_network.overture.reader import (
            ConnectorFile,
            OvertureReadError,
            iter_segments,
        )
        from goatlib.bundles.importers.street_network.overture.splitter import (
            SplitStream,
        )
        from goatlib.bundles.importers.street_network.overture.writer import (
            write_edges,
            write_nodes,
        )

        segments_path, connectors_path = self._unpack(source_path, workdir)

        # One record in flight at a time, the whole way through: read a batch,
        # split it, flatten it, stage it. Nothing between the files and the
        # staged parquet is a list, which is what a city network could not
        # afford — the pieces outnumber the segments two to one, and the
        # connectors alone were 1.7 GB when they were held.
        split = SplitStream(
            iter_segments(segments_path), ConnectorFile(connectors_path)
        )

        # Typed GeoParquet, which the runner ingests as-is. GeoJSON would leave
        # column types to be inferred from the data — see writer.py.
        edges_file = write_edges(
            flatten_edges(split), os.path.join(workdir, "edges.parquet")
        )
        # Only now are the stats and the referenced nodes known: which nodes the
        # layer holds is decided by the pieces, and the pieces have just gone by.
        if not split.stats.segments_in:
            raise OvertureReadError("Extract contains no road segments")
        nodes_file = write_nodes(
            (flatten_connector(c) for c in split.nodes()),
            os.path.join(workdir, "nodes.parquet"),
        )
        logger.info(
            "Overture import: %d segment(s) -> %d edge(s), %d node(s) "
            "(%d synthetic)",
            split.stats.segments_in,
            split.stats.segments_out,
            split.stats.nodes_out,
            split.stats.nodes_reconstructed,
        )

        return [
            ExtractedLayer(
                role="edges",
                name="Edges",
                layer_type="feature",
                geometry_type="line",
                file_path=edges_file,
            ),
            ExtractedLayer(
                role="nodes",
                name="Nodes",
                layer_type="feature",
                geometry_type="point",
                file_path=nodes_file,
            ),
        ]

    def _unpack(self, source_path: str, workdir: str) -> Tuple[str, str]:
        from goatlib.bundles.importers.street_network.overture.reader import (
            OvertureReadError,
        )

        """Extract the two GeoParquet entries to ``workdir``, flattening paths."""
        with zipfile.ZipFile(source_path) as zf:
            entries = _locate(zf.namelist())
            if entries.segments is None or entries.connectors is None:
                raise OvertureReadError(
                    "Archive does not contain both a segments and a connectors "
                    "GeoParquet file"
                )
            return (
                _extract_entry(zf, entries.segments, workdir, "segments.parquet"),
                _extract_entry(zf, entries.connectors, workdir, "connectors.parquet"),
            )


def _locate(names: List[str]) -> _Entries:
    """Resolve the segments and connectors entries in one pass."""
    return _Entries(
        segments=_find_entry(names, _SEGMENT_MARKERS),
        connectors=_find_entry(names, _CONNECTOR_MARKERS),
    )


def _find_entry(names: List[str], markers: Tuple[str, ...]) -> Optional[str]:
    """First non-directory entry whose basename matches a marker and suffix.

    Directory entries and archive metadata (``__MACOSX``, dotfiles) are skipped —
    a zip made on macOS carries resource forks that would otherwise match.
    """
    for name in names:
        if name.endswith("/") or "__MACOSX" in name:
            continue
        base = os.path.basename(name).lower()
        if base.startswith(".") or not base.endswith(_GEOPARQUET_SUFFIXES):
            continue
        if any(marker in base for marker in markers):
            return name
    return None


def _extract_entry(
    zf: zipfile.ZipFile, entry: str, workdir: str, dest_name: str
) -> str:
    dest = os.path.join(workdir, dest_name)
    with zf.open(entry) as src, open(dest, "wb") as out:
        shutil.copyfileobj(src, out)
    return dest


register_importer(OvertureImporter())
