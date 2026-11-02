"""Build GOAT's default public transport network and publish it as base data.

GOAT's default network is one GTFS feed combining several countries. When it
is regenerated, its zip is placed in a source folder; this task turns it into
a ``public_transport`` base data version (``tasks/sync_base_data``), which
servers then install::

    pt_network/gtfs.bin                        the timetable nigiri routes on
    pt_network/accessegress_walking_r9.parquet the stops' walking access/egress
    pt_network/gtfs_tables/                    the feed as tables, cut to an
                                               area by fetch_pt_network

Nothing here is built its own way. The timetable and the access/egress table
are what every GTFS bundle's artifact build makes (``GtfsArtifactBuilder``),
here against the worker's global street network, as a bundle without a linked
network is built; the tables are the importer's output
(``bundles/importers/pt_network/store``); the version is written by
``sync_base_data.publish``, manifest last.

The version ``requires`` the street network version installed on this worker:
the access/egress table was computed on it. Its ``coverage`` is the stops'
extent. A channel moves to it only if one is named.

Not built: the legacy ``gtfs/`` files (``stop_times_optimized.parquet`` and
the rest), which ÖV-Güteklassen, trip count and the R5 catchments read and
whose format is defined outside this repo. A server installing a version
without them has no ``gtfs/`` for those tools, so do not point a channel at
such a version until they are supplied with it.

Windmill path: f/goat/tasks/build_pt_network
Worker tag: tools (the routing extension and the street network)
Schedule: none (run manually, when the feed is regenerated)
"""

import logging
import shutil
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Optional, Self

from pydantic import BaseModel, Field

from goatlib.bundles.artifacts.gtfs import (
    DEFAULT_LINKAGE_MODES,
    GtfsArtifactBuilder,
    linkage_member,
    unpack_pt_linkage,
)
from goatlib.bundles.importers.pt_network.store import (
    TABLES_DIRNAME,
    build_store,
)
from goatlib.models.bundle import BundleArtifactKind
from goatlib.tasks.sync_base_data import installed_version, open_source, publish
from goatlib.tools.base import ToolSettings

logger = logging.getLogger(__name__)

__all__ = ["BuildPtNetworkParams", "BuildPtNetworkTask", "main"]

DATASET = "public_transport"


class BuildPtNetworkParams(BaseModel):
    """Where the feed is, and where its version goes."""

    source_url: str = Field(
        ...,
        description=(
            "Folder holding the combined feed: s3://bucket/prefix/ (with "
            "S3_ENDPOINT_URL and keys from the environment), https:// or file://."
        ),
    )
    source_file: str = Field(
        "gtfs_combined.zip", description="The feed's file name in that folder."
    )
    dest_url: str = Field(
        ...,
        description="The base data source to publish to, e.g. s3://goat-base-data/.",
    )
    version: Optional[str] = Field(
        None, description="The version's name. Empty = today's date (YYYY-MM-DD)."
    )
    channel: Optional[str] = Field(
        None,
        description=(
            "Point this channel (e.g. stable) at the new version. Empty = "
            "publish without moving any channel."
        ),
    )
    coverage_name: Optional[str] = Field(
        None, description="What the network covers, e.g. 'Germany and border regions'."
    )
    lineage: Optional[str] = Field(
        None, description="Where the feed comes from, for the bundles cut from it."
    )
    license: Optional[str] = Field(None, description="The feed's licence.")
    attribution: Optional[str] = Field(
        None, description="The attribution the feed requires."
    )


class BuildPtNetworkTask:
    """Builds the network's files and publishes them as one version."""

    def __init__(self: Self) -> None:
        self.settings: ToolSettings | None = None

    @staticmethod
    def _configure_logging_for_windmill() -> None:
        root_logger = logging.getLogger()
        root_logger.setLevel(logging.INFO)
        for handler in root_logger.handlers[:]:
            root_logger.removeHandler(handler)
        h = logging.StreamHandler(sys.stdout)
        h.setLevel(logging.INFO)
        h.setFormatter(logging.Formatter("%(name)s - %(levelname)s - %(message)s"))
        root_logger.addHandler(h)

    def init_from_env(self: Self) -> None:
        self._configure_logging_for_windmill()
        self.settings = ToolSettings.from_env()

    def _street_network_version(self: Self) -> Optional[str]:
        """The installed street network version the linkage is computed on;
        None for a network sync_base_data did not install."""
        assert self.settings is not None
        # .../street_network/edges -> the data dir that holds street_network.
        data_dir = Path(self.settings.street_network_edges_base_path).parent.parent
        return installed_version(data_dir, "street_network")

    @staticmethod
    def _coverage_bbox(tables: Path) -> list[float]:
        import duckdb

        con = duckdb.connect()
        try:
            row = con.execute(
                "SELECT min(stop_lon), min(stop_lat), max(stop_lon), max(stop_lat) "
                "FROM read_parquet(?)",
                [str(tables / "stops.parquet")],
            ).fetchone()
        finally:
            con.close()
        return [round(float(v), 4) for v in row]

    def build(self: Self, params: BuildPtNetworkParams, out: Path) -> Dict[str, Any]:
        """Build the version's files into ``out``; return what to publish with."""
        assert self.settings is not None
        pt_dir = out / "pt_network"
        pt_dir.mkdir(parents=True)
        with tempfile.TemporaryDirectory(prefix="goat_pt_build_") as workdir:
            feed = Path(workdir) / params.source_file
            logger.info("Fetching %s from %s", params.source_file, params.source_url)
            open_source(params.source_url).fetch(params.source_file, feed)

            # The bundle build itself, against the worker's global network.
            built = GtfsArtifactBuilder().build(
                source_path=str(feed),
                workdir=workdir,
                dependencies={
                    "street_network": {
                        "bundle_id": None,
                        "edge_path": self.settings.street_network_edges_base_path,
                        "node_path": self.settings.street_network_nodes_base_path,
                    }
                },
                options={"linkage_modes": list(DEFAULT_LINKAGE_MODES)},
            )
            failed = [f"{a.kind}: {a.error}" for a in built if a.error]
            if failed:
                raise RuntimeError("; ".join(failed))
            by_kind = {getattr(a.kind, "value", a.kind): a for a in built}
            timetable = by_kind[BundleArtifactKind.pt_network_graph.value]
            linkage = by_kind[BundleArtifactKind.pt_network_linkage.value]
            shutil.move(str(timetable.local_path), pt_dir / "gtfs.bin")
            for mode in DEFAULT_LINKAGE_MODES:
                table = unpack_pt_linkage(linkage.local_path, workdir, mode)
                shutil.move(table, pt_dir / linkage_member(mode))

            build_store(
                str(feed),
                str(pt_dir / TABLES_DIRNAME),
                lineage=params.lineage,
                license=params.license,
                attribution=params.attribution,
            )

        coverage: Dict[str, Any] = {
            "bbox": self._coverage_bbox(pt_dir / TABLES_DIRNAME)
        }
        if params.coverage_name:
            coverage["name"] = params.coverage_name
        requires = self._street_network_version()
        if requires is None:
            logger.warning(
                "The street network here was not installed by sync_base_data, so "
                "the version names none it requires."
            )
        return {
            "coverage": coverage,
            "requires": {"street_network": requires} if requires else None,
            "service": timetable.properties,
        }

    def run(self: Self, params: BuildPtNetworkParams) -> Dict[str, Any]:
        version = params.version or datetime.now(timezone.utc).strftime("%Y-%m-%d")
        with tempfile.TemporaryDirectory(prefix="goat_pt_version_") as out:
            stated = self.build(params, Path(out))
            published = publish(
                out,
                params.dest_url,
                dataset=DATASET,
                version=version,
                coverage=stated["coverage"],
                requires=stated["requires"],
                channel=params.channel,
            )
        logger.info("Published %s %s: %s", DATASET, version, published)
        return {
            "dataset": DATASET,
            "version": version,
            "requires": stated["requires"],
            "coverage": stated["coverage"],
            "service": stated["service"],
            **published,
        }


def main(params: BuildPtNetworkParams) -> Dict[str, Any]:
    """Windmill entry point."""
    task = BuildPtNetworkTask()
    task.init_from_env()
    return task.run(params)
