"""GTFS importer: a gtfs.zip → member layers for a ``pt_network_gtfs`` bundle.

Role → file and per-role column requirements are GTFS-specific and live here;
which roles are *required* comes from the spec. Every file becomes one layer
holding its rows and columns as published, typed where the GTFS reference
types a field (``gtfs_schema``) and text otherwise. Stops carry a geometry
alongside their own columns, and a derived line layer draws the shape points
for the map, with a line through the stops for each trip without a shape
(``stop_chains``); neither replaces the data it is drawn from.
"""

import csv
import io
import logging
import os
import re
import shutil
import zipfile
from typing import Dict, List, Optional, Set

from goatlib.bundles.importers.base import (
    BundleImporter,
    BundleMetadata,
    ExtractedLayer,
    ValidationResult,
    bound_duckdb,
    register_importer,
)
from goatlib.bundles.importers.pt_network.stop_chains import stop_chain_lines_parquet
from goatlib.models.bundle import BundleTypeName

logger = logging.getLogger(__name__)

_IDENTIFIER = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


def _clean(value: Optional[str]) -> Optional[str]:
    stripped = (value or "").strip()
    return stripped or None


def _valid_email(value: Optional[str]) -> Optional[str]:
    """Agencies write free text in this column — a phone number, opening
    hours — so anything unparseable is dropped rather than stored as a contact
    nobody can write to. Hygiene, not a constraint the read path relies on:
    `BundleRead` reports the document as stored."""
    if value and re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", value):
        return value
    return None


def _year(date: Optional[str]) -> Optional[int]:
    """Year from a GTFS ``YYYYMMDD`` date."""
    if date and len(date) == 8 and date.isdigit():
        return int(date[:4])
    return None


# role -> GTFS file. Every role is `<key>.txt`, which is the specification's own
# naming; spelled out rather than derived so a role whose file is named
# differently has somewhere to say so.
_GTFS_FILE: Dict[str, str] = {
    "agency": "agency.txt",
    "stops": "stops.txt",
    "routes": "routes.txt",
    "trips": "trips.txt",
    "stop_times": "stop_times.txt",
    "calendar": "calendar.txt",
    "calendar_dates": "calendar_dates.txt",
    "shapes": "shapes.txt",
    "frequencies": "frequencies.txt",
    "transfers": "transfers.txt",
    "pathways": "pathways.txt",
    "levels": "levels.txt",
    "feed_info": "feed_info.txt",
    "attributions": "attributions.txt",
    "translations": "translations.txt",
    "areas": "areas.txt",
    "stop_areas": "stop_areas.txt",
    "networks": "networks.txt",
    "route_networks": "route_networks.txt",
    "timeframes": "timeframes.txt",
    "fare_attributes": "fare_attributes.txt",
    "fare_rules": "fare_rules.txt",
    "fare_media": "fare_media.txt",
    "fare_products": "fare_products.txt",
    "fare_leg_rules": "fare_leg_rules.txt",
    "fare_leg_join_rules": "fare_leg_join_rules.txt",
    "fare_transfer_rules": "fare_transfer_rules.txt",
    "rider_categories": "rider_categories.txt",
    "booking_rules": "booking_rules.txt",
    "location_groups": "location_groups.txt",
    "location_group_stops": "location_group_stops.txt",
}

# Columns each role's file must expose: the specification's required fields for
# that file, and only those — an optional field a feed omits is not an error.
# Checked for every file present, so a malformed optional table is caught at
# upload rather than by whatever reads it later.
_REQUIRED_COLUMNS: Dict[str, Set[str]] = {
    "agency": {"agency_name", "agency_url", "agency_timezone"},
    "stops": {"stop_id"},
    "routes": {"route_id", "route_type"},
    "trips": {"route_id", "service_id", "trip_id"},
    "stop_times": {"trip_id", "stop_id", "stop_sequence"},
    "calendar": {
        "service_id",
        "monday",
        "tuesday",
        "wednesday",
        "thursday",
        "friday",
        "saturday",
        "sunday",
        "start_date",
        "end_date",
    },
    "calendar_dates": {"service_id", "date", "exception_type"},
    "shapes": {"shape_id", "shape_pt_lat", "shape_pt_lon", "shape_pt_sequence"},
    "frequencies": {"trip_id", "start_time", "end_time", "headway_secs"},
    "transfers": {"transfer_type"},
    "pathways": {
        "pathway_id",
        "from_stop_id",
        "to_stop_id",
        "pathway_mode",
        "is_bidirectional",
    },
    "levels": {"level_id", "level_index"},
    "feed_info": {"feed_publisher_name", "feed_publisher_url", "feed_lang"},
    "attributions": {"organization_name"},
    "translations": {"table_name", "field_name", "language", "translation"},
    "areas": {"area_id"},
    "stop_areas": {"area_id", "stop_id"},
    "networks": {"network_id"},
    "route_networks": {"network_id", "route_id"},
    "timeframes": {"timeframe_group_id"},
    "fare_attributes": {
        "fare_id",
        "price",
        "currency_type",
        "payment_method",
        "transfers",
    },
    "fare_rules": {"fare_id"},
    "fare_media": {"fare_media_id", "fare_media_type"},
    "fare_products": {"fare_product_id", "amount", "currency"},
    "fare_leg_rules": {"fare_product_id"},
    "fare_leg_join_rules": {"from_network_id", "to_network_id"},
    "fare_transfer_rules": {"fare_transfer_type"},
    "rider_categories": {"rider_category_id", "rider_category_name"},
    "booking_rules": {"booking_rule_id", "booking_type"},
    "location_groups": {"location_group_id"},
    "location_group_stops": {"location_group_id", "stop_id"},
}


class GtfsImporter(BundleImporter):
    bundle_type = BundleTypeName.pt_network_gtfs
    accepted_extensions = (".zip",)

    def matches_filename(self, filename: str) -> bool:
        # A .zip alone is ambiguous — Overture street networks are zips too — so
        # the name has to say GTFS as well.
        lower = filename.lower()
        return lower.endswith(".zip") and "gtfs" in lower

    # -- validation --------------------------------------------------------

    def validate(self, source_path: str) -> ValidationResult:
        errors: List[str] = []
        if not zipfile.is_zipfile(source_path):
            return ValidationResult(
                valid=False, errors=["File is not a valid .zip archive"]
            )

        with zipfile.ZipFile(source_path) as zf:
            names = {os.path.basename(n) for n in zf.namelist()}
            detected = [r for r, f in _GTFS_FILE.items() if f in names]

            required = set(self.spec.required_role_keys())
            missing = sorted(r for r in required if _GTFS_FILE[r] not in names)

            # Column checks for the files a feed cannot do without. An optional
            # file that fails them is skipped at extraction instead: it is the
            # file that is unusable, not the feed.
            essential = self._essential_roles()
            for role in detected:
                if role not in essential:
                    continue
                header, first = self._read_head(zf, _GTFS_FILE[role])
                needed = _REQUIRED_COLUMNS.get(role, set())
                absent = needed - set(header)
                if absent:
                    errors.append(
                        f"{_GTFS_FILE[role]} is missing column(s): "
                        f"{', '.join(sorted(absent))}"
                    )
                elif first is not None and len(first) > len(header):
                    # Read as CSV, such a file loses its header: the column
                    # names would be taken from the first row instead.
                    errors.append(
                        f"{_GTFS_FILE[role]} has rows with {len(first)} values "
                        f"but a header naming {len(header)} columns"
                    )

        for role in missing:
            errors.append(f"Required GTFS file '{_GTFS_FILE[role]}' is missing")

        # Conditionally required: a feed states its service days in calendar.txt,
        # in calendar_dates.txt, or in both. Either alone is valid; neither is a
        # feed that runs no service.
        for keys in self.spec.required_role_groups().values():
            if any(_GTFS_FILE[key] in names for key in keys):
                continue
            missing.extend(keys)
            errors.append(
                "One of "
                + " or ".join(f"'{_GTFS_FILE[key]}'" for key in keys)
                + " is required"
            )

        return ValidationResult(
            valid=not missing and not errors,
            detected_roles=detected,
            missing_required_roles=missing,
            errors=errors,
        )

    # -- metadata ----------------------------------------------------------

    def extract_metadata(self, source_path: str) -> BundleMetadata:
        """Provenance GTFS states about itself.

        ``feed_info.txt`` is the feed's own declaration of who published it and
        for which period, so it is preferred; ``agency.txt`` is the fallback for
        the publisher. Both are optional here — GTFS requires agency.txt but our
        spec does not, so a feed may state neither. Only one agency is read: a
        multi-agency feed has no single distributor, so nothing is claimed
        rather than picking one arbitrarily.

        License and attribution are not derived. GTFS has no license field, and
        ``feed_publisher_name`` is a publisher, not an attribution string.
        """
        if not zipfile.is_zipfile(source_path):
            return BundleMetadata()

        with zipfile.ZipFile(source_path) as zf:
            feed = self._read_rows(zf, "feed_info.txt")
            info = feed[0] if len(feed) == 1 else {}
            agencies = self._read_rows(zf, _GTFS_FILE["agency"])
            agency = agencies[0] if len(agencies) == 1 else {}

            name = _clean(info.get("feed_publisher_name")) or _clean(
                agency.get("agency_name")
            )
            url = _clean(info.get("feed_publisher_url")) or _clean(
                agency.get("agency_url")
            )
            email = _valid_email(
                _clean(info.get("feed_contact_email"))
                or _clean(agency.get("agency_email"))
            )
            year = _year(_clean(info.get("feed_start_date"))) or self._calendar_year(zf)

        return BundleMetadata(
            distributor_name=name,
            distributor_email=email,
            distribution_url=url,
            data_reference_year=year,
        )

    def _calendar_year(self, zf: zipfile.ZipFile) -> Optional[int]:
        """Earliest service year, for feeds that omit ``feed_start_date``."""
        years = [
            year
            for row in self._read_rows(zf, _GTFS_FILE["calendar"])
            if (year := _year(_clean(row.get("start_date")))) is not None
        ]
        return min(years) if years else None

    # -- extraction --------------------------------------------------------

    def extract_layers(self, source_path: str, workdir: str) -> List[ExtractedLayer]:
        """One layer per file in the feed, every column kept as published.

        Files the spec does not name — agency extensions such as
        `route_directions.txt` — are imported too, with the file name as the
        role, so a feed written back out is the feed that was uploaded.

        Only the files a feed cannot do without fail the import when they
        cannot be read. An optional GTFS file that lacks a column it requires,
        or does not convert, is skipped on its own; so is a file that is not a
        GTFS table at all, such as release notes shipped in the archive. Each
        skip is logged.
        """
        layers: List[ExtractedLayer] = []
        essential = self._essential_roles()
        # Each role's typed table, for the lines drawn after the loop.
        converted: Dict[str, str] = {}
        with zipfile.ZipFile(source_path) as zf:
            names = {
                os.path.basename(n) for n in zf.namelist() if self._is_feed_file(n)
            }
            for role in self.spec.role_keys():
                fname = _GTFS_FILE.get(role)
                if fname is None or fname not in names:
                    continue
                role_spec = self.spec.role(role)
                label = role_spec.label if role_spec else role
                if role not in essential:
                    absent = _REQUIRED_COLUMNS.get(role, set()) - set(
                        self._read_header(zf, fname)
                    )
                    if absent:
                        logger.warning(
                            "Skipping %s: missing column(s) %s",
                            fname,
                            ", ".join(sorted(absent)),
                        )
                        continue
                txt_path = self._extract_member(zf, fname, workdir)
                out_path = os.path.join(workdir, f"{role}.parquet")
                # The stop's position as a geometry next to its own columns.
                # Nullable: GTFS leaves coordinates empty for generic nodes and
                # boarding areas, and those stops are kept regardless.
                point = role == "stops"
                if not self._convert(
                    fname, txt_path, out_path, essential=role in essential, point=point
                ):
                    continue
                layers.append(
                    ExtractedLayer(
                        role=role,
                        name=label,
                        layer_type="feature" if point else "table",
                        geometry_type="point" if point else None,
                        file_path=out_path,
                    )
                )
                converted[role] = out_path

            lines = self._lines_layer(converted, workdir)
            if lines is not None:
                layers.append(lines)

            known = set(_GTFS_FILE.values())
            for fname in sorted(names - known):
                if not fname.endswith(".txt"):
                    continue
                # The file name itself, so it can never take a spec role's key
                # (a stray `shape_lines.txt` would otherwise collide with the
                # derived layer) and the write-back knows what to call it.
                role = fname
                if not self._is_gtfs_table(self._read_header(zf, fname)):
                    logger.warning("Skipping %s: not a GTFS table", fname)
                    continue
                txt_path = self._extract_member(zf, fname, workdir)
                out_path = os.path.join(workdir, f"extra_{len(layers)}.parquet")
                if not self._convert(fname, txt_path, out_path, essential=False):
                    continue
                layers.append(
                    ExtractedLayer(
                        role=role,
                        name=role,
                        layer_type="table",
                        geometry_type=None,
                        file_path=out_path,
                    )
                )
        return layers

    def _convert(
        self,
        fname: str,
        txt_path: str,
        out_path: str,
        *,
        essential: bool,
        point: bool = False,
    ) -> bool:
        """Convert one file; whether it became a layer.

        A file the feed cannot do without raises, so the import fails with the
        reason. Any other file is skipped with a warning: one unreadable
        optional or extra file is no reason to refuse the feed."""
        try:
            self._txt_to_parquet(txt_path, out_path, point=point)
        except Exception as e:
            if essential:
                raise ValueError(f"{fname} could not be read: {e}") from e
            logger.warning("Skipping %s: not a readable GTFS table (%s)", fname, e)
            if os.path.exists(out_path):
                os.remove(out_path)
            return False
        return True

    # -- helpers -----------------------------------------------------------

    @staticmethod
    def _resolve(zf: zipfile.ZipFile, basename: str) -> Optional[str]:
        for n in zf.namelist():
            if os.path.basename(n) == basename:
                return n
        return None

    @staticmethod
    def _is_gtfs_table(header: List[str]) -> bool:
        """Whether a file the spec does not name is a GTFS-style table.

        GTFS and its extensions name every column as an identifier
        (`route_id`, `direction_name`); release notes or a readme shipped in
        the archive open with prose, which CSV would happily read as a
        one-column table. A lone column counts when its name is a compound one,
        as GTFS forms them, so a single prose word does not."""
        fields = [f.strip() for f in header]
        if not fields or not all(_IDENTIFIER.match(f) for f in fields):
            return False
        return len(fields) > 1 or "_" in fields[0]

    def _essential_roles(self) -> Set[str]:
        """The roles a feed cannot do without: the spec's required files and
        the groups it needs one of (calendar / calendar_dates). Any other file
        is optional and is skipped, rather than failing the import, when it
        cannot be read."""
        essential = set(self.spec.required_role_keys())
        for keys in self.spec.required_role_groups().values():
            essential.update(keys)
        return essential

    def _read_head(
        self, zf: zipfile.ZipFile, basename: str
    ) -> "tuple[List[str], Optional[List[str]]]":
        """A file's header and its first data row (None when it has none)."""
        name = self._resolve(zf, basename)
        if name is None:
            return [], None
        with zf.open(name) as fh:
            reader = csv.reader(io.TextIOWrapper(fh, encoding="utf-8-sig"))
            return next(reader, []), next(reader, None)

    def _read_header(self, zf: zipfile.ZipFile, basename: str) -> List[str]:
        name = self._resolve(zf, basename)
        if name is None:
            return []
        with zf.open(name) as fh:
            reader = csv.reader(io.TextIOWrapper(fh, encoding="utf-8-sig"))
            return next(reader, [])

    def _read_rows(self, zf: zipfile.ZipFile, basename: str) -> List[Dict[str, str]]:
        name = self._resolve(zf, basename)
        if name is None:
            return []
        with zf.open(name) as fh:
            reader = csv.DictReader(io.TextIOWrapper(fh, encoding="utf-8-sig"))
            return [row for row in reader]

    def _extract_member(self, zf: zipfile.ZipFile, basename: str, workdir: str) -> str:
        """Extract a member file to workdir and return its path."""
        name = self._resolve(zf, basename)
        if name is None:
            raise ValueError(f"{basename} not found in archive")
        dest = os.path.join(workdir, basename)
        with zf.open(name) as src, open(dest, "wb") as out:
            shutil.copyfileobj(src, out)
        return dest

    @staticmethod
    def _is_feed_file(name: str) -> bool:
        """A file of the feed, not an archiver's by-product."""
        base = os.path.basename(name)
        return (
            bool(base) and not name.startswith("__MACOSX/") and not base.startswith(".")
        )

    @staticmethod
    def _txt_to_parquet(txt_path: str, out_path: str, point: bool = False) -> str:
        """Convert a GTFS text file to parquet, typed as the reference types it.

        Read as text first: ``all_varchar`` disables type auto-detection, which
        would turn ids that look like numbers into numbers. The columns the
        GTFS reference types are then parsed by the declared schema in
        ``gtfs_schema`` (times, dates, numbers, enums); every other column stays
        text. A file the schema does not describe stays text throughout.

        A value that does not parse in a field the reference requires makes the
        file unreadable (raises, with the column and examples); in an optional
        field it is dropped and the count logged.

        GTFS is RFC4180 CSV, so the dialect is set explicitly rather than sniffed:
        ``read_csv_auto`` infers it from an early sample, which misparses quoted
        fields with embedded commas (e.g. a stop_headsign "Town, Street") when
        they first appear past the sample. ``strict_mode=false`` also tolerates
        the minor RFC deviations real-world feeds commonly have. DuckDB streams
        both passes, so this is memory-safe for large tables (e.g. stop_times).

        ``point`` adds a nullable ``geometry`` built from ``stop_lon``/``stop_lat``,
        leaving both columns as they are.
        """
        # Imported here, not at module scope: `core` depends on goatlib
        # without the `full` extra, so it must be able to import this module
        # (the registry does) without duckdb present. Only conversion needs it.
        import duckdb

        from goatlib.bundles.importers.pt_network.gtfs_schema import (
            find_failures,
            typed_select,
        )

        fname = os.path.basename(txt_path)
        role = fname[: -len(".txt")] if fname.endswith(".txt") else fname
        src = txt_path.replace("'", "''")
        dst = out_path.replace("'", "''")
        text_path = f"{out_path}.text.parquet"
        text = text_path.replace("'", "''")
        read = (
            f"read_csv('{src}', all_varchar=true, header=true, delim=',', "
            f"quote='\"', escape='\"', strict_mode=false)"
        )
        # Bounded, spilling next to the output: see bound_duckdb.
        con = bound_duckdb(duckdb.connect(), os.path.dirname(os.path.abspath(out_path)))
        try:
            # The CSV is parsed once; the checks and the typed copy then read
            # the columnar copy, which is far cheaper to scan twice.
            con.execute(f"COPY (SELECT * FROM {read}) TO '{text}' (FORMAT parquet)")
            relation = f"read_parquet('{text}')"
            columns = [
                row[0]
                for row in con.execute(f"DESCRIBE SELECT * FROM {relation}").fetchall()
            ]
            failures = find_failures(con, role, relation, columns)
            refused = [f for f in failures if f.required]
            if refused:
                raise ValueError("; ".join(f.describe() for f in refused))
            for failure in failures:
                logger.warning("%s: %s; dropped", fname, failure.describe())

            select = f"SELECT {typed_select(role, columns)} FROM {relation}"
            if not point:
                con.execute(f"COPY ({select}) TO '{dst}' (FORMAT parquet)")
                return out_path
            from goatlib.io.geoparquet import write_optimized_parquet

            con.execute("INSTALL spatial; LOAD spatial")
            if {"stop_lon", "stop_lat"} <= set(columns):
                select = (
                    f"SELECT *, ST_Point(stop_lon, stop_lat) AS geometry "
                    f"FROM ({select})"
                )
            else:
                select = f"SELECT *, NULL::GEOMETRY AS geometry FROM ({select})"
            # The writer every feature upload goes through: it adds the bbox
            # the tile and feature paths prune row groups on.
            write_optimized_parquet(con, select, out_path)
        finally:
            con.close()
            if os.path.exists(text_path):
                os.remove(text_path)
        return out_path

    def _lines_layer(
        self, converted: Dict[str, str], workdir: str
    ) -> Optional[ExtractedLayer]:
        """The ``shape_lines`` member: the feed's shapes as lines, and a line
        through the stops for each trip without one (``stop_chains``), so a
        feed without shapes is drawn all the same. None where the feed has
        nothing to draw a line from."""
        import duckdb

        from goatlib.io.geoparquet import write_optimized_parquet

        parts: List[str] = []
        drawn: Set[str] = set()
        if "shapes" in converted:
            shape_path = os.path.join(workdir, "shape_lines.shapes.parquet")
            try:
                self._shape_lines_parquet(converted["shapes"], shape_path)
            except Exception as e:
                logger.warning("Skipping the shape lines: %s", e)
            else:
                parts.append(shape_path)
                con = duckdb.connect()
                try:
                    drawn = {
                        row[0]
                        for row in con.execute(
                            "SELECT shape_id FROM read_parquet(?)", [shape_path]
                        ).fetchall()
                    }
                finally:
                    con.close()
        if {"trips", "stop_times", "stops"} <= converted.keys():
            chain_path = os.path.join(workdir, "shape_lines.stops.parquet")
            try:
                count = stop_chain_lines_parquet(
                    converted["trips"],
                    converted["stop_times"],
                    converted["stops"],
                    drawn,
                    chain_path,
                )
            except Exception as e:
                logger.warning("Skipping the lines through the stops: %s", e)
            else:
                logger.info(
                    "%d lines through the stops for trips without a shape", count
                )
                parts.append(chain_path)
        if not parts:
            return None
        out_path = os.path.join(workdir, "shape_lines.parquet")
        # Bounded, spilling next to the output: see bound_duckdb.
        con = bound_duckdb(duckdb.connect(), workdir)
        try:
            con.execute("INSTALL spatial; LOAD spatial")
            union = " UNION ALL ".join(
                f"SELECT shape_id, geometry FROM read_parquet('{p.replace(chr(39), chr(39) * 2)}')"
                if p.endswith(".shapes.parquet")
                else f"SELECT shape_id, ST_GeomFromWKB(wkb) AS geometry "
                f"FROM read_parquet('{p.replace(chr(39), chr(39) * 2)}')"
                for p in parts
            )
            write_optimized_parquet(con, union, out_path)
        finally:
            con.close()
            for p in parts:
                if os.path.exists(p):
                    os.remove(p)
        spec = self.spec.role("shape_lines")
        return ExtractedLayer(
            role="shape_lines",
            name=spec.label if spec else "Shape lines",
            layer_type="feature",
            geometry_type="line",
            file_path=out_path,
        )

    @staticmethod
    def _shape_lines_parquet(shapes_path: str, out_path: str) -> str:
        """One line per shape, joined from its points in sequence order.

        A drawing of the shapes table, not a copy of it: points without a
        sequence or coordinates are left out of the line but stay in the table,
        and a shape with fewer than two drawable points gets no line. Reads the
        typed shapes table (see ``_txt_to_parquet``).

        DuckDB sorts the points, which spills to disk under the import's memory
        bound; the lines are then assembled one shape at a time as the sorted
        points stream past. Aggregating each shape's points into a list in SQL
        holds every shape in memory at once and cannot spill, which a city's
        shapes.txt outgrows.
        """
        import struct

        import duckdb
        import pyarrow as pa
        import pyarrow.parquet as pq

        from goatlib.io.geoparquet import write_optimized_parquet

        src = shapes_path.replace("'", "''")
        lines_path = f"{out_path}.lines.parquet"
        schema = pa.schema([("shape_id", pa.string()), ("wkb", pa.binary())])
        # Bounded, spilling next to the output: see bound_duckdb.
        con = bound_duckdb(duckdb.connect(), os.path.dirname(os.path.abspath(out_path)))
        try:
            con.execute("INSTALL spatial; LOAD spatial")
            cursor = con.execute(
                f"""
                SELECT shape_id, lon, lat
                FROM (
                    SELECT shape_id,
                           shape_pt_sequence AS seq,
                           shape_pt_lon AS lon,
                           shape_pt_lat AS lat
                    FROM read_parquet('{src}')
                )
                WHERE seq IS NOT NULL AND lon IS NOT NULL AND lat IS NOT NULL
                ORDER BY shape_id NULLS LAST, seq, lon, lat
                """
            )
            ids: List[Optional[str]] = []
            wkbs: List[bytes] = []
            with pq.ParquetWriter(lines_path, schema) as writer:

                def line(shape_id: Optional[str], coords: List[float]) -> None:
                    n = len(coords) // 2
                    if n < 2:
                        return
                    # WKB LineString, little-endian: byte order, type 2, count.
                    ids.append(shape_id)
                    wkbs.append(struct.pack(f"<BII{2 * n}d", 1, 2, n, *coords))
                    if len(ids) >= 1000:
                        flush()

                def flush() -> None:
                    if ids:
                        writer.write_table(
                            pa.table({"shape_id": ids, "wkb": wkbs}, schema=schema)
                        )
                        ids.clear()
                        wkbs.clear()

                current: Optional[str] = None
                coords: List[float] = []
                started = False
                while rows := cursor.fetchmany(10_000):
                    for shape_id, lon, lat in rows:
                        if started and shape_id != current:
                            line(current, coords)
                            coords = []
                        current, started = shape_id, True
                        coords += (lon, lat)
                if started:
                    line(current, coords)
                flush()
            write_optimized_parquet(
                con,
                f"SELECT shape_id, ST_GeomFromWKB(wkb) AS geometry "
                f"FROM read_parquet('{lines_path.replace(chr(39), chr(39) * 2)}')",
                out_path,
            )
        finally:
            con.close()
            if os.path.exists(lines_path):
                os.remove(lines_path)
        return out_path


register_importer(GtfsImporter())
