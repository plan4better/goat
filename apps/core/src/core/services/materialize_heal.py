"""When re-adding a catalog dataset should re-run its materialize job.

Re-adding is the product's only recovery affordance — there is no retry button
— so this decision carries the whole self-heal. It reads the layer's
`catalog_materialize` document, which every writer stamps with a status and an
`updated_at` (promote, the job, and the heal itself).

The rules, and why each exists:

* `failed` → re-enqueue. The obvious case.
* `pending` → re-enqueue only if it has been pending for a while. A fresh
  `pending` is a job that is queued but not yet picked up (the worker flips to
  `running` as its first act); re-enqueueing it would start a second job racing
  the first on the same output file. An old `pending` is an enqueue that never
  happened.
* `running` → re-enqueue only if stale. Nothing records a heartbeat or a job
  id, so a worker killed mid-job leaves `running` behind for good; treating a
  long-dead `running` as failed is the operator-free way out. A live job that
  legitimately runs longer than the threshold is re-enqueued behind itself —
  materialize is idempotent, so the cost is a duplicate run, not a wrong result.
* `ready` with its file missing → re-enqueue, and reset like `failed`. The
  document outlives the file when storage is lost or a database is restored
  without its files, and every tool and tile request on the layer then fails.
  The document cannot tell, so the endpoint looks (`copy_on_disk`, one `stat`)
  for the layer types the job writes a parquet for; an unreadable directory
  is "unknown", which trusts the document as before.
* `ready` with `tiles: failed …` → re-enqueue. The data is served either way,
  but the PMTiles cache never gets rebuilt otherwise.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from uuid import UUID

#: A queued job should have been picked up within this; older `pending` means
#: the enqueue was lost.
PENDING_REENQUEUE_AFTER = timedelta(minutes=2)
#: Longer than any materialize we have seen; older `running` means the worker
#: died. The trade-off is described in the module docstring.
RUNNING_STALE_AFTER = timedelta(minutes=30)
#: The layer types the job writes a parquet copy for (its `vector` handler).
#: Any other type has no file to look for.
PARQUET_LAYER_TYPES = frozenset({"feature", "table"})


@dataclass(frozen=True)
class HealDecision:
    should_enqueue: bool
    #: Write the document back to `pending` first, so the tree shows
    #: "preparing" again while the new job runs.
    reset_to_pending: bool
    reason: str


def copy_on_disk(
    layers_dir: Path, layer_id: UUID, layer_type: str | None
) -> bool | None:
    """Whether the job's parquet copy of the layer exists, or None if unknown.

    One `stat`. The file name is goatlib's `layer_id_to_table_name` plus
    `.parquet`, spelled out here because that module needs libraries core's
    image does not install. A missing directory counts as a missing file: the
    job creates the directory with its first file, so storage that lost
    everything has neither. Any other error (no permission, a stale network
    mount) is unknown, and an unknown file leaves the document's word standing.
    """
    if layer_type not in PARQUET_LAYER_TYPES:
        return None
    try:
        (layers_dir / f"t_{layer_id.hex}.parquet").stat()
    except FileNotFoundError:
        return False
    except OSError:
        return None
    return True


def _stamped_at(doc: dict[str, Any]) -> datetime | None:
    raw = doc.get("updated_at")
    if not raw:
        return None
    try:
        stamp = datetime.fromisoformat(str(raw))
    except ValueError:
        return None
    return stamp if stamp.tzinfo else stamp.replace(tzinfo=timezone.utc)


def decide_heal(
    materialize: dict[str, Any] | None,
    *,
    now: datetime | None = None,
    copy_present: bool | None = None,
) -> HealDecision:
    """Decide from the layer's `catalog_materialize` document, and for a
    `ready` one from whether its copy is on disk (`copy_on_disk`; None when
    unknown or the layer type has no copy)."""
    now = now or datetime.now(timezone.utc)
    doc = materialize or {}
    status = doc.get("status")
    stamped = _stamped_at(doc)
    age = (now - stamped) if stamped else None

    if status == "failed":
        return HealDecision(True, True, "failed")

    if status == "pending":
        # No timestamp at all is a document from before stamps existed: treat
        # as old, since it cannot be a job enqueued seconds ago by this code.
        if age is None or age >= PENDING_REENQUEUE_AFTER:
            return HealDecision(True, False, "pending too long")
        return HealDecision(False, False, "pending, job queued")

    if status == "running":
        if age is None or age >= RUNNING_STALE_AFTER:
            return HealDecision(True, True, "running stale")
        return HealDecision(False, False, "running")

    if status == "ready":
        # Before the tiles: they are rebuilt from the file.
        if copy_present is False:
            return HealDecision(True, True, "ready, file missing")
        tiles = str(doc.get("tiles") or "")
        if tiles.startswith("failed"):
            return HealDecision(True, False, "tiles failed")
        return HealDecision(False, False, "ready")

    # No document: a layer promoted by code that predates the lifecycle.
    return HealDecision(True, True, "no status")
