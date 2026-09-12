"""GTFS artifact builders: the routable PT timetable and its street linkage.

Two artifacts, from two different inputs:

``pt_network_graph`` is the nigiri ``.bin``, built by ``build_timetable`` from
the feed alone — footpaths between stops are generated from stop coordinates,
so no street network is involved. The date window comes from the feed's
calendar span.

``pt_network_linkage`` is the access/egress lookup: for every served stop, the
H3 res-9 cells reachable within a walking (or cycling, driving) budget and the
cost in minutes. That *is* a street-network computation — it is what connects a
front door to a boarding stop — so it needs both the timetable (which defines
the stop set) and the street network bundle this one depends on. One parquet per
mode, tarred together because a bundle holds one artifact row per kind.

The two are reported separately, so a build says which of them failed and why —
but either failing fails the build: a public-transport bundle without its
linkage cannot answer an accessibility question, so it is not one worth keeping.
"""

import csv
import io
import logging
import os
import shutil
import tarfile
import zipfile
from datetime import date
from pathlib import Path
from typing import Any, Dict, List, Sequence, Tuple

from goatlib.bundles.artifacts.base import (
    ArtifactBuilder,
    ArtifactBuilderUnavailableError,
    ArtifactSource,
    BuiltArtifact,
)
from goatlib.models.bundle import (
    BundleArtifactKind,
    BundleArtifactState,
    BundleTypeName,
)

logger = logging.getLogger(__name__)

_MAX_DAYS = 365

#: H3 resolution the access/egress tables are binned at. Fixed by the routing
#: engine's egress lookup, and mirrored in the analysis layer's
#: ``_PT_ACCESSEGRESS_RES`` — the two must agree or a lookup misses every cell.
LINKAGE_RESOLUTION = 9

#: Modes a PT leg can be made in, each with its own table. PT itself is never an
#: access/egress mode. Mirrors ``_PT_ACCESSEGRESS_MODES`` in the analysis layer.
LINKAGE_MODES: Tuple[str, ...] = ("walking", "bicycle", "pedelec", "car")

#: What an import computes. Walking is what the global network ships and what
#: every PT tool defaults to; the others cost a full network sweep each, so they
#: are opt-in through the build options rather than paid for on every import.
DEFAULT_LINKAGE_MODES: Tuple[str, ...] = ("walking",)

#: Reachability budget baked into a table, in minutes. A tool may cap lower at
#: request time but never higher, so this is the ceiling for access and egress
#: legs. Matches the global tables' 20.
LINKAGE_MAX_MINUTES = 20.0


class UnlinkableStopsError(ValueError):
    """No stop in the feed could be reached from the linked street network.

    Its own type so the import path can tell it from the ordinary reasons a
    linkage does not build (nothing linked yet, a graph still building): those
    leave the timetable published and the artifact marked failed, while this one
    fails the whole import. A public-transport bundle whose stops connect to no
    street cannot answer a single accessibility question — publishing it would
    mean every tool that used it returned empty results with nothing to explain
    why.
    """


def _linkage_rows(table: Path) -> int:
    """Rows in one mode's access/egress table — stop/cell pairs found.

    Read with DuckDB rather than pyarrow: it is already a dependency of the
    street-network builder next door, and this only needs a count.
    """
    import duckdb

    con = duckdb.connect()
    try:
        # Interpolated, not bound: the path is this build's own — a temp workdir
        # plus `linkage_member` of a mode already checked against
        # `LINKAGE_MODES` — so nothing here comes from a request.
        row = con.execute(f"SELECT count(*) FROM read_parquet('{table}')").fetchone()
        return int(row[0]) if row else 0
    finally:
        con.close()


def linkage_member(mode: str) -> str:
    """Tar member name for one mode's table.

    The same ``accessegress_{mode}_r{res}.parquet`` the global network uses, so
    a bundle's table and the global one are interchangeable by name and a human
    reading either directory sees the same thing.
    """
    return f"accessegress_{mode}_r{LINKAGE_RESOLUTION}.parquet"


def _root_level_feed(source_path: str, workdir: str) -> str:
    """A path to the same feed with its files at the archive root.

    nigiri looks for the GTFS files at the root of the archive and refuses one
    where they sit in a folder — which is exactly what compressing a directory
    produces, and how a fair number of agencies publish. Every file is present
    and the feed is perfectly good, so it is repackaged rather than refused; the
    alternative is telling the person who uploaded it to re-zip it, for a
    difference nothing downstream cares about.

    Only a single shared top-level directory is flattened. An archive that is
    already flat, or that holds more than one feed, is handed back untouched —
    guessing which of several directories was meant would be worse than letting
    the loader say it cannot read this one.

    Members are streamed rather than read whole: `stop_times.txt` alone runs to
    hundreds of MB on a city feed.
    """
    with zipfile.ZipFile(source_path) as src:
        members = [
            info
            for info in src.infolist()
            if not info.is_dir()
            and not info.filename.startswith("__MACOSX/")
            and os.path.basename(info.filename) not in ("", ".DS_Store")
        ]
        if not members:
            return source_path
        prefixes = {m.filename.split("/")[0] for m in members if "/" in m.filename}
        flat = [m for m in members if "/" not in m.filename]
        if flat or len(prefixes) != 1:
            # Already at the root, or ambiguous — either way, not ours to fix.
            return source_path

        prefix = f"{prefixes.pop()}/"
        out_path = os.path.join(workdir, "gtfs_root.zip")
        logger.info(
            "GTFS files live under %r; repackaging %d of them at the archive "
            "root so the timetable loader can read the feed",
            prefix,
            len(members),
        )
        with zipfile.ZipFile(out_path, "w", zipfile.ZIP_DEFLATED) as dst:
            for info in members:
                name = info.filename[len(prefix) :]
                if not name:
                    continue
                with src.open(info) as fsrc, dst.open(name, "w") as fdst:
                    shutil.copyfileobj(fsrc, fdst)
    return out_path


class GtfsArtifactBuilder(ArtifactBuilder):
    bundle_type = BundleTypeName.pt_network_gtfs
    produces = (
        BundleArtifactKind.pt_network_graph,
        BundleArtifactKind.pt_network_linkage,
    )

    def build(
        self,
        *,
        source_path: str,
        workdir: str,
        dependencies: Dict[str, Any] | None = None,
        options: Dict[str, Any] | None = None,
    ) -> List[BuiltArtifact]:
        try:
            import routing
        except Exception as e:  # pragma: no cover - env-dependent
            raise ArtifactBuilderUnavailableError(
                f"routing package is not importable: {e}"
            )
        if not hasattr(routing, "build_timetable"):
            raise ArtifactBuilderUnavailableError(
                "routing.build_timetable is unavailable — the routing extension "
                "needs rebuilding with the timetable-build binding"
            )

        start_date, length_days = self._date_window(source_path)
        feed_path = _root_level_feed(source_path, workdir)
        out_path = os.path.join(workdir, "pt_network_graph.bin")
        logger.info(
            "Building GTFS timetable .bin (start=%s, length=%dd) from %s",
            start_date,
            length_days,
            source_path,
        )
        routing.build_timetable(feed_path, out_path, start_date, length_days)
        timetable = BuiltArtifact(
            kind=BundleArtifactKind.pt_network_graph,
            local_path=out_path,
            size=os.path.getsize(out_path),
            # The window the timetable was built for. Outside it every journey
            # comes back "no service", and the feed it was derived from is not
            # kept — so if this build does not write it down, nothing can ask
            # again. It is what bounds a date offered against this bundle.
            properties={
                "service_start": start_date,
                "service_days": length_days,
            },
        )

        # Built second and reported separately: it needs the timetable that was
        # just written (for the stop set) plus a street network from another
        # bundle, and only the second of those can be absent.
        modes = self._requested_modes(options)
        linkage = self._build_linkage(
            timetable_path=out_path,
            workdir=workdir,
            dependencies=dependencies or {},
            modes=modes,
        )
        return [timetable, linkage]

    @staticmethod
    def _requested_modes(options: Dict[str, Any] | None) -> Tuple[str, ...]:
        """Modes to compute a linkage table for, defaulting to walking alone."""
        requested = (options or {}).get("linkage_modes")
        if not requested:
            return DEFAULT_LINKAGE_MODES
        return tuple(dict.fromkeys(str(mode) for mode in requested))

    def _build_linkage(
        self,
        *,
        timetable_path: str,
        workdir: str,
        dependencies: Dict[str, Any],
        modes: Sequence[str],
    ) -> BuiltArtifact:
        """One access/egress table per mode, tarred.

        Returns a failed ``BuiltArtifact`` rather than raising, so the caller
        records *which* kind failed before failing the build — the reasons this
        can fail (the linked network's graph not ready, the extension not
        rebuilt) are things a user fixes and retries, and the message is what
        tells them which.
        """
        kind = BundleArtifactKind.pt_network_linkage

        unknown = [mode for mode in modes if mode not in LINKAGE_MODES]
        if unknown:
            return BuiltArtifact(
                kind=kind,
                error=(
                    f"Not access/egress modes: {', '.join(unknown)}. "
                    f"Expected any of {', '.join(LINKAGE_MODES)}."
                ),
            )

        # The caller supplies the default network when nothing is linked, so an
        # absent entry means a network *is* linked and is not usable — never
        # substituted for, since that would quietly compute the linkage against
        # a different network than the bundle names.
        street = dependencies.get("street_network") or {}
        edge_path = street.get("edge_path")
        node_path = street.get("node_path")
        if not edge_path or not node_path:
            return BuiltArtifact(
                kind=kind,
                error=(
                    "The linked street network is not ready to route on. "
                    "Update it, then update this bundle."
                ),
            )

        import routing

        if not hasattr(routing, "build_access_egress_table"):
            # Not ArtifactBuilderUnavailableError: that abandons every artifact
            # of the build, and the timetable is already written.
            return BuiltArtifact(
                kind=kind,
                error=(
                    "routing.build_access_egress_table is unavailable — the "
                    "routing extension needs rebuilding with the "
                    "access/egress binding."
                ),
            )

        engine_mode = {
            "walking": routing.RoutingMode.Walking,
            "bicycle": routing.RoutingMode.Bicycle,
            "pedelec": routing.RoutingMode.Pedelec,
            "car": routing.RoutingMode.Car,
        }
        out_dir = Path(workdir) / "pt_network_linkage"
        out_dir.mkdir(parents=True, exist_ok=True)

        members: List[Path] = []
        for mode in modes:
            member = out_dir / linkage_member(mode)
            cfg = routing.AccessEgressConfig()
            cfg.timetable_path = timetable_path
            cfg.edge_dir = str(edge_path)
            cfg.node_dir = str(node_path)
            cfg.output_path = str(member)
            cfg.mode = engine_mode[mode]
            cfg.max_min = LINKAGE_MAX_MINUTES
            logger.info(
                "Building %s access/egress table (max %.0f min) for %s",
                mode,
                LINKAGE_MAX_MINUTES,
                timetable_path,
            )
            try:
                routing.build_access_egress_table(cfg)
            except Exception as e:
                return BuiltArtifact(
                    kind=kind,
                    error=f"Could not build the {mode} stop-to-street linkage: {e}",
                )
            if not member.exists():
                return BuiltArtifact(
                    kind=kind,
                    error=(
                        f"The {mode} stop-to-street linkage reported success "
                        "but wrote no table."
                    ),
                )
            reached = _linkage_rows(member)
            if reached == 0:
                # Raised, not reported as a failed artifact: an empty table is
                # not a stage that failed but a pairing that cannot work, and
                # the bundle it would belong to is unusable for transit. The
                # caller fails the import, which deletes the half-built bundle
                # and leaves the user free to import again against the right
                # network.
                raise UnlinkableStopsError(
                    "No stops could be connected to the linked street network. "
                    "It likely covers a different region — link one that "
                    "covers this feed's area."
                )
            logger.info("%s linkage: %d stop/cell pair(s)", mode, reached)
            members.append(member)

        archive = Path(workdir) / "pt_network_linkage.tar"
        with tarfile.open(archive, "w") as tar:
            # Flat names, so extracting yields a folder of per-mode parquets —
            # the same layout as the global network directory.
            for member in members:
                tar.add(member, arcname=member.name)

        size = archive.stat().st_size
        logger.info(
            "Built PT linkage for %d mode(s): %.1f MB", len(members), size / 1e6
        )
        return BuiltArtifact(kind=kind, local_path=str(archive), size=size)

    @staticmethod
    def _date_window(source_path: str) -> Tuple[str, int]:
        """Derive ``(start_date "YYYY-MM-DD", length_days)`` from the feed's
        calendar, clamped to <= 1 year. Falls back to ``today + 365d`` when the
        feed has no parseable service dates."""
        raw: List[str] = []
        try:
            with zipfile.ZipFile(source_path) as zf:
                names = {os.path.basename(n): n for n in zf.namelist()}
                if "calendar.txt" in names:
                    with zf.open(names["calendar.txt"]) as fh:
                        for row in csv.DictReader(io.TextIOWrapper(fh, "utf-8-sig")):
                            for col in ("start_date", "end_date"):
                                raw.append((row.get(col) or "").strip())
                if "calendar_dates.txt" in names:
                    with zf.open(names["calendar_dates.txt"]) as fh:
                        for row in csv.DictReader(io.TextIOWrapper(fh, "utf-8-sig")):
                            raw.append((row.get("date") or "").strip())
        except Exception as e:
            logger.warning("Could not read GTFS calendar for date window: %s", e)

        parsed = sorted({v for v in raw if len(v) == 8 and v.isdigit()})
        for lo, hi in ((parsed[0], parsed[-1]),) if parsed else ():
            try:
                start = date(int(lo[:4]), int(lo[4:6]), int(lo[6:8]))
                end = date(int(hi[:4]), int(hi[4:6]), int(hi[6:8]))
                length = (end - start).days + 1
                if length >= 1:
                    return start.isoformat(), min(length, _MAX_DAYS)
            except ValueError as e:
                logger.warning("Invalid GTFS service dates (%s..%s): %s", lo, hi, e)

        return date.today().isoformat(), _MAX_DAYS


def unpack_pt_linkage(archive: str | Path, dest_dir: str | Path, mode: str) -> str:
    """Extract a linkage artifact and return one mode's table path.

    Every mode in the archive is extracted — they are small next to the cost of
    reading the tar twice — but only the requested one is named, since the
    engine loads one access table and one egress table per request.
    """
    linkage_dir = Path(dest_dir) / "pt_network_linkage"
    table = linkage_dir / linkage_member(mode)
    # Extracted once per destination: a run asks for an access table and an
    # egress table from the same archive, and the first call already unpacked
    # every mode into this directory.
    if not table.exists():
        linkage_dir.mkdir(parents=True, exist_ok=True)
        with tarfile.open(archive) as tar:
            # filter="data" refuses members with absolute or parent-relative
            # paths. We wrote this tar, but it is read back off a shared
            # volume, so the bytes are not necessarily the ones we wrote.
            tar.extractall(linkage_dir, filter="data")

    if not table.exists():
        available = sorted(
            path.name.removeprefix("accessegress_").removesuffix(
                f"_r{LINKAGE_RESOLUTION}.parquet"
            )
            for path in linkage_dir.glob("accessegress_*.parquet")
        )
        raise ValueError(
            f"This public-transport bundle has no {mode} stop-to-street "
            "linkage. It was built for "
            + (", ".join(available) if available else "no modes")
            + ". Update the bundle with this mode included, or pick another."
        )
    return str(table)


def fetch_pt_linkage(
    source: ArtifactSource, bundle_id: str, mode: str, dest_dir: str | Path
) -> str:
    """Fetch and unpack one mode's access/egress table for a PT bundle.

    The counterpart of ``fetch_pt_timetable`` for the linkage. Never falls back
    to the global network's table: that one is binned against a different street
    network and a different stop set, so its ``stop_idx`` values would index
    into this bundle's timetable as nonsense.
    """
    archive, state = source.resolve_bundle_artifact(
        bundle_id, BundleArtifactKind.pt_network_linkage.value
    )
    if not archive:
        refusal: Dict[BundleArtifactState | None, str] = {
            BundleArtifactState.outdated: (
                "This public-transport bundle's stop-to-street linkage is being "
                "rebuilt. Try again once it finishes."
            ),
            BundleArtifactState.building: (
                "This public-transport bundle's stop-to-street linkage is still "
                "being prepared. Try again shortly."
            ),
            BundleArtifactState.failed: (
                "This public-transport bundle has no usable stop-to-street "
                "linkage — its last build failed. Check that a street network "
                "is linked, then update the bundle."
            ),
        }
        raise ValueError(
            refusal.get(
                state,
                "The selected public-transport bundle has no stop-to-street "
                "linkage yet, so it cannot be used for access and egress legs.",
            )
        )
    return unpack_pt_linkage(archive, dest_dir, mode)


def fetch_pt_timetable(source: ArtifactSource, bundle_id: str) -> str:
    """Path to a PT bundle's timetable, for any tool that routes on transit.

    The counterpart of ``fetch_routing_network``: one call, and the caller needs
    no knowledge of the artifact's packaging. A timetable is a single ``.bin``,
    so unlike a street graph there is nothing to unpack — the path is the stored
    file on the data volume and must be treated as read-only.
    """
    timetable, state = source.resolve_bundle_artifact(
        bundle_id, BundleArtifactKind.pt_network_graph.value
    )
    if not timetable:
        # The state separates "not ready yet" from "was ready until the feed was
        # replaced", which are different things to tell a user. None means no
        # build has been attempted.
        refusal: Dict[BundleArtifactState | None, str] = {
            BundleArtifactState.outdated: (
                "This public-transport bundle is being updated. Try again once "
                "it finishes."
            ),
            BundleArtifactState.building: (
                "This public-transport network is still being prepared. Try "
                "again shortly."
            ),
            BundleArtifactState.failed: (
                "This public-transport bundle's last update failed. Update it "
                "from the bundle before using it."
            ),
        }
        raise ValueError(
            refusal.get(
                state,
                "The selected public-transport bundle is not ready to route on " "yet.",
            )
        )
    return timetable
