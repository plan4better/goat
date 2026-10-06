"""Task registry for background/maintenance tasks.

This module provides a registry of all background tasks that can be synced
to Windmill. Tasks are internal operations (not user-facing analytics).

Example:
    from goatlib.tasks.registry import TASK_REGISTRY, TaskDefinition

    for task in TASK_REGISTRY:
        print(f"{task.name}: {task.description}")
"""

from dataclasses import dataclass
from typing import TYPE_CHECKING, Self

if TYPE_CHECKING:
    from pydantic import BaseModel


@dataclass(frozen=True)
class TaskDefinition:
    """Definition of a background task for registration.

    Attributes:
        name: Short lowercase name used as task ID (e.g., "sync_pmtiles")
        display_name: Human-readable name (e.g., "Sync PMTiles")
        description: Short description for Windmill
        module_path: Python module path (e.g., "goatlib.tasks.sync_pmtiles")
        params_class_name: Name of the Params class in the module
        windmill_path: Windmill script path (e.g., "f/goat/tasks/sync_pmtiles")
        schedule: Optional cron schedule (e.g., "0 */6 * * *" for every 6 hours)
        enabled: Whether the schedule starts switched on. Only applied when the
            schedule is first created — a later sync leaves whatever state the
            Windmill UI is in, so turning one on there is not undone by the
            next sync.
        worker_tag: Windmill worker tag for job routing
    """

    name: str
    display_name: str
    description: str
    module_path: str
    params_class_name: str
    windmill_path: str
    schedule: str | None = None
    enabled: bool = True
    worker_tag: str = "tools"

    def get_params_class(self: Self) -> type["BaseModel"]:
        """Dynamically import and return the params class."""
        import importlib

        module = importlib.import_module(self.module_path)
        return getattr(module, self.params_class_name)


# Central registry of all background tasks
TASK_REGISTRY: tuple[TaskDefinition, ...] = (
    TaskDefinition(
        name="sync_pmtiles",
        display_name="Sync PMTiles",
        description="Synchronize PMTiles for all DuckLake geometry layers (sequential)",
        module_path="goatlib.tasks.sync_pmtiles",
        params_class_name="PMTilesSyncParams",
        windmill_path="f/goat/tasks/sync_pmtiles",
        schedule=None,  # Run manually
        worker_tag="tools",
    ),
    TaskDefinition(
        name="generate_thumbnails",
        display_name="Generate Thumbnails",
        description="Generate thumbnails for projects and layers that have been updated",
        module_path="goatlib.tasks.generate_thumbnails",
        params_class_name="ThumbnailTaskParams",
        windmill_path="f/goat/tasks/generate_thumbnails",
        schedule="0 */15 * * * *",  # Every 15 minutes (Windmill uses 6-field cron)
        worker_tag="print",  # Uses print worker with Playwright
    ),
    TaskDefinition(
        name="download_s3_folder",
        display_name="Download S3 Folder",
        description="Download a folder from S3 with resume support and validation",
        module_path="goatlib.tasks.download_s3_folder",
        params_class_name="DownloadS3FolderParams",
        windmill_path="f/goat/tasks/download_s3_folder",
        schedule=None,  # Run manually
        worker_tag="tools",
    ),
    TaskDefinition(
        name="rebuild_edited_pmtiles",
        display_name="Rebuild Edited PMTiles",
        description="Rebuild missing PMTiles for layers that were recently edited",
        module_path="goatlib.tasks.rebuild_edited_pmtiles",
        params_class_name="RebuildEditedPMTilesParams",
        windmill_path="f/goat/tasks/rebuild_edited_pmtiles",
        schedule="0 */5 * * * *",  # Every 5 minutes
        worker_tag="tools",
    ),
    TaskDefinition(
        name="ducklake_maintenance",
        display_name="DuckLake Maintenance",
        description=(
            "Expire old DuckLake snapshots and reclaim orphaned parquet "
            "files. Live-layer data is never touched."
        ),
        module_path="goatlib.tasks.ducklake_maintenance",
        params_class_name="DuckLakeMaintenanceParams",
        windmill_path="f/goat/tasks/ducklake_maintenance",
        schedule="0 0 0 * * *",  # Daily at 00:00 UTC
        worker_tag="tools",
    ),
    TaskDefinition(
        name="catalog_gc",
        display_name="Catalog GC",
        description=(
            "Delete promoted catalog layers with zero layer_project links "
            "(their parquet, PMTiles and layer row); a grace period covers "
            "the promote window and remove-then-readd."
        ),
        module_path="goatlib.tasks.catalog_gc",
        params_class_name="CatalogGCParams",
        windmill_path="f/goat/tasks/catalog_gc",
        schedule="0 0 3 * * *",  # Daily, 03:00
        worker_tag="tools",
    ),
    TaskDefinition(
        name="sync_catalog",
        display_name="Sync Catalog",
        description=(
            "Build the apps/catalog mirror from the published items.parquet "
            "+ collections.parquet on S3 into the shared data volume "
            "(ETag-skip when unchanged)."
        ),
        module_path="goatlib.tasks.sync_catalog",
        params_class_name="SyncCatalogParams",
        windmill_path="f/goat/tasks/sync_catalog",
        schedule="0 */5 * * * *",  # Every 5 minutes
        worker_tag="tools",
    ),
    TaskDefinition(
        name="sync_nuts",
        display_name="Sync NUTS",
        description=(
            "Build nuts.parquet from the Eurostat GISCO release into the "
            "shared data volume (apps/catalog's spatial filter). No schedule: "
            "NUTS releases every three years, run it when one lands."
        ),
        module_path="goatlib.tasks.sync_nuts",
        params_class_name="SyncNutsParams",
        windmill_path="f/goat/tasks/sync_nuts",
        worker_tag="tools",
    ),
    TaskDefinition(
        name="sync_geoip",
        display_name="Sync GeoIP Database",
        description=(
            "Refresh the DB-IP City Lite database in the shared data volume, "
            "which apps/core reads to open a new project near whoever created "
            "it. Checked often though DB-IP publishes monthly: a run that "
            "finds the current release already present downloads nothing, so "
            "the extra runs cost nothing."
        ),
        module_path="goatlib.tasks.sync_geoip",
        params_class_name="SyncGeoipParams",
        windmill_path="f/goat/tasks/sync_geoip",
        # 04:00 UTC on the 1st-3rd, then roughly weekly. DB-IP publishes on the
        # 1st, so the first three days catch a release within a day of it
        # landing; the rest are the net for a release that arrives late. Days
        # of the month rather than a weekday: Windmill's cron counts
        # day-of-week from 1=Sunday, so `0` is rejected and `7` quietly means
        # Saturday.
        schedule="0 0 4 1-3,8,15,22 * *",
        # Created switched off: the schedule is only useful where core actually
        # mounts the geo database, so switching it on is a deliberate act per
        # deployment rather than something a sync turns on everywhere.
        enabled=False,
        worker_tag="tools",
    ),
    TaskDefinition(
        name="sync_base_data",
        display_name="Sync Base Data",
        description=(
            "Install and update the street network, public transport network "
            "and other base data the routing tools read, from "
            "goat-base-data.plan4better.de or an internal mirror. Downloads "
            "only a new version, verifies it, then switches to it in one step."
        ),
        module_path="goatlib.tasks.sync_base_data",
        params_class_name="SyncBaseDataParams",
        windmill_path="f/goat/tasks/sync_base_data",
        # 03:00 UTC on Mondays (Windmill counts day-of-week from 1=Sunday). A
        # run that finds every data set current downloads nothing.
        schedule="0 0 3 * * 2",
        # Created switched off: which data sets, which region and which source
        # are per-deployment choices, and a first run can move tens of GB.
        enabled=False,
        worker_tag="tools",
    ),
    TaskDefinition(
        name="odoo_entitlement_push",
        display_name="Odoo Entitlement Push",
        description=(
            "Push subscription entitlements (quotas + extras) from Odoo to "
            "GOAT core. order_id > 0 = one subscription (webhook path); "
            "order_id = 0 = reconcile all pushable subscriptions."
        ),
        module_path="goatlib.tasks.odoo_entitlement",
        params_class_name="OdooEntitlementPushParams",
        windmill_path="f/goat/tasks/odoo_entitlement_push",
        # Nightly reconcile heals missed webhooks and serves as backfill.
        schedule="0 0 2 * * *",
        worker_tag="tools",
    ),
    TaskDefinition(
        name="trial_expiry",
        display_name="Trial Expiry",
        description=(
            "Enforce GOAT-managed trials: warn expiring organizations and "
            "suspend expired ones via core's trial webhook."
        ),
        module_path="goatlib.tasks.trial_expiry",
        params_class_name="TrialExpiryParams",
        windmill_path="f/goat/tasks/trial_expiry",
        schedule="0 0 3 * * *",
        worker_tag="tools",
    ),
    TaskDefinition(
        name="ducklake_compact",
        display_name="DuckLake Compaction",
        description=(
            "Merge small per-table parquets accumulated from incremental "
            "INSERTs (e.g., user feature edits). Live-layer data is "
            "rewritten in place, never lost."
        ),
        module_path="goatlib.tasks.ducklake_compact",
        params_class_name="DuckLakeCompactParams",
        windmill_path="f/goat/tasks/ducklake_compact",
        # 30 min after maintenance — gives ducklake_maintenance a clear
        # window to finish before compaction starts writing.
        schedule="0 30 0 * * *",
        worker_tag="tools",
    ),
    TaskDefinition(
        name="purge_trash",
        display_name="Purge Trash",
        description=(
            "Permanently delete folders, layers, templates, projects and "
            "bundles that have been in the trash past their retention "
            "period: DuckLake "
            "tables first, then the rows and their resource_grant rows, "
            "children before parents."
        ),
        module_path="goatlib.tasks.purge_trash",
        params_class_name="PurgeTrashParams",
        windmill_path="f/goat/tasks/purge_trash",
        schedule="0 0 3 * * *",  # Daily, 03:00
        worker_tag="tools",
    ),
    TaskDefinition(
        name="compute_rollup",
        display_name="Compute Rollup",
        description="Charge compute credits from completed Windmill tool jobs.",
        module_path="goatlib.tasks.compute_rollup",
        params_class_name="ComputeRollupParams",
        windmill_path="f/goat/tasks/compute_rollup",
        schedule="0 */5 * * * *",  # every 5 minutes
        worker_tag="tools",
    ),
    TaskDefinition(
        name="traffic_rollup",
        display_name="Traffic Rollup",
        description="Charge egress bytes per layer/service/project; refresh over-budget flags.",
        module_path="goatlib.tasks.traffic_rollup",
        params_class_name="TrafficRollupParams",
        windmill_path="f/goat/tasks/traffic_rollup",
        schedule="0 */5 * * * *",  # every 5 minutes
        worker_tag="tools",
    ),
    TaskDefinition(
        name="credit_reset",
        display_name="Credit Reset",
        description="Self-hosted period roll: zero used_credits, advance plan_renewal_date.",
        module_path="goatlib.tasks.credit_reset",
        params_class_name="CreditResetParams",
        windmill_path="f/goat/tasks/credit_reset",
        schedule="0 0 1 * * *",  # daily at 01:00 UTC
        worker_tag="tools",
    ),
)
