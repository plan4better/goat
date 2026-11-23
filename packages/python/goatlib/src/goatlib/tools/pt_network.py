"""What every transit tool shares about an uploaded public-transport bundle.

The field that asks which bundle, the field that asks which date to route on,
and the step that hands the bundle's timetable and linkage to the analysis
params. Each tool used to carry its own copy of all three.
"""

from datetime import datetime
from pathlib import Path
from typing import Any

from pydantic import Field

from goatlib.analysis.pt_time import parse_pt_date
from goatlib.analysis.schemas.pt_network import PTNetworkOverride
from goatlib.analysis.schemas.ui import ui_field
from goatlib.bundles.artifacts.base import ArtifactSource
from goatlib.bundles.artifacts.gtfs import fetch_pt_linkage, fetch_pt_timetable


def pt_date_field(field_order: int) -> Any:
    """The date to route on, for a bundle whose timetable the weekday anchors
    do not fall inside.

    Replaces the weekday choice, which only means anything for the default
    network, so it is shown exactly when a bundle is chosen. Bounded by the
    window the chosen bundle's timetable was built for: outside it every
    journey comes back "no service".
    """
    return Field(
        default=None,
        description=(
            "Date to route on (YYYY-MM-DD). For an uploaded public-transport "
            "bundle, whose timetable covers the window its feed declares."
        ),
        json_schema_extra=ui_field(
            section="configuration",
            field_order=field_order,
            label_key="pt_date",
            widget="date-picker",
            visible_when={
                "$and": [
                    {"routing_mode": "pt"},
                    {"_pt_network_bundle_id_is_custom": True},
                ]
            },
            widget_options={
                "bounds_from": "pt_network_bundle_id",
                "bounds_artifact": "pt_network_graph",
            },
        ),
    )


def pt_network_bundle_field(field_order: int) -> Any:
    """The PT bundle to route on, for a tool that reads access and egress legs
    out of the bundle's stop-to-street linkage.

    Restricted to bundles whose linkage is built: the timetable alone is not
    enough for such a tool.
    """
    return Field(
        default=None,
        description=(
            "The public transport network used for routing: the default "
            "network, or a public transport bundle added to this project."
        ),
        json_schema_extra=ui_field(
            section="pt_network",
            field_order=field_order,
            label_key="pt_network_bundle_id",
            widget="bundle-selector",
            visible_when={
                "$and": [
                    {"routing_mode": {"$eq": "pt"}},
                    {"_project_has_pt_network_bundle": True},
                ]
            },
            widget_options={
                "bundle_type": "pt_network_gtfs",
                "artifact_kind": "pt_network_linkage",
            },
        ),
    )


#: The feed tables a departure count is computed from. `calendar` and
#: `calendar_dates` are conditionally required by GTFS — a feed states its
#: service in one, the other, or both — so each is fetched only if the bundle
#: holds it, and the date logic copes with either being absent.
GTFS_COUNT_ROLES = ("stops", "stop_times", "trips", "routes")
GTFS_SERVICE_ROLES = ("calendar", "calendar_dates")


def fetch_gtfs_tables(
    source: Any,
    bundle_id: str,
    user_id: str,
) -> "dict[str, str]":
    """A bundle's GTFS tables as parquet, by role.

    The tables as the feed published them — this is not an artifact, so nothing
    has to have been built for it to work. Roles the bundle does not hold are
    simply absent from the result; the caller decides which of those it can do
    without.

    Raises ``ValueError`` naming what is missing when a table the count cannot
    be computed without is not there, rather than returning a set of paths that
    fails later inside SQL.
    """
    layers = source.resolve_bundle_layers(bundle_id)
    missing = [role for role in GTFS_COUNT_ROLES if role not in layers]
    if missing:
        raise ValueError(
            "This public transport bundle is missing the GTFS table(s) "
            + ", ".join(missing)
            + ". Re-import the feed to use it here."
        )
    if not any(role in layers for role in GTFS_SERVICE_ROLES):
        raise ValueError(
            "This public transport bundle states no service days: it holds "
            "neither calendar nor calendar_dates. Re-import the feed to use it "
            "here."
        )

    paths: dict[str, str] = {}
    for role in (*GTFS_COUNT_ROLES, *GTFS_SERVICE_ROLES):
        layer_id = layers.get(role)
        if layer_id:
            paths[role] = str(
                source.export_layer_to_parquet(layer_id=layer_id, user_id=user_id)
            )
    return paths


def cut_network_tables(
    tables_dir: "str | Path",
    reference_area_path: "str | Path",
    service_date: str,
    workdir: "str | Path",
) -> "dict[str, str]":
    """The default network's GTFS tables (``pt_network/gtfs_tables``), cut to
    what a count in ``reference_area_path`` on ``service_date`` reads, as
    parquet by role: the shape ``fetch_gtfs_tables`` gives a bundle's.

    The network is a continent's: read whole, the count joins hundreds of
    millions of stop times to every trip and route. So the cut goes first,
    smallest table first: the area's stops and the date's services, then only
    their stop times, and only the trips and routes those name. Services are
    resolved to the date here, so what is returned states them as added on it
    (``calendar_dates``), whichever calendar file the network used.
    """
    import duckdb

    from goatlib.analysis.accessibility.base import active_services_sql
    from goatlib.bundles.importers.base import bound_duckdb
    from goatlib.bundles.importers.pt_network.store import read_store
    from goatlib.io.config import parquet_copy_options

    info = read_store(tables_dir)
    src = {t["role"]: t["path"].replace("'", "''") for t in info["tables"]}
    missing = [r for r in ("stops", "stop_times", "trips", "routes") if r not in src]
    if missing:
        raise ValueError(
            "This server's public transport network lacks the GTFS table(s) "
            + ", ".join(missing)
            + ". Its base data needs updating (sync_base_data)."
        )
    out = Path(workdir) / "network_tables"
    out.mkdir(parents=True, exist_ok=True)
    area = str(reference_area_path).replace("'", "''")
    day = datetime.strptime(service_date, "%Y-%m-%d").date().strftime("%Y%m%d")
    active = active_services_sql(
        service_date, src.get("calendar"), src.get("calendar_dates")
    )
    con = bound_duckdb(duckdb.connect(), str(out))
    try:
        con.execute("INSTALL spatial; LOAD spatial;")
        # The area's geometry column, by type: GeoParquet reads as GEOMETRY,
        # a plain parquet holds it as WKB.
        columns = con.execute(
            f"DESCRIBE SELECT * FROM read_parquet('{area}')"
        ).fetchall()
        geometry = next(
            (f'"{n}"' for n, t, *_ in columns if str(t).upper().startswith("GEOMETRY")),
            None,
        ) or next(
            (
                f'ST_GeomFromWKB("{n}")'
                for n, *_ in columns
                if n in ("geometry", "geom")
            ),
            None,
        )
        if geometry is None:
            raise ValueError("The reference area has no geometry.")
        con.execute(f"""
            CREATE TEMP TABLE area AS
            SELECT ST_Union_Agg({geometry}) AS geom,
                   ST_Extent_Agg({geometry}) AS box
            FROM read_parquet('{area}')
        """)
        # The area's stops: by their coordinates' box first, which the stops'
        # row groups skip on, then by the area itself.
        con.execute(f"""
            CREATE TEMP TABLE area_stops AS
            SELECT s.* FROM read_parquet('{src["stops"]}') s, area a
            WHERE CAST(s.stop_lon AS DOUBLE) BETWEEN ST_XMin(a.box) AND ST_XMax(a.box)
              AND CAST(s.stop_lat AS DOUBLE) BETWEEN ST_YMin(a.box) AND ST_YMax(a.box)
              AND ST_Intersects(
                  ST_Point(CAST(s.stop_lon AS DOUBLE), CAST(s.stop_lat AS DOUBLE)), a.geom)
        """)
        con.execute(f"""
            CREATE TEMP TABLE day_trips AS
            SELECT trip_id, route_id, service_id FROM read_parquet('{src["trips"]}')
            WHERE service_id IN ({active})
        """)
        con.execute(f"""
            CREATE TEMP TABLE area_stop_times AS
            SELECT trip_id, stop_id, arrival_time
            FROM read_parquet('{src["stop_times"]}')
            WHERE stop_id IN (SELECT stop_id FROM area_stops)
              AND trip_id IN (SELECT trip_id FROM day_trips)
        """)
        con.execute("""
            CREATE TEMP TABLE kept_trips AS SELECT * FROM day_trips
            WHERE trip_id IN (SELECT DISTINCT trip_id FROM area_stop_times)
        """)
        written = {
            "stops": "SELECT * FROM area_stops",
            "stop_times": "SELECT * FROM area_stop_times",
            "trips": "SELECT * FROM kept_trips",
            "routes": f"""SELECT route_id, route_type FROM read_parquet('{src["routes"]}')
                          WHERE route_id IN (SELECT route_id FROM kept_trips)""",
            "calendar_dates": f"""SELECT DISTINCT service_id, '{day}' AS date,
                                         1 AS exception_type FROM kept_trips""",
        }
        paths: dict[str, str] = {}
        for role, query in written.items():
            path = out / f"{role}.parquet"
            con.execute(f"COPY ({query}) TO '{path}' {parquet_copy_options()}")
            paths[role] = str(path)
        return paths
    finally:
        con.close()


def ensure_pt_date(bundle_id: "str | None", pt_date: Any) -> None:
    """Refuse a bundle run that carries no usable date.

    The date is what picks a day inside the window the feed declares. Without
    one the default network's weekday anchors stand in, and those fall outside
    an uploaded feed's window — so every journey comes back "no service" and the
    run returns empty with nothing saying why.

    The form already requires the date whenever a bundle is chosen. This is the
    same rule for a caller that is not the form, stated where the run would
    otherwise go quietly wrong.
    """
    if bundle_id and parse_pt_date(pt_date) is None:
        raise ValueError(
            "A date is required when routing on an uploaded public transport "
            "bundle: its timetable covers only the window its feed declares, "
            "which the default network's weekday anchors fall outside of."
        )


def apply_pt_bundle_override(
    source: ArtifactSource,
    analysis_params: PTNetworkOverride,
    bundle_id: str,
    dest_dir: str | Path,
    *,
    access_mode: str,
    egress_mode: str,
) -> None:
    """Point ``analysis_params`` at the bundle's timetable and linkage tables.

    Both legs read from the bundle's own linkage: mixing one network's
    timetable with another's tables would resolve stop indices to unrelated
    stops. The modes are the analysis layer's spelling ("walking"), which is
    what the tables are named for.
    """
    analysis_params.timetable_path = fetch_pt_timetable(source, bundle_id)
    analysis_params.access_table_path = fetch_pt_linkage(
        source, bundle_id, access_mode, dest_dir
    )
    analysis_params.egress_table_path = (
        analysis_params.access_table_path
        if egress_mode == access_mode
        else fetch_pt_linkage(source, bundle_id, egress_mode, dest_dir)
    )
