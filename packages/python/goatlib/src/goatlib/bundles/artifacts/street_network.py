"""Build a routable street-network artifact from a bundle's member layers.

Output is a folder of two parquet files in the schema
``data/street_network_loader.cpp`` reads, tarred into one file because
``bundle_artifact`` stores a single object key:

    edges.parquet   id source target length_m length_3857 class_
                    impedance_slope impedance_slope_reverse impedance_surface
                    maxspeed_forward maxspeed_backward coordinates_3857
    nodes.parquet   id x_3857 y_3857

No H3 columns. The global network is hive-partitioned by H3 cell and prunes on
those columns, but an uploaded network is small enough to load whole, and
computing the cells — plus clipping segments to cell boundaries to make the
assignment exact — is overhead that buys nothing here. The loader needs a matching
change to treat the columns as optional; see README.md.

Column widths are load-bearing, not advisory. The loader ``reinterpret_cast``s
each vector straight to a C type — ``int64_t`` for ids, ``double`` for lengths and
slope, ``float`` for ``impedance_surface``, ``int16_t`` for the speeds,
``int32_t`` for the H3 cells — so a column written one width off reads garbage
rather than raising. ``ROUTING_EDGE_TYPES`` is the contract, and
``test_artifact_types_match_the_loader`` holds it.

The build reads the *layers*, not the uploaded zip: the layers are the source of
truth, so a user edit to ``edges`` is picked up on the next rebuild.

``fetch_routing_network`` is the consumer side, living here so the tar's layout is
described in one place: any tool that routes off a bundle calls it and gets the two
paths, rather than each tool knowing how the artifact is packaged.
"""

import logging
import os
import tarfile
from pathlib import Path
from typing import Dict, List, Tuple

import duckdb

from goatlib.bundles.artifacts.base import (
    ArtifactBuilder,
    ArtifactSource,
    BuiltArtifact,
)
from goatlib.models.bundle import (
    ROUTING_CLASSES,
    BundleArtifactKind,
    BundleArtifactState,
    BundleTypeName,
)

logger = logging.getLogger(__name__)

# Members of the tar. Shared so the reader below cannot drift from the writer.
EDGES_MEMBER = "edges.parquet"
NODES_MEMBER = "nodes.parquet"

# What the loader's reinterpret_casts require, by column.
ROUTING_EDGE_TYPES: Dict[str, str] = {
    "id": "BIGINT",
    "source": "BIGINT",
    "target": "BIGINT",
    "length_m": "DOUBLE",
    "length_3857": "DOUBLE",
    "class_": "VARCHAR",
    "impedance_slope": "DOUBLE",
    "impedance_slope_reverse": "DOUBLE",
    "impedance_surface": "FLOAT",
    "maxspeed_forward": "SMALLINT",
    "maxspeed_backward": "SMALLINT",
    "coordinates_3857": "DOUBLE[][]",
}

ROUTING_NODE_TYPES: Dict[str, str] = {
    "id": "BIGINT",
    "x_3857": "DOUBLE",
    "y_3857": "DOUBLE",
}

# The class vocabulary lives on the bundle type's spec (`goatlib.models.bundle`)
# — the member layer already carries the resolved speeds, so this builder only
# needs the vocabulary to keep `class_` inside what the engine's WHERE filter
# accepts.
# Cycling cost coefficient per surface: `cost = length * (1 + slope + surface)`,
# and only bicycle/pedelec read it. Values are the org's own, from
# data_preparation's `overture_street_network_europe.yaml` (`cycling_surfaces`),
# so an uploaded network is costed the same way the global network is. Surfaces
# absent there — paved, asphalt, metal, … — carry no penalty.
SURFACE_IMPEDANCE: Dict[str, float] = {
    "unpaved": 0.2,
    "gravel": 0.3,
    "dirt": 0.4,
    "paving_stones": 0.2,
}
DEFAULT_SURFACE_IMPEDANCE = 0.0


class StreetNetworkArtifactBuilder(ArtifactBuilder):
    bundle_type = BundleTypeName.street_network
    produces = (BundleArtifactKind.street_network_graph,)

    def build_from_layers(
        self, *, layer_paths: Dict[str, str], workdir: str
    ) -> List[BuiltArtifact]:
        edges_layer = layer_paths.get("edges")
        nodes_layer = layer_paths.get("nodes")
        if not edges_layer or not nodes_layer:
            raise ValueError(
                "street_network artifact needs both an 'edges' and a 'nodes' layer"
            )

        out_dir = os.path.join(workdir, "street_network")
        os.makedirs(out_dir, exist_ok=True)
        edges_out = os.path.join(out_dir, EDGES_MEMBER)
        nodes_out = os.path.join(out_dir, NODES_MEMBER)

        con = duckdb.connect()
        try:
            con.execute("INSTALL spatial; LOAD spatial")
            counts = _transform(con, edges_layer, nodes_layer, edges_out, nodes_out)
        finally:
            con.close()

        archive = os.path.join(workdir, "street_network_graph.tar")
        with tarfile.open(archive, "w") as tar:
            # Flat names so extracting yields a folder of two parquet files, which
            # is the layout the loader's recursive glob expects.
            tar.add(edges_out, arcname=EDGES_MEMBER)
            tar.add(nodes_out, arcname=NODES_MEMBER)

        size = os.path.getsize(archive)
        logger.info(
            "Built street network graph: %d edge(s), %d node(s), %.1f MB",
            counts[0],
            counts[1],
            size / 1e6,
        )
        return [
            BuiltArtifact(
                kind=BundleArtifactKind.street_network_graph,
                local_path=archive,
                size=size,
            )
        ]


def unpack_routing_network(
    archive: str | Path, dest_dir: str | Path
) -> Tuple[str, str]:
    """Extract a graph artifact, returning the ``(edges, nodes)`` paths.

    Both files are named rather than the directory returned: the routing engine
    reads each as its own dataset, and pointing it at the containing folder would
    make each scan glob both files and union their schemas.
    """
    network_dir = Path(dest_dir) / "street_network"
    network_dir.mkdir(parents=True, exist_ok=True)
    with tarfile.open(archive) as tar:
        # filter="data" refuses members with absolute or parent-relative paths.
        # We wrote this tar, but it is read back off a shared volume, so the
        # bytes are not necessarily the ones we wrote.
        tar.extractall(network_dir, filter="data")

    edges = network_dir / EDGES_MEMBER
    nodes = network_dir / NODES_MEMBER
    if not edges.exists() or not nodes.exists():
        raise ValueError(
            "The street network bundle's routing graph is incomplete "
            f"(expected {EDGES_MEMBER} and {NODES_MEMBER})."
        )
    return str(edges), str(nodes)


def require_routing_network(
    archive: str | None,
    state: "BundleArtifactState | None",
    dest_dir: str | Path,
) -> Tuple[str, str]:
    """Unpack a resolved graph, or refuse with why it cannot be used.

    Split from the fetch so the sync path (a tool, through its runner) and the
    async one (a build, through its database service) resolve the artifact
    however suits them and still refuse in the same words.
    """
    if not archive:
        # The state separates "not ready yet" from "was ready until someone
        # edited it", which are different things to tell a user. None means no
        # build has been attempted.
        refusal: Dict[BundleArtifactState | None, str] = {
            BundleArtifactState.outdated: (
                "This street network is being updated after an edit. Try again "
                "once the update finishes."
            ),
            BundleArtifactState.building: (
                "This street network is still being prepared. Try again shortly."
            ),
            BundleArtifactState.failed: (
                "This street network's last update failed. Update it from the "
                "bundle before using it."
            ),
        }
        raise ValueError(
            refusal.get(
                state,
                "The selected street network bundle is not ready to route on yet.",
            )
        )
    return unpack_routing_network(archive, dest_dir)


def fetch_routing_network(
    source: ArtifactSource, bundle_id: str, dest_dir: str | Path
) -> Tuple[str, str]:
    """Fetch and unpack a bundle's routing graph for any tool that routes.

    Returns the ``(edges, nodes)`` paths to hand to the analysis params, so a
    consumer needs one call and no knowledge of the artifact's packaging.
    """
    return require_routing_network(
        *source.resolve_bundle_artifact(
            bundle_id, BundleArtifactKind.street_network_graph.value
        ),
        dest_dir,
    )


def fetch_linked_routing_network(
    source: ArtifactSource, bundle_id: str, dest_dir: str | Path
) -> "Tuple[str, str] | None":
    """The graph of the street network a bundle is linked to, if it names one.

    Following the link rather than asking again: a public-transport bundle's
    stops were connected to a particular street network, and routing its access
    and egress legs on a different one — or on the default, which may not even
    cover the region — is not something a user should have to know to avoid.

    None when nothing is linked, so a caller can fall back to the default. A
    network that *is* linked but unusable raises, as it does everywhere else:
    silently routing on something other than what the bundle names is the
    failure this exists to prevent.
    """
    depends_on = source.resolve_bundle_dependency(bundle_id, "street_network")
    if not depends_on:
        return None
    return fetch_routing_network(source, depends_on, dest_dir)


def _transform(
    con: "duckdb.DuckDBPyConnection",
    edges_layer: str,
    nodes_layer: str,
    edges_out: str,
    nodes_out: str,
) -> Tuple[int, int]:
    """Member layers -> routing parquet. Returns (edge count, node count)."""
    # The routing schema keys on int64; Overture ids are GERS strings. Numbering
    # the nodes once and joining edges against it is what makes source/target
    # consistent with the node ids.
    con.execute(f"""
        CREATE TABLE node_ids AS
        SELECT row_number() OVER (ORDER BY id) AS int_id, id AS gers_id, geometry
        FROM read_parquet('{nodes_layer}')
    """)

    con.execute(f"COPY ({_node_query()}) TO '{nodes_out}' (FORMAT PARQUET)")
    con.execute(f"""
        CREATE TABLE edge_src AS
        SELECT * FROM read_parquet('{edges_layer}')
    """)

    # `length_m` is read from the layer rather than derived here, so its absence
    # has to be caught before the build: the engine reads a zero-length edge as
    # free to traverse, which would silently distort every route through it.
    # Checked here rather than trusted because an edges layer imported before
    # the column existed simply has not got one.
    edge_columns = {
        row[0]
        for row in con.execute("SELECT column_name FROM (DESCRIBE edge_src)").fetchall()
    }
    if "length_m" not in edge_columns:
        raise ValueError(
            "The edges layer has no 'length_m' column, so edge costs cannot be "
            "built. It is a computed column added at import; re-import this "
            "street network bundle to produce it."
        )
    missing = con.execute(
        "SELECT count(*) FROM edge_src WHERE length_m IS NULL"
    ).fetchone()
    if missing and missing[0]:
        raise ValueError(
            f"{missing[0]} edge(s) have no 'length_m' value. The column is "
            "computed from the geometry on import and on every edit, so a null "
            "means it was never filled — re-import or edit the layer to "
            "recompute it."
        )

    con.execute(f"COPY ({_edge_query()}) TO '{edges_out}' (FORMAT PARQUET)")

    edge_count = con.execute(
        f"SELECT count(*) FROM read_parquet('{edges_out}')"
    ).fetchone()
    node_count = con.execute(
        f"SELECT count(*) FROM read_parquet('{nodes_out}')"
    ).fetchone()
    edges_written = edge_count[0] if edge_count else 0

    # The edge query inner-joins source/target against the node ids, so an edge
    # naming a node the layer does not hold is dropped: the graph is just
    # missing that street. Dropping with a loud warning, not refusing — layers
    # imported before the editor derived nodes (or touched by old per-feature
    # edits) can hold dangling references, and refusing would leave such a
    # bundle permanently stale after its first edit, with no in-product way
    # back. Refuse only when nothing survives: an all-dangling network is not
    # a graph with gaps, it is the wrong nodes layer.
    source_count = con.execute("SELECT count(*) FROM edge_src").fetchone()
    edges_read = source_count[0] if source_count else 0
    if edges_written == 0 and edges_read > 0:
        raise ValueError(
            f"None of the {edges_read} edge(s) reference a node in the nodes "
            "layer, so no routable network can be built from these layers."
        )
    if edges_written != edges_read:
        logger.warning(
            "Dropped %d of %d edge(s) referencing a node that is not in the "
            "nodes layer; those streets are missing from the routable network",
            edges_read - edges_written,
            edges_read,
        )

    return (edges_written, node_count[0] if node_count else 0)


def _node_query() -> str:
    # always_xy is not optional: EPSG:4326 declares (latitude, longitude) as its
    # authority axis order, and ST_Transform honours that, so without it every
    # coordinate comes out transposed — nodes land at (lat, lon) in metres and
    # nothing snaps to the network.
    return """
        SELECT
            int_id::BIGINT AS id,
            ST_X(ST_Transform(geometry, 'EPSG:4326', 'EPSG:3857', always_xy := true))::DOUBLE AS x_3857,
            ST_Y(ST_Transform(geometry, 'EPSG:4326', 'EPSG:3857', always_xy := true))::DOUBLE AS y_3857
        FROM node_ids
    """


def _edge_query() -> str:
    surface_case = " ".join(
        f"WHEN e.surface = '{name}' THEN {value}"
        for name, value in SURFACE_IMPEDANCE.items()
    )
    class_list = ", ".join(f"'{c}'" for c in sorted(ROUTING_CLASSES))
    return f"""
        WITH projected AS (
            SELECT
                e.*,
                ST_Transform(e.geometry, 'EPSG:4326', 'EPSG:3857', always_xy := true) AS geom_3857,
                CASE WHEN e."class" IN ({class_list})
                     THEN e."class" ELSE 'unknown' END AS routing_class,
                CASE {surface_case} ELSE {DEFAULT_SURFACE_IMPEDANCE} END AS surface_imp
            FROM edge_src e
        )
        SELECT
            row_number() OVER (ORDER BY p.id)::BIGINT AS id,
            s.int_id::BIGINT AS source,
            t.int_id::BIGINT AS target,
            -- The edges layer's own computed column, not derived here: one
            -- formula, in `goatlib.computed_columns`, so the length a user sees
            -- and the length the engine routes on cannot disagree. Cast because
            -- the layer stores FLOAT and the loader reinterpret_casts DOUBLE.
            p.length_m::DOUBLE AS length_m,
            ST_Length(p.geom_3857)::DOUBLE AS length_3857,
            p.routing_class::VARCHAR AS class_,
            -- No DEM in an upload, so uploaded networks route as though flat.
            0.0::DOUBLE AS impedance_slope,
            0.0::DOUBLE AS impedance_slope_reverse,
            p.surface_imp::FLOAT AS impedance_surface,
            -- Straight from the layer: it already resolved stated limits, class
            -- defaults and access. A null means the class is not drivable, which
            -- is the same thing to the engine as 0 — it treats maxspeed <= 0 as
            -- "cannot be traversed this way".
            coalesce(p.speed_limit_kph_forward, 0)::SMALLINT AS maxspeed_forward,
            coalesce(p.speed_limit_kph_backward, 0)::SMALLINT AS maxspeed_backward,
            list_transform(
                ST_Dump(ST_Points(p.geom_3857)),
                pt -> [ST_X(pt.geom)::DOUBLE, ST_Y(pt.geom)::DOUBLE]
            ) AS coordinates_3857
        FROM projected p
        JOIN node_ids s ON s.gers_id = p.source_node
        JOIN node_ids t ON t.gers_id = p.target_node
    """
