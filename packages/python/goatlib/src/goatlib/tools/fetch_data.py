"""Extract features from our mirrored map data for one area, as a layer.

The reading -- which files, which rows, which tags -- is in
`goatlib.io.fetch.mirror`; this is the job around it.
"""

import json
import logging
from pathlib import Path
from typing import List, Literal, Self

from pydantic import BaseModel, ConfigDict, Field

from goatlib.analysis.schemas.ui import (
    SECTION_INPUT,
    SECTION_OUTPUT,
    ui_field,
    ui_sections,
)
from goatlib.io.fetch.area import (
    area_boxes,
    area_envelope,
    area_geom_column,
    area_table,
)
from goatlib.io.fetch.mirror.osm import tag_storage
from goatlib.io.fetch.mirror.overture import OVERTURE_TYPES
from goatlib.io.fetch.mirror.query import (
    candidates_sql,
    checked_where,
    filter_sql,
    lineage_text,
    selected_columns,
)
from goatlib.io.fetch.mirror.reader import (
    MAX_FEATURES,
    SOURCES,
    _files_of,
    _indexed,
    check_read_size,
    ensure_s3,
    mirror_columns,
    pointer,
)
from goatlib.models.io import DatasetMetadata
from goatlib.tools.base import BaseToolRunner, _get_or_create_event_loop
from goatlib.tools.schemas import ToolInputBase

logger = logging.getLogger(__name__)

#: Rows per row group of a fetch's output: the layer ingest reads one group at a
#: time, and 41,111 country outlines in one group needed 335 MB at once.
OUTPUT_ROW_GROUP = 4_096


class TagFilter(BaseModel):
    """One `key = value` condition on an OSM tag.

    Both sides are offered from the reference area rather than typed: OSM has no
    fixed schema, so the only honest list is what the chosen area actually holds.
    """

    key: str = Field(
        ...,
        description="OSM tag key, e.g. amenity",
        max_length=255,
        json_schema_extra=ui_field(section="input", field_order=1),
    )
    values: List[str] = Field(
        default_factory=list,
        description=(
            "Values to match, any of them. None selected matches every feature "
            "carrying the key."
        ),
        json_schema_extra=ui_field(section="input", field_order=2),
    )


class FetchDataParams(ToolInputBase):
    """What to extract, from where, and for which area.

    Shown as the panel's own description, so it says what the tool needs rather
    than what it is.
    """

    model_config = ConfigDict(
        json_schema_extra=ui_sections(SECTION_INPUT, SECTION_OUTPUT)
    )

    source: Literal["osm", "overture"] = Field(
        "osm",
        description="Which mirror to read",
        json_schema_extra=ui_field(section="input", field_order=2),
    )
    feature_type: Literal["points", "lines", "multipolygons"] = Field(
        "points",
        description="Which geometry to extract",
        json_schema_extra=ui_field(
            section="input", field_order=3, visible_when={"source": "osm"}
        ),
    )
    overture_type: Literal[
        "places",
        "divisions",
        "buildings",
        "land_use",
        "land_use_lines",
        "land",
        "land_points",
        "land_lines",
        "water_areas",
        "waterways",
        "water_points",
        "infrastructure_points",
        "infrastructure_lines",
        "infrastructure_areas",
    ] = Field(
        "places",
        description="Which kind of feature to extract",
        json_schema_extra=ui_field(
            section="input",
            field_order=3,
            visible_when={"source": "overture"},
            enum_labels={k: f"enums.overture_type.{k}" for k in OVERTURE_TYPES},
        ),
    )
    match_mode: Literal["all", "any"] = Field(
        "all",
        description=(
            "Whether a feature must satisfy every condition or just one of them"
        ),
        json_schema_extra=ui_field(
            section="input",
            field_order=4,
            enum_labels={
                "all": "Match all filters",
                "any": "Match at least one filter",
            },
        ),
    )
    tag_filters: List[TagFilter] = Field(
        default_factory=list,
        description="Tag conditions, combined with AND. None returns every feature in the area.",
        json_schema_extra=ui_field(
            section="input",
            field_order=5,
            repeatable=True,
        ),
    )
    area: dict = Field(
        ...,
        description=(
            "GeoJSON polygon bounding the extract: a map view, a region, a "
            "buffered point or a drawn shape"
        ),
        json_schema_extra=ui_field(section="input", field_order=1, hidden=True),
    )
    where: str | None = Field(
        None,
        max_length=4000,
        description=(
            "SQL condition used instead of the tag filters, e.g. "
            "tags['amenity'] = 'school'"
        ),
        json_schema_extra=ui_field(section="input", field_order=6),
    )


class FetchDataRunner(BaseToolRunner[FetchDataParams]):
    """Read the mirror for an area and write one layer."""

    default_output_name = "Extracted Features"
    output_geometry_type = "point"

    def get_feature_layer_type(self: Self, params: FetchDataParams) -> str:
        """A dataset brought in from a source, like an import -- not a tool's result."""
        return "standard"

    def process(
        self: Self, params: FetchDataParams, temp_dir: Path
    ) -> tuple[Path, DatasetMetadata]:
        con = self.duckdb_con
        ensure_s3(con)

        src = SOURCES[params.source]
        type_key = params.feature_type if src.tagged else params.overture_type
        self.output_geometry_type = src.geometry_of(type_key)

        area = area_table(con, params.area)
        envelope = area_envelope(con, area)
        area_geom = area_geom_column(con, area)
        indexed = _indexed(con, pointer(con, src), src, type_key, envelope)
        files, parts = _files_of(*indexed)
        # Which unit and version each file belongs to, as its index says.
        origin = {f: indexed[0][row[0]] for f, row in zip(files, indexed[1])}
        if not files:
            raise ValueError("The mirror holds no data for this area.")
        check_read_size(con, files, area_boxes(con, area), src.geom)

        columns = mirror_columns(con, files)
        storage = tag_storage(columns)
        if params.where:
            prefilter, exact = "TRUE", checked_where(con, files, src, params.where)
        else:
            prefilter, exact = filter_sql(
                params.tag_filters, src, params.match_mode, type_key, storage
            )
        prefilter = f"({prefilter}) AND {src.geometry_filter(type_key, files)}"
        out = temp_dir / "output.parquet"
        staged = temp_dir / "staged.parquet"
        # GDAL fills osm_id only for relations on the polygon layer; a polygon
        # from a way has its id in osm_way_id and osm_id NULL. Keyed on osm_id
        # alone, every way-polygon fell into one group and one row was kept.
        identity = (
            'c."osm_id", c."osm_way_id"'
            if src.tagged and "osm_way_id" in columns
            else f'c."{src.id_column}"'
        )
        selected = ", ".join(e for e, _, _ in selected_columns(columns, src, storage))
        # Two spatial tests, not one: the envelope prunes row groups before
        # anything is read, the area itself is what the user asked for.
        # The area as a constant, so the test streams: joined as a table with a
        # country's outline, DuckDB indexed every candidate and ran out of memory.
        (shape,) = con.execute(
            f'SELECT ST_AsHEXWKB(ST_Union_Agg("{area_geom}")) FROM {area}'
        ).fetchone()
        geom, inside = f'c."{src.geom}"', f"ST_GeomFromHEXWKB('{shape}')"
        con.execute(f"""
            COPY (
                WITH candidates AS ({candidates_sql(files, src, envelope, prefilter, storage)})
                SELECT {selected}, c.filename AS _mirror_file
                FROM candidates c
                WHERE {exact} AND ST_Intersects({geom}, {inside})
                LIMIT {2 * MAX_FEATURES + 1}
            ) TO '{staged}' (FORMAT PARQUET)
        """)
        # Which files supplied rows, so the lineage names only those: a unit's
        # bbox can cover the area without the unit holding anything in it
        # (France's, Corsica to the Belgian border, covers Frankfurt).
        supplied = {
            str(r[0])
            for r in con.execute(
                f"SELECT DISTINCT _mirror_file FROM read_parquet('{staged}')"
            ).fetchall()
        }
        parts = [part for part in parts if part in {origin.get(f) for f in supplied}]
        # A feature at a seam comes from both units: kept once, decided on the ids
        # alone, since a window over whole rows held them all and ran out of memory.
        rows = f"read_parquet('{staged}', file_row_number = true)"
        con.execute(f"""
            COPY (
                SELECT * EXCLUDE (_mirror_file, file_row_number) FROM {rows}
                WHERE file_row_number IN (
                    SELECT min(file_row_number) FROM {rows}
                    GROUP BY {identity.replace("c.", "")}
                )
            ) TO '{out}' (FORMAT PARQUET, ROW_GROUP_SIZE {OUTPUT_ROW_GROUP})
        """)
        # The staged read stops at its limit: reaching it means rows were left out.
        (staged_rows,) = con.execute(
            f"SELECT count(*) FROM read_parquet('{staged}')"
        ).fetchone()
        staged.unlink(missing_ok=True)
        count = con.execute(f"SELECT count(*) FROM read_parquet('{out}')").fetchone()
        features = int(count[0]) if count else 0
        # An empty layer has no geometry type and names no source: refused, not made.
        if not features:
            raise ValueError(
                "No features match in this area. Pick another area or loosen the filters."
            )
        if features > MAX_FEATURES or staged_rows > 2 * MAX_FEATURES:
            raise ValueError(
                f"The area holds more than {MAX_FEATURES:,} matching features. "
                "Pick a smaller area or add filters."
            )
        read = ", ".join(f"{e} {sid}" for e, sid in parts)
        conditions = params.where or ", ".join(
            f"{f.key}={','.join(f.values)}" if f.values else f.key
            for f in params.tag_filters
        )
        provider = "OpenStreetMap" if src.tagged else "Overture Maps"
        licence, attribution = src.licence_of(type_key)
        logger.info(
            "extracted %s feature(s) from the %s mirror (%s)%s — %s, %s",
            features,
            provider,
            read,
            f", where {conditions}" if conditions else "",
            attribution,
            licence,
        )
        # The catalog record's own keys, so the dataset card reads both the same.
        self._provenance = {
            "license": licence,
            "attribution": attribution,
            "processing:lineage": lineage_text(
                src,
                type_key,
                parts,
                params.tag_filters,
                params.match_mode,
                params.where,
            ),
            "publisher": provider,
            "source_url": (
                "https://www.openstreetmap.org"
                if src.tagged
                else "https://overturemaps.org"
            ),
        }
        return out, DatasetMetadata(
            path=str(out),
            source_type="vector",
            format="parquet",
            driver="duckdb",
            crs="EPSG:4326",
            geometry_type=self.output_geometry_type,
            feature_count=features,
        )


async def _record_provenance(
    runner: FetchDataRunner, layer_id: str, provenance: dict
) -> None:
    """Write where the data came from onto the layer the tool just made.

    Done here because the runner creates the layer from the output file's
    metadata, which carries no provenance -- and this layer's licence is an
    obligation that has to travel with it, not a nicety.

    Under ``other_properties.provenance``: a layer has no metadata column of its
    own (only a bundle does), and ``catalog_item`` means a link to a catalog
    record, which a copy drops -- this has to survive a copy.
    """
    assert runner.settings is not None
    pool = await runner.get_postgres_pool()
    schema = runner.settings.customer_schema
    # The project link this job just made keeps its own copy of the layer's
    # other_properties, taken before this ran, so the licence goes into that
    # copy too -- only this layer's links, which exist for seconds at this point.
    try:
        for table, column in (("layer", "id"), ("layer_project", "layer_id")):
            await pool.execute(
                f"UPDATE {schema}.{table} "
                "SET other_properties = COALESCE(other_properties, '{}'::jsonb) "
                f"|| jsonb_build_object('provenance', $1::jsonb) WHERE {column} = $2::uuid",
                json.dumps(provenance),
                layer_id,
            )
    finally:
        await pool.close()


def main(params: FetchDataParams) -> dict:
    """Windmill entry point."""
    runner = FetchDataRunner()
    runner.init_from_env()
    try:
        result = runner.run(params)
        layer_id = result.get("layer_id") if isinstance(result, dict) else None
        provenance = getattr(runner, "_provenance", None)
        if layer_id and provenance:
            try:
                _get_or_create_event_loop().run_until_complete(
                    _record_provenance(runner, str(layer_id), provenance)
                )
            except Exception as e:  # noqa: BLE001 - the layer matters more
                logger.warning("could not record provenance on %s: %s", layer_id, e)
        return result
    finally:
        runner.cleanup()
