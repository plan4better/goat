"""Windmill client for job execution.

This module provides an async wrapper around the official Windmill Python SDK
to execute scripts and manage jobs from FastAPI async handlers.

Windmill Python SDK: https://www.windmill.dev/docs/advanced/clients/python_client
"""

import asyncio
import logging
from functools import partial
from typing import Any, Literal

from goatlib.workflows.run_errors import error_message
from wmill import Windmill

from processes.config import settings

logger = logging.getLogger(__name__)

# Job status type from Windmill SDK
JobStatus = Literal["RUNNING", "WAITING", "COMPLETED"]


class WindmillError(Exception):
    """Base exception for Windmill client errors."""

    pass


class WindmillJobNotFound(WindmillError):
    """Job not found in Windmill."""

    pass


class WindmillClient:
    """Async wrapper around the official Windmill Python SDK.

    The official wmill SDK is synchronous, so we wrap calls in asyncio.to_thread()
    for compatibility with FastAPI's async handlers.
    """

    def __init__(self):
        """Initialize Windmill client."""
        self._client: Windmill | None = None

    def _get_client(self) -> Windmill:
        """Get or create the Windmill client (lazy initialization)."""
        if self._client is None:
            self._client = Windmill(
                base_url=settings.WINDMILL_URL,
                token=settings.WINDMILL_TOKEN,
                workspace=settings.WINDMILL_WORKSPACE,
            )
        return self._client

    async def _run_sync(self, func, *args, **kwargs) -> Any:
        """Run a synchronous function in a thread pool."""
        return await asyncio.to_thread(partial(func, *args, **kwargs))

    async def run_script_async(
        self,
        script_path: str,
        args: dict[str, Any],
        scheduled_in_secs: int | None = None,
    ) -> str:
        """Run a script asynchronously and return job ID.

        Args:
            script_path: Path to the script (e.g., "f/goat/clip")
            args: Script arguments/inputs
            scheduled_in_secs: Optional delay before execution

        Returns:
            Job ID (UUID string)

        Raises:
            WindmillError: If script execution fails

        Note:
            Worker tags are configured on the script itself during sync,
            not per-job. See create_or_update_script().
        """
        client = self._get_client()

        logger.info(f"Submitting job for script {script_path}")

        try:
            # Build params for the Windmill API
            params: dict[str, Any] = {}
            if scheduled_in_secs:
                params["scheduled_in_secs"] = scheduled_in_secs

            # Use low-level post for consistency
            endpoint = f"/w/{client.workspace}/jobs/run/p/{script_path}"
            response = client.post(
                endpoint, json=args, params=params if params else None
            )
            job_id = response.text

            logger.info(f"Job submitted successfully: {job_id} (script: {script_path})")
            return job_id

        except Exception as e:
            logger.error(f"Error submitting job: {e}")
            raise WindmillError(f"Failed to submit job: {e}") from e

    async def get_variable(self, path: str) -> str | None:
        """Get a Windmill workspace variable value by path.

        Args:
            path: Variable path (e.g. "f/goat/config/beta_user_email_domains")

        Returns:
            The variable value, or None if the variable does not exist.

        Raises:
            WindmillError: If the API call fails for a reason other than
                the variable being absent.
        """
        client = self._get_client()

        try:
            return await self._run_sync(client.get_variable, path)
        except Exception as e:
            error_msg = str(e).lower()
            if "not found" in error_msg or "404" in error_msg:
                logger.info(f"Windmill variable not found: {path}")
                return None
            logger.error(f"Error getting Windmill variable {path}: {e}")
            raise WindmillError(f"Failed to get variable {path}: {e}") from e

    async def get_job_status(self, job_id: str) -> dict[str, Any]:
        """Get job details from Windmill.

        Args:
            job_id: Windmill job ID

        Returns:
            Job details dict from Windmill API

        Raises:
            WindmillJobNotFound: If job doesn't exist
            WindmillError: If API call fails
        """
        client = self._get_client()

        try:
            job = await self._run_sync(client.get_job, job_id)
            return job

        except Exception as e:
            error_msg = str(e).lower()
            if "not found" in error_msg or "404" in error_msg:
                raise WindmillJobNotFound(f"Job not found: {job_id}") from e
            logger.error(f"Error getting job status: {e}")
            raise WindmillError(f"Failed to get job status: {e}") from e

    async def get_job_status_simple(self, job_id: str) -> JobStatus:
        """Get simple job status (RUNNING, WAITING, or COMPLETED).

        Args:
            job_id: Windmill job ID

        Returns:
            Job status literal

        Raises:
            WindmillJobNotFound: If job doesn't exist
            WindmillError: If API call fails
        """
        client = self._get_client()

        try:
            status = await self._run_sync(client.get_job_status, job_id)
            return status

        except Exception as e:
            error_msg = str(e).lower()
            if "not found" in error_msg or "404" in error_msg:
                raise WindmillJobNotFound(f"Job not found: {job_id}") from e
            logger.error(f"Error getting job status: {e}")
            raise WindmillError(f"Failed to get job status: {e}") from e

    async def get_job_result(self, job_id: str) -> Any:
        """Get job result from Windmill.

        Args:
            job_id: Windmill job ID

        Returns:
            Job result (dict, list, or primitive)

        Raises:
            WindmillJobNotFound: If job doesn't exist
            WindmillError: If job hasn't completed or API call fails
        """
        client = self._get_client()

        try:
            result = await self._run_sync(
                client.get_result,
                job_id,
                assert_result_is_not_none=False,
            )
            return result

        except Exception as e:
            error_msg = str(e).lower()
            if "not found" in error_msg or "404" in error_msg:
                raise WindmillJobNotFound(f"Job not found: {job_id}") from e
            logger.error(f"Error getting job result: {e}")
            raise WindmillError(f"Failed to get job result: {e}") from e

    async def wait_for_job(
        self,
        job_id: str,
        timeout: float | None = None,
        verbose: bool = False,
    ) -> Any:
        """Wait for a job to complete and return its result.

        Args:
            job_id: Windmill job ID
            timeout: Optional timeout in seconds
            verbose: Whether to print progress

        Returns:
            Job result

        Raises:
            WindmillJobNotFound: If job doesn't exist
            WindmillError: If API call fails or timeout
        """
        client = self._get_client()

        try:
            result = await self._run_sync(
                client.wait_job,
                job_id,
                timeout=timeout,
                verbose=verbose,
                assert_result_is_not_none=False,
            )
            return result

        except Exception as e:
            error_msg = str(e).lower()
            if "not found" in error_msg or "404" in error_msg:
                raise WindmillJobNotFound(f"Job not found: {job_id}") from e
            logger.error(f"Error waiting for job: {e}")
            raise WindmillError(f"Failed to wait for job: {e}") from e

    async def cancel_job(
        self, job_id: str, reason: str = "User requested cancellation"
    ) -> str:
        """Cancel a running job.

        Args:
            job_id: Windmill job ID
            reason: Cancellation reason

        Returns:
            Response message from Windmill

        Raises:
            WindmillJobNotFound: If job doesn't exist
            WindmillError: If API call fails
        """
        client = self._get_client()

        try:
            response = await self._run_sync(client.cancel_job, job_id, reason)
            logger.info(f"Job {job_id} cancelled: {reason}")
            return response

        except Exception as e:
            error_msg = str(e).lower()
            if "not found" in error_msg or "404" in error_msg:
                raise WindmillJobNotFound(f"Job not found: {job_id}") from e
            logger.error(f"Error cancelling job: {e}")
            raise WindmillError(f"Failed to cancel job: {e}") from e

    async def run_script_sync(
        self,
        script_path: str,
        args: dict[str, Any],
        timeout: float | None = None,
    ) -> Any:
        """Run a script synchronously and wait for the result.

        Args:
            script_path: Path to the script (e.g., "f/goat/clip")
            args: Script arguments/inputs
            timeout: Optional timeout in seconds

        Returns:
            Script execution result

        Raises:
            WindmillError: If script execution fails
        """
        client = self._get_client()

        logger.info(f"Running script synchronously: {script_path}")

        try:
            result = await self._run_sync(
                client.run_script_by_path,
                path=script_path,
                args=args,
                timeout=timeout,
                assert_result_is_not_none=False,
            )
            logger.info(f"Script completed: {script_path}")
            return result

        except Exception as e:
            logger.error(f"Error running script: {e}")
            raise WindmillError(f"Failed to run script: {e}") from e

    async def whoami(self) -> dict[str, Any]:
        """Get current user info.

        Returns:
            User info dict

        Raises:
            WindmillError: If API call fails
        """
        client = self._get_client()

        try:
            return await self._run_sync(client.whoami)
        except Exception as e:
            logger.error(f"Error getting user info: {e}")
            raise WindmillError(f"Failed to get user info: {e}") from e

    async def list_jobs(
        self,
        running: bool | None = None,
        script_path: str | None = None,
        success: bool | None = None,
        limit: int = 100,
    ) -> list[dict[str, Any]]:
        """List jobs from Windmill.

        Note: The official SDK doesn't expose list_jobs directly, so we use
        the underlying HTTP client.

        Args:
            running: Filter by running state
            script_path: Filter by script path (exact match)
            success: Filter by success state
            limit: Maximum results

        Returns:
            List of job dicts

        Raises:
            WindmillError: If API call fails
        """
        client = self._get_client()

        # Build query params
        params: dict[str, Any] = {"per_page": limit}
        if running is not None:
            params["running"] = str(running).lower()
        if script_path is not None:
            params["script_path_exact"] = script_path
        if success is not None:
            params["success"] = str(success).lower()

        try:
            # Use workspace-scoped endpoint: /w/{workspace}/jobs/list
            response = await self._run_sync(
                client.get,
                f"/w/{settings.WINDMILL_WORKSPACE}/jobs/list",
                params=params,
            )
            return response.json()

        except Exception as e:
            logger.error(f"Error listing jobs: {e}")
            raise WindmillError(f"Failed to list jobs: {e}") from e

    async def close(self) -> None:
        """Close the client.

        The underlying httpx.Client handles cleanup automatically,
        but we provide this method for compatibility.
        """
        if self._client is not None:
            # The SDK's client property is an httpx.Client, close it
            try:
                self._client.client.close()
            except Exception:
                pass  # Ignore cleanup errors
            self._client = None

    async def list_jobs_filtered(
        self,
        user_id: str,
        script_path_start: str = "f/goat/",
        created_after_days: int = 3,
        process_id: str | None = None,
        success: bool | None = None,
        running: bool | None = None,
        limit: int = 100,
        include_results: bool = True,
    ) -> list[dict[str, Any]]:
        """List jobs from Windmill with efficient filtering.

        Uses indexed filters (script_path_start, created_after) before
        applying args filter for user_id.

        Args:
            user_id: User ID to filter by (in args)
            script_path_start: Script path prefix filter (default: f/goat/)
            created_after_days: Only return jobs from last N days (default: 3)
            process_id: Optional specific process ID to filter
            success: Filter by success state (True/False/None)
            running: Filter by running state (True/False/None)
            limit: Maximum results (max 100)
            include_results: Fetch results for successful jobs (default: True)

        Returns:
            List of job dicts from Windmill

        Raises:
            WindmillError: If API call fails
        """
        import asyncio
        import re
        from datetime import datetime, timedelta, timezone

        client = self._get_client()
        workspace = settings.WINDMILL_WORKSPACE

        # Calculate created_after timestamp
        created_after = datetime.now(timezone.utc) - timedelta(days=created_after_days)
        created_after_iso = created_after.isoformat()

        # Normalize process_id to Windmill script path format
        # e.g., "PrintReport" -> "print_report", "buffer" -> "buffer"
        normalized_process_id = None
        script_path_filter = script_path_start
        if process_id:
            # Convert PascalCase/camelCase to snake_case for Windmill path matching
            normalized_process_id = re.sub(r"(?<!^)(?=[A-Z])", "_", process_id).lower()
            # All tools are now under f/goat/tools/ prefix
            script_path_filter = f"f/goat/tools/{normalized_process_id}"

        # Build query params - use indexed filters first
        params: dict[str, Any] = {
            "per_page": min(limit, 100),  # Windmill max is 100
            "script_path_start": script_path_filter,
            "created_after": created_after_iso,
            "has_null_parent": "true",  # Only root jobs, not flow steps
            "job_kinds": "script",  # Only script jobs
            "args": f'{{"user_id": "{user_id}"}}',  # JSON subset filter
        }

        # Add optional filters
        if success is not None:
            params["success"] = str(success).lower()
        if running is not None:
            params["running"] = str(running).lower()

        try:
            response = await self._run_sync(
                client.client.get,
                f"{settings.WINDMILL_URL}/api/w/{workspace}/jobs/list",
                params=params,
                headers={"Authorization": f"Bearer {settings.WINDMILL_TOKEN}"},
            )
            response.raise_for_status()
            jobs = response.json()

            # Windmill's /jobs/list returns limited fields
            # Fetch full details for jobs that need args/results
            if include_results:
                # Jobs that need full details:
                # - layer_export, project_export, print_report: need args for filtering and results for download
                # - workflow_runner: need results for temp_layer_ids
                # - layer_copy: needs args for its label once it has finished
                # - failed jobs: need result to extract error name/message
                jobs_needing_details = [
                    j
                    for j in jobs
                    if j.get("script_path", "").endswith(
                        (
                            "layer_export",
                            "project_export",
                            "print_report",
                            "workflow_runner",
                            # names its copy after the entry (`layer_name`) in the tray
                            "layer_copy",
                        )
                    )
                    or j.get("success") is False  # Failed jobs need error details
                    or j.get("running") is True  # Running jobs may need flow_status
                ]
                if jobs_needing_details:

                    async def fetch_job_details(job: dict[str, Any]) -> None:
                        try:
                            # Use get_job_with_result to get both status and result
                            full_job = await self.get_job_with_result(job["id"])
                            # Merge full job details into the list item
                            job["args"] = full_job.get("args")
                            # Include flow_status for workflow tracking (workflow_as_code_status)
                            if full_job.get("flow_status"):
                                job["flow_status"] = full_job.get("flow_status")
                            # Include result for successful jobs (downloads) and failed jobs (errors)
                            if (
                                full_job.get("success") is True
                                or full_job.get("success") is False
                            ):
                                job["result"] = full_job.get("result")
                            # A running workflow's steps, from its child jobs
                            # (see get_job_with_result)
                            if full_job.get("node_status"):
                                job["node_status"] = full_job["node_status"]
                        except Exception as e:
                            logger.warning(
                                f"Failed to fetch details for job {job['id']}: {e}"
                            )

                    await asyncio.gather(
                        *[fetch_job_details(job) for job in jobs_needing_details],
                        return_exceptions=True,
                    )

            return jobs

        except Exception as e:
            logger.error(f"Error listing jobs: {e}")
            raise WindmillError(f"Failed to list jobs: {e}") from e

    async def get_job_with_result(self, job_id: str) -> dict[str, Any]:
        """Get job details including result if completed.

        Args:
            job_id: Windmill job ID

        Returns:
            Job dict with 'result' field populated if job completed
            (includes error info for failed jobs)

        Raises:
            WindmillJobNotFound: If job doesn't exist
            WindmillError: If API call fails
        """
        # Get job status first
        job = await self.get_job_status(job_id)

        # Fetch result for completed jobs (both successful and failed)
        # Failed jobs have result with error structure: {"error": {"name": ..., "message": ...}}
        if job.get("success") is not None and not job.get("running"):
            try:
                job["result"] = await self.get_job_result(job_id)
            except Exception as e:
                logger.warning(f"Failed to fetch result for job {job_id}: {e}")

        # A running workflow reports its steps from their child jobs, the
        # same for the job list and a single job's status.
        if job.get("running") and str(job.get("script_path", "")).endswith(
            "workflow_runner"
        ):
            node_status = await self._get_child_jobs_status(job_id)
            if node_status:
                job["node_status"] = node_status

        return job

    async def get_flow_user_state(self, job_id: str, key: str) -> Any:
        """Get flow user state for a job at a given key.

        Args:
            job_id: Windmill job ID
            key: State key to retrieve

        Returns:
            State value (usually a dict)

        Raises:
            WindmillError: If API call fails
        """
        client = self._get_client()
        workspace = settings.WINDMILL_WORKSPACE

        try:
            response = await self._run_sync(
                client.client.get,
                f"{settings.WINDMILL_URL}/api/w/{workspace}/jobs/flow/user_states/{job_id}/{key}",
                headers={"Authorization": f"Bearer {settings.WINDMILL_TOKEN}"},
            )
            if response.status_code == 404:
                return None
            response.raise_for_status()
            return response.json()
        except Exception as e:
            logger.warning(f"Failed to get flow user state for {job_id}/{key}: {e}")
            return None

    async def _get_child_jobs_status(self, parent_job_id: str) -> dict[str, Any] | None:
        """Get status of child jobs spawned by a workflow_runner job.

        Queries Windmill for jobs with parent_job={parent_job_id} and builds
        node_status from their args (which contain node_id) and status.

        Args:
            parent_job_id: The workflow_runner job ID

        Returns:
            Dict mapping node_id -> status object with status, started_at, duration_ms
        """
        client = self._get_client()
        workspace = settings.WINDMILL_WORKSPACE

        try:
            # Query Windmill for child jobs of this parent
            # Note: /jobs/list doesn't return args, only job IDs and basic status
            response = await self._run_sync(
                client.client.get,
                f"{settings.WINDMILL_URL}/api/w/{workspace}/jobs/list",
                params={
                    "parent_job": parent_job_id,
                    "per_page": 100,
                },
                headers={"Authorization": f"Bearer {settings.WINDMILL_TOKEN}"},
            )
            response.raise_for_status()
            child_jobs = response.json()

            if not child_jobs:
                return None

            node_status: dict[str, Any] = {}

            # Fetch full job details (including args) for each child job
            async def fetch_child_details(job: dict[str, Any]) -> None:
                try:
                    job_id = job.get("id")
                    if not job_id:
                        return

                    # Get full job details including args
                    full_job = await self.get_job_status(job_id)
                    args = full_job.get("args", {})
                    # For finalize_layer child jobs, use export_node_id
                    # so status maps to the export node, not the source tool
                    node_id = (
                        args.get("export_node_id") or args.get("node_id")
                        if args
                        else None
                    )

                    if not node_id:
                        return

                    # Determine status from job state
                    if full_job.get("running"):
                        status = "running"
                    elif full_job.get("success") is True:
                        status = "completed"
                    elif full_job.get("success") is False:
                        status = "failed"
                    else:
                        status = "pending"  # queued/waiting

                    # Build status object
                    status_obj: dict[str, Any] = {"status": status}

                    # A failed step's own message, never its stack: a tool
                    # job that raised stores {"error": {"name", "message",
                    # "stack", ...}} as its result.
                    if status == "failed":
                        child_result = full_job.get("result")
                        status_obj["error"] = error_message(
                            child_result.get("error")
                            if isinstance(child_result, dict)
                            else None
                        )

                    # Add timing info if available
                    if full_job.get("started_at"):
                        started_at = full_job.get("started_at")
                        if isinstance(started_at, str):
                            from datetime import datetime

                            try:
                                dt = datetime.fromisoformat(
                                    started_at.replace("Z", "+00:00")
                                )
                                status_obj["started_at"] = dt.timestamp()
                            except Exception:
                                pass

                    # Add duration for completed jobs
                    if status == "completed" and full_job.get("duration_ms"):
                        status_obj["duration_ms"] = full_job.get("duration_ms")

                    # Add temp_layer_id for completed tool jobs (from job result)
                    if status == "completed" and full_job.get("result"):
                        result = full_job.get("result")
                        if isinstance(result, dict):
                            if result.get("temp_layer_id"):
                                status_obj["temp_layer_id"] = result.get(
                                    "temp_layer_id"
                                )
                            # Add layer_id for completed export/finalize jobs
                            if result.get("layer_id"):
                                status_obj["layer_id"] = result.get("layer_id")

                    node_status[node_id] = status_obj

                except Exception as e:
                    logger.warning(f"Failed to fetch child job details: {e}")

            # Fetch all child job details in parallel
            await asyncio.gather(
                *[fetch_child_details(job) for job in child_jobs],
                return_exceptions=True,
            )

            return node_status if node_status else None

        except Exception as e:
            logger.warning(f"Failed to get child jobs for {parent_job_id}: {e}")
            return None


# Global client instance
windmill_client = WindmillClient()
