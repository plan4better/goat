"""Building and storing a bundle's derived artifacts.

Shared by the import runner and the rebuild tool: an import builds artifacts
once from a fresh source, and a rebuild builds them again after someone edited a
member layer. Both read the same layers and write the same files, so the logic
lives here rather than in either caller.

Both record the ``layers_revision`` they built from, and publish only if it is
still current — a save landing mid-build queues its own rebuild, so this one's
output is already out of date. An import records it too: nothing can supersede a
bundle that did not exist yet, but a consumer refuses an artifact that cannot say
which layers it came from, so the provenance is not optional.
"""

import logging
import tempfile
from pathlib import Path
from typing import TYPE_CHECKING, Any, Dict, List, Optional, Tuple

from goatlib.bundles.artifacts import (
    ArtifactBuilderUnavailableError,
    ArtifactBuildFailedError,
    get_artifact_builder,
    store_artifact,
)
from goatlib.bundles.artifacts.storage import (
    build_token,
    delete_artifact_file,
    resolve_artifact,
)
from goatlib.bundles.artifacts.street_network import require_routing_network
from goatlib.models.bundle import (
    BundleArtifactBuildStatus,
    BundleArtifactKind,
    BundleArtifactState,
    BundleTypeName,
    BundleTypeSpec,
    artifact_state,
    get_spec,
)
from goatlib.tools.db import ToolDatabaseService

logger = logging.getLogger(__name__)


class BundleArtifactBuildMixin:
    """Export member layers and build the bundle type's artifacts from them.

    Mixed into a tool runner, and it uses four things the runner provides:
    ``settings``, ``duckdb_con``, ``get_layer_table_path`` and
    ``resolve_bundle_artifact`` (to read a dependency bundle's artifact).
    Declared here so the requirement is visible rather than only failing at
    runtime on a host that lacks them.
    """

    if TYPE_CHECKING:
        settings: Any
        duckdb_con: Any

        def get_layer_table_path(self, layer_id: str) -> str: ...

        def resolve_bundle_artifact(
            self, bundle_id: str, kind: str
        ) -> Tuple[str | None, BundleArtifactState | None]: ...

    def export_member_layers(
        self, *, user_id: str, members: List[Dict], workdir: str
    ) -> Dict[str, str]:
        """Role -> local parquet path for each member layer.

        Reads back out of DuckLake rather than reusing the files an importer
        wrote, so the import path exercises the same code a rebuild-after-edit
        does, and an edited layer is what gets built.

        Copies the table directly rather than going through
        ``export_layer_to_parquet``: that resolves the layer's owner with a
        nested ``run_until_complete``, which cannot work inside an already
        running event loop, and none of its filtering applies here. The owner
        is known from the bundle.
        """
        if not members:
            raise ValueError(
                "Cannot build a layer-based artifact without the member layers"
            )
        paths: Dict[str, str] = {}
        for member in members:
            role = member["role"]
            table = self.get_layer_table_path(str(member["layer_id"]))
            out = Path(workdir) / f"{role}.parquet"
            self.duckdb_con.execute(
                f"COPY (SELECT * FROM {table}) TO '{out}' (FORMAT PARQUET)"
            )
            paths[role] = str(out)
        logger.info("Exported %d member layer(s) for artifact build", len(paths))
        return paths

    async def _resolve_dependency_artifact(
        self,
        db: ToolDatabaseService,
        *,
        bundle_id: str,
        kind: str,
    ) -> "Tuple[str | None, BundleArtifactState | None]":
        """A dependency bundle's artifact, resolved the same way a tool's is.

        The async twin of ``BaseToolRunner.resolve_bundle_artifact``, and not a
        call to it: that one reads ``self.db_service``, which only the
        single-output ``run()`` lifecycle sets up, and resolves through a nested
        ``run_until_complete`` that cannot work inside the running loop a build
        lives in. Both together meant a perfectly ready street network resolved
        to nothing, and the build blamed the network for it.
        """
        row = await db.get_bundle_artifact(bundle_id, kind)
        if not row:
            return None, None
        state = artifact_state(
            row.get("build_status"),
            row.get("revision"),
            row["layers_revision"],
            row.get("storage_path"),
            bool(row.get("dependencies_current", True)),
        )
        if state is not BundleArtifactState.ready:
            return None, state
        resolved = resolve_artifact(self.settings.bundles_data_dir, row["storage_path"])
        if resolved is None:
            # Current and complete, but the file is gone. Rebuildable, so it
            # reads as a failed build rather than as something to build on.
            return None, BundleArtifactState.failed
        return str(resolved), state

    async def _resolve_dependencies(
        self,
        db: ToolDatabaseService,
        *,
        bundle_id: str,
        spec: BundleTypeSpec,
        workdir: str,
    ) -> Dict[str, Any]:
        """What this bundle's dependencies contribute to its build.

        Keyed by dependency kind, as the spec names it. Resolved here rather
        than in the builder, which stays off the database.

        An unlinked street network falls back to the default global network: a
        PT bundle is usable without one, and the stops still have to reach
        somewhere. A network that *is* linked but unusable does not fall back —
        that would compute the linkage against a different network than the one
        the bundle names, silently — so it is left absent and the builder
        reports the artifact as failed.
        """
        resolved: Dict[str, Any] = {}
        for dependency in spec.dependencies:
            if dependency.kind != "street_network":
                # The only kind with anything to contribute today. A new kind
                # adds its own branch rather than being guessed at.
                continue
            depends_on = await db.get_bundle_dependency(bundle_id, dependency.kind)
            if not depends_on:
                logger.info(
                    "Bundle %s has no %s linked; using the default network",
                    bundle_id,
                    dependency.kind,
                )
                resolved[dependency.kind] = {
                    "bundle_id": None,
                    "edge_path": self.settings.street_network_edges_base_path,
                    "node_path": self.settings.street_network_nodes_base_path,
                }
                continue
            try:
                edge_path, node_path = require_routing_network(
                    *await self._resolve_dependency_artifact(
                        db,
                        bundle_id=depends_on,
                        kind=BundleArtifactKind.street_network_graph.value,
                    ),
                    workdir,
                )
            except Exception as e:
                logger.warning(
                    "Street network %s unusable for bundle %s, so no linkage "
                    "will be built: %s",
                    depends_on,
                    bundle_id,
                    e,
                )
                continue
            resolved[dependency.kind] = {
                "bundle_id": depends_on,
                # Captured here, with the paths, so the provenance recorded on
                # the artifact is the revision the build actually read — not
                # whatever the dependency is at by the time it publishes.
                "revision": await db.get_bundle_revision(depends_on),
                "edge_path": edge_path,
                "node_path": node_path,
            }
        return resolved

    async def build_and_store_artifacts(
        self,
        db: ToolDatabaseService,
        *,
        bundle_id: str,
        bundle_type: "BundleTypeName | str",
        source_path: str,
        user_id: str,
        members: Optional[List[Dict]] = None,
        built_revision: Optional[int] = None,
        build_options: Optional[Dict[str, Any]] = None,
    ) -> bool:
        """Build and store the bundle type's derived artifacts (per spec).

        Each artifact is written to a temp file, moved onto the data volume, and
        recorded as a ``bundle_artifact`` row (building → ready). A build failure
        propagates so the caller marks the bundle failed; a missing toolchain is
        skipped with a warning (the import still completes).

        A builder that produces several kinds records each kind's outcome
        separately — which one failed and why — and then the build fails as a
        whole. Nothing is published half-built: the artifacts a bundle type
        declares are what makes a bundle of that type usable.

        ``build_options`` is passed through to the builder untouched (which
        access/egress modes to compute, say).

        Returns whether the artifacts were published. ``False`` means a later
        save superseded this build, which is not an error.
        """
        assert self.settings is not None
        spec = get_spec(bundle_type)
        builder = get_artifact_builder(bundle_type)
        if not spec.artifacts or builder is None:
            return True

        published = True
        # The revision the artifacts will claim, read BEFORE the build rather
        # than after it. Only a concurrent edit moves `layers_revision`, so
        # reading it afterwards would pick up that edit and claim output built
        # from the older layers came from the newer revision — which is exactly
        # the case the publish guard exists to reject, and it would sail
        # through. Read here, a build overtaken mid-flight is correctly refused.
        # (A caller that read the revision before starting passes it in; this
        # only fills in for callers that do not, like an import.)
        revision = (
            built_revision
            if built_revision is not None
            else await db.get_bundle_revision(bundle_id)
        )
        with tempfile.TemporaryDirectory() as workdir:
            try:
                # A builder reads either the uploaded source (GTFS: the feed is
                # the truth) or the member layers (street networks: the layers
                # are, so an edited layer is what a rebuild must pick up).
                dependencies: Dict[str, Any] = {}
                if builder.builds_from_layers:
                    layer_paths = self.export_member_layers(
                        user_id=user_id, members=members or [], workdir=workdir
                    )
                    built = builder.build_from_layers(
                        layer_paths=layer_paths, workdir=workdir
                    )
                else:
                    dependencies = await self._resolve_dependencies(
                        db, bundle_id=bundle_id, spec=spec, workdir=workdir
                    )
                    built = builder.build(
                        source_path=source_path,
                        workdir=workdir,
                        dependencies=dependencies,
                        options=build_options,
                    )
            except ArtifactBuilderUnavailableError as e:
                logger.warning(
                    "Skipping artifact build for bundle %s: %s", bundle_id, e
                )
                return True
            except Exception:
                # The build died before reaching any artifact row. Mark them
                # failed so consumers report "the last update failed — update
                # it from the bundle" instead of promising an update that is
                # not running. (On an import no rows exist yet, so this is a
                # no-op and the caller's bundle-failed handling takes over.)
                await db.mark_bundle_artifacts_failed(bundle_id, revision)
                raise

            failures: List[str] = []
            for art in built:
                kind_value = getattr(art.kind, "value", art.kind)
                artifact_id = await db.create_artifact(
                    bundle_id=bundle_id,
                    kind=kind_value,
                    build_status=BundleArtifactBuildStatus.building,
                    built_revision=revision,
                )
                if art.error:
                    # Recorded per kind, so a bundle that survives this build (a
                    # rebuild does; an import does not) says which artifact is
                    # missing and why. The build as a whole still fails, after
                    # the loop has recorded every outcome.
                    await db.set_artifact_build_status(
                        artifact_id=artifact_id,
                        status=BundleArtifactBuildStatus.failed,
                        built_revision=revision,
                    )
                    logger.warning(
                        "Artifact %s for bundle %s not built: %s",
                        kind_value,
                        bundle_id,
                        art.error,
                    )
                    failures.append(f"{kind_value}: {art.error}")
                    continue
                # Guaranteed by BuiltArtifact: an entry with no error has a
                # path. Bound here so the rest of the loop reads as a file.
                local_path = art.local_path or ""
                storage_path = None
                try:
                    # Keep the built file's extension: a PT timetable is a
                    # .bin, a street network graph is a .tar of two parquet
                    # files, and the consumer dispatches on it.
                    suffix = Path(local_path).suffix or ".bin"
                    storage_path = store_artifact(
                        local_path,
                        bundles_data_dir=self.settings.bundles_data_dir,
                        bundle_id=bundle_id,
                        kind=kind_value,
                        suffix=suffix,
                        revision=revision,
                        token=build_token(),
                    )
                    current, displaced = await db.publish_artifact_if_current(
                        artifact_id=artifact_id,
                        bundle_id=bundle_id,
                        built_revision=revision,
                        storage_path=storage_path,
                        size=art.size,
                        properties=art.properties,
                    )
                    if not current:
                        # A save landed while this built, so the rebuild that
                        # save queued is the one that will publish. This build's
                        # row keeps the previous artifact's path and revision —
                        # only the attempt is recorded — and its own file goes,
                        # since nothing points at it.
                        published = False
                        await db.set_artifact_build_status(
                            artifact_id=artifact_id,
                            status=BundleArtifactBuildStatus.failed,
                            built_revision=revision,
                        )
                        delete_artifact_file(
                            self.settings.bundles_data_dir, storage_path
                        )
                        logger.info(
                            "Discarding superseded %s build for bundle %s "
                            "(built from revision %d)",
                            kind_value,
                            bundle_id,
                            revision,
                        )
                        continue
                    if displaced:
                        delete_artifact_file(self.settings.bundles_data_dir, displaced)
                    logger.info(
                        "Artifact %s for bundle %s stored at %s (%d bytes)",
                        kind_value,
                        bundle_id,
                        storage_path,
                        art.size,
                    )
                except Exception:
                    await db.set_artifact_build_status(
                        artifact_id=artifact_id,
                        status=BundleArtifactBuildStatus.failed,
                        built_revision=revision,
                    )
                    if storage_path:
                        delete_artifact_file(
                            self.settings.bundles_data_dir, storage_path
                        )
                    raise

            if failures:
                # After the loop, so every kind's outcome is on record first.
                # A bundle short of an artifact its type declares is not a
                # usable bundle, and an import that returned success would
                # leave that to be discovered by whoever ran the first tool.
                raise ArtifactBuildFailedError("; ".join(failures))

            # Every artifact published, so the dependency rows can say which
            # revision of each dependency these files were derived from. After
            # the failure check: a build that did not publish has not been
            # built from anything, and claiming otherwise would hide the
            # staleness this records.
            for kind, resolved in dependencies.items():
                if resolved.get("bundle_id") is None:
                    # The default network. Nothing identifies a revision of it,
                    # and no dependency row points at it.
                    continue
                await db.set_dependency_built_revision(
                    bundle_id, kind, int(resolved["revision"])
                )

        return published
