"""CLI tool to sync goatlib tasks to Windmill.

Usage:
    python -m goatlib.tasks.sync_windmill
    python -m goatlib.tasks.sync_windmill --url http://localhost:8110 --token xxx
    python -m goatlib.tasks.sync_windmill --dry-run
"""

import argparse
import logging
import os
import sys
from typing import Any, Self

import httpx

from goatlib.tasks.registry import TASK_REGISTRY, TaskDefinition
from goatlib.windmill_scripts import deploy_script, summarize

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)

# The fields Windmill's schedule update writes (EditSchedule, as of Windmill
# v1.751). It replaces each one it does not receive, so an update sends them all
# back. Check the list when upgrading Windmill.
SCHEDULE_UPDATE_FIELDS = (
    "args",
    "summary",
    "description",
    "on_failure",
    "on_failure_times",
    "on_failure_exact",
    "on_failure_extra_args",
    "on_recovery",
    "on_recovery_times",
    "on_recovery_extra_args",
    "on_success",
    "on_success_extra_args",
    "ws_error_handler_muted",
    "retry",
    "no_flow_overlap",
    "tag",
    "paused_until",
    "cron_version",
    "dynamic_skip",
    "labels",
)


def generate_task_script(task_def: TaskDefinition) -> str:
    """Generate a Windmill script for a task.

    Uses the same codegen as tools - expands Pydantic fields into primitive
    function arguments (str, int, bool, etc.) so Windmill can parse them
    without needing pydantic or goatlib installed on the server.
    """
    from goatlib.tools.codegen import generate_windmill_script

    params_class = task_def.get_params_class()
    return generate_windmill_script(
        module_path=task_def.module_path,
        params_class=params_class,
        excluded_fields=set(),  # Tasks don't have hidden fields like tools do
    )


class WindmillTaskSyncer:
    """Sync goatlib tasks to Windmill."""

    def __init__(
        self: Self,
        base_url: str,
        token: str,
        workspace: str = "goat",
    ) -> None:
        """Initialize syncer.

        Args:
            base_url: Windmill base URL (e.g., http://localhost:8110)
            token: Windmill API token
            workspace: Windmill workspace name
        """
        self.base_url = base_url.rstrip("/")
        self.token = token
        self.workspace = workspace
        self.client = httpx.Client(
            headers={"Authorization": f"Bearer {token}"},
            timeout=30.0,
        )

    def close(self: Self) -> None:
        """Close HTTP client."""
        self.client.close()

    def _create_or_update_schedule(
        self: Self, task_def: TaskDefinition
    ) -> dict[str, Any] | None:
        """Create or update schedule for a task if it has one defined."""
        if not task_def.schedule:
            return None

        schedule_path = f"f/goat/schedules/{task_def.name}"

        schedule_data = {
            "path": schedule_path,
            "schedule": task_def.schedule,
            "script_path": task_def.windmill_path,
            "is_flow": False,
            "args": {},  # Default args (empty = use defaults)
            "enabled": task_def.enabled,
            "timezone": "UTC",
        }

        try:
            # Check if schedule exists first
            check_response = self.client.get(
                f"{self.base_url}/api/w/{self.workspace}/schedules/get/{schedule_path}",
            )

            if check_response.status_code == 200:
                # Schedule exists: update its cron and nothing else. Whether
                # it runs, the arguments it runs with (a data mirror, a
                # bounding box), a pause, error handlers and retries are set
                # in the Windmill UI, and a sync must not reset them behind
                # whoever set them. The update never touches `enabled`.
                existing = check_response.json()
                if (
                    existing.get("schedule") == task_def.schedule
                    and existing.get("timezone") == "UTC"
                ):
                    # Unchanged. An update would also clear and re-queue the
                    # next run.
                    return {"path": schedule_path, "schedule": task_def.schedule}
                update = {
                    field: existing[field]
                    for field in SCHEDULE_UPDATE_FIELDS
                    if field in existing
                }
                update["args"] = existing.get("args") or {}
                update["schedule"] = task_def.schedule
                update["timezone"] = "UTC"
                # The update otherwise runs the schedule as whoever syncs it.
                if existing.get("permissioned_as"):
                    update["permissioned_as"] = existing["permissioned_as"]
                    update["preserve_permissioned_as"] = True
                response = self.client.post(
                    f"{self.base_url}/api/w/{self.workspace}/schedules/update/{schedule_path}",
                    json=update,
                )
                response.raise_for_status()
                if existing.get("permissioned_as"):
                    self._warn_if_run_as_changed(schedule_path, existing)
            else:
                # Create new schedule
                response = self.client.post(
                    f"{self.base_url}/api/w/{self.workspace}/schedules/create",
                    json=schedule_data,
                )
            response.raise_for_status()
            return {"path": schedule_path, "schedule": task_def.schedule}
        except Exception as e:
            logger.warning(f"Could not create schedule for {task_def.name}: {e}")
            return None

    def _warn_if_run_as_changed(
        self: Self, schedule_path: str, existing: dict[str, Any]
    ) -> None:
        """Windmill keeps a schedule's run-as user on update only for an admin
        token; otherwise the schedule now runs as the syncing user."""
        after = self.client.get(
            f"{self.base_url}/api/w/{self.workspace}/schedules/get/{schedule_path}",
        )
        if after.status_code != 200:
            return
        now = after.json().get("permissioned_as")
        if now != existing["permissioned_as"]:
            logger.warning(
                "Schedule %s now runs as %s instead of %s: the sync's token may "
                "not keep a schedule's user (it needs an admin)",
                schedule_path,
                now,
                existing["permissioned_as"],
            )

    def sync_task(
        self: Self, task_def: TaskDefinition, dry_run: bool = False
    ) -> dict[str, Any]:
        """Sync a single task to Windmill.

        Args:
            task_def: Task definition from registry
            dry_run: If True, don't actually sync

        Returns:
            Result dict with path and status
        """
        content = generate_task_script(task_def)

        if dry_run:
            logger.info(f"[DRY RUN] Would sync: {task_def.windmill_path}")
            if task_def.schedule:
                logger.info(f"[DRY RUN] Would create schedule: {task_def.schedule}")
            logger.debug(f"Generated script:\n{content}")
            return {"path": task_def.windmill_path, "status": "dry-run"}

        try:
            status = deploy_script(
                self.client,
                self.base_url,
                self.workspace,
                path=task_def.windmill_path,
                content=content,
                summary=task_def.display_name,
                description=task_def.description or "",
                tag=task_def.worker_tag,
            )
            result: dict[str, Any] = {"path": task_def.windmill_path, "status": status}
            logger.info(f"✓ {status.capitalize()}: {task_def.windmill_path}")

            # Create schedule if defined, for an unchanged script too: the
            # cron may have changed on its own.
            if task_def.schedule:
                schedule_result = self._create_or_update_schedule(task_def)
                if schedule_result:
                    logger.info(
                        f"✓ Schedule: {schedule_result['path']} "
                        f"({schedule_result['schedule']})"
                    )
                    result["schedule"] = schedule_result

            return result

        except Exception as e:
            logger.error(f"✗ Failed: {task_def.windmill_path} - {e}")
            return {
                "path": task_def.windmill_path,
                "status": "failed",
                "error": str(e),
            }

    def sync_all(self: Self, dry_run: bool = False) -> list[dict[str, Any]]:
        """Sync all tasks from registry.

        Args:
            dry_run: If True, don't actually sync

        Returns:
            List of result dicts
        """
        logger.info(f"Syncing {len(TASK_REGISTRY)} tasks to {self.base_url}")
        results = []

        for task_def in TASK_REGISTRY:
            result = self.sync_task(task_def, dry_run=dry_run)
            results.append(result)

        logger.info(summarize(results))

        return results


def build_parser() -> argparse.ArgumentParser:
    """CLI arguments; defaults come from the environment when this is called."""
    parser = argparse.ArgumentParser(
        description="Sync goatlib tasks to Windmill",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Environment variables:
  WINDMILL_URL        Windmill base URL (default: http://localhost:8110)
  WINDMILL_TOKEN      Windmill API token (required)
  WINDMILL_WORKSPACE  Windmill workspace (default: goat)

Examples:
  # Using environment variables
  export WINDMILL_TOKEN=xxx
  python -m goatlib.tasks.sync_windmill

  # Using command line args
  python -m goatlib.tasks.sync_windmill --url http://windmill:8000 --token xxx

  # Dry run to see what would be synced
  python -m goatlib.tasks.sync_windmill --dry-run

  # Sync specific task
  python -m goatlib.tasks.sync_windmill --task sync_pmtiles
""",
    )

    parser.add_argument(
        "--url",
        default=os.getenv("WINDMILL_URL", "http://localhost:8110"),
        help="Windmill base URL",
    )
    parser.add_argument(
        "--token",
        default=os.getenv("WINDMILL_TOKEN"),
        help="Windmill API token",
    )
    parser.add_argument(
        "--workspace",
        default=os.getenv("WINDMILL_WORKSPACE", "goat"),
        help="Windmill workspace",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Show what would be synced without making changes",
    )
    parser.add_argument(
        "--task",
        help="Sync only a specific task by name (e.g., sync_pmtiles)",
    )
    parser.add_argument(
        "--list",
        action="store_true",
        dest="list_tasks",
        help="List available tasks without syncing",
    )
    parser.add_argument(
        "-v",
        "--verbose",
        action="store_true",
        help="Enable verbose output",
    )

    return parser


def main() -> int:
    """CLI entry point."""
    args = build_parser().parse_args()

    if args.verbose:
        logging.getLogger().setLevel(logging.DEBUG)

    # List mode
    if args.list_tasks:
        print(f"\nAvailable tasks ({len(TASK_REGISTRY)}):\n")
        for task in TASK_REGISTRY:
            schedule_str = f" (schedule: {task.schedule})" if task.schedule else ""
            print(f"  {task.name:20} {task.windmill_path}{schedule_str}")
        return 0

    # Validate token
    if not args.token:
        logger.error(
            "WINDMILL_TOKEN is required. Set via --token or environment variable."
        )
        return 1

    syncer = WindmillTaskSyncer(
        base_url=args.url,
        token=args.token,
        workspace=args.workspace,
    )

    try:
        if args.task:
            # Find specific task
            task_def = next(
                (t for t in TASK_REGISTRY if t.name == args.task),
                None,
            )
            if not task_def:
                logger.error(f"Task not found: {args.task}")
                logger.info(
                    "Available tasks: " + ", ".join(t.name for t in TASK_REGISTRY)
                )
                return 1
            results = [syncer.sync_task(task_def, dry_run=args.dry_run)]
        else:
            results = syncer.sync_all(dry_run=args.dry_run)

        # Return non-zero if any failed
        failed = sum(1 for r in results if r["status"] == "failed")
        return 1 if failed else 0

    finally:
        syncer.close()


if __name__ == "__main__":
    sys.exit(main())
