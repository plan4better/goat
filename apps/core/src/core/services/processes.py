import logging

import aiohttp
from core.core.config import settings
from fastapi import HTTPException, status

logger = logging.getLogger(__name__)


def dispatch_never_started(error: BaseException) -> bool:
    """Whether an ``execute_process`` failure rules out the job having started.

    Only two failures do: the processes service is not configured, so no
    request left this process, and the connection was never established, so
    nothing was sent. Everything else is ambiguous — a timeout, a 502 from the
    ingress, a disconnect while waiting — because the submission may have been
    accepted and the job may already be running. A caller that compensates by
    removing what the job operates on must therefore only do so when this
    returns True; otherwise it would pull the ground out from under a live job.
    """
    if isinstance(error, HTTPException):
        # `execute_process` maps every response it did get to 502; 503 is the
        # unconfigured-service guard, raised before any request is made.
        return error.status_code == status.HTTP_503_SERVICE_UNAVAILABLE
    # Connecting failed (DNS, refused, TLS): the request was never sent. A
    # ServerDisconnectedError is deliberately not included — that one happens
    # after the request went out.
    return isinstance(error, aiohttp.ClientConnectorError)


async def execute_process(
    *,
    process_id: str,
    inputs: dict,
    access_token: str,
) -> str:
    """Trigger an OGC process (a Windmill job) via the processes service.

    Returns the submitted job id. Raises HTTPException on failure so callers can
    surface the problem (and run any compensating action, e.g. marking a created
    record failed). Callers that want best-effort behaviour should catch it (see
    ``delete_layers_via_processes``).
    """
    if not settings.processes_url:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Processes service (GOAT_PROCESSES_URL) is not configured",
        )

    url = f"{settings.processes_url}/processes/{process_id}/execution"
    headers = {
        "Authorization": f"Bearer {access_token}",
        "Content-Type": "application/json",
    }
    async with aiohttp.ClientSession() as session:
        async with session.post(
            url, json={"inputs": inputs}, headers=headers
        ) as response:
            if response.status in (200, 201):
                result = await response.json()
                job_id = result.get("jobID", "")
                logger.info("Submitted process %s as job %s", process_id, job_id)
                return job_id
            error_text = await response.text()
            if response.status == 402:
                # Out of credits: say so instead of a generic gateway error.
                raise HTTPException(
                    status_code=status.HTTP_402_PAYMENT_REQUIRED,
                    detail="Organization is out of credits for this period.",
                )
            logger.error(
                "Failed to submit process %s: %s %s",
                process_id,
                response.status,
                error_text,
            )
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail=f"Failed to start '{process_id}' job",
            )


async def delete_bundle_artifacts_via_processes(
    bundle_ids: list[str], access_token: str
) -> None:
    """Remove bundles' built artifacts via the ``bundle_artifact_delete`` process.

    Artifacts live on the data volume, which core does not mount — the same
    reason a layer's DuckLake table and PMTiles are dropped by a worker rather
    than here. Best-effort: called after the bundle rows are already gone, and
    artifacts are regenerable, so a failure is logged and never raised.
    """
    if not bundle_ids:
        return
    try:
        await execute_process(
            process_id="bundle_artifact_delete",
            inputs={"bundle_ids": bundle_ids},
            access_token=access_token,
        )
    except Exception as e:
        logger.warning(
            "Artifact cleanup for %d bundle(s) did not start: %s",
            len(bundle_ids),
            e,
        )


async def delete_layers_via_processes(layer_ids: list[str], access_token: str) -> None:
    """Delete layers' DuckLake tables via the ``layer_delete_multi`` process.

    Best-effort: called after the layers' PostgreSQL records are already gone, so
    a failure here (unconfigured host, processes error) is logged but never
    raised — it must not undo the completed delete.
    """
    if not layer_ids:
        return
    try:
        await execute_process(
            process_id="layer_delete_multi",
            inputs={"layer_ids": layer_ids},
            access_token=access_token,
        )
    except Exception as e:
        logger.warning(
            "DuckLake cleanup for %d layers did not start: %s", len(layer_ids), e
        )
