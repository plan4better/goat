"""All SQL of the assistant. Raw asyncpg against the tables core defines."""

from datetime import datetime, timedelta
from typing import Any, cast, get_args
from uuid import UUID

import asyncpg

from assistant.db import Database
from assistant.events import EVENT_ADAPTER, RunErrorCode, RunEvent, UsageReported

ACTIVE = ("queued", "running")

#: A run still queued after this long was orphaned: a crash between begin_run and
#: mark_running would otherwise block its conversation and a user slot forever.
QUEUED_GRACE = timedelta(seconds=60)

#: How long an Undo's mark that it is under way holds: a request that never
#: finished (a crash) frees the edits after it.
UNDO_CLAIM_TTL = timedelta(minutes=5)

#: The first message as the history shows it when a conversation has no title.
FIRST_MESSAGE_CHARS = 200


def _like(text: str) -> str:
    """A case-insensitive substring pattern with ``%``, ``_`` and ``\\`` taken literally."""
    escaped = text.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{escaped}%"


def _summary(record: asyncpg.Record) -> dict[str, Any]:
    row = dict(record)
    if not row["project_access"]:
        # A project the user can no longer open is not named (spec §10).
        row["project_name"] = None
    text = row["first_message"]
    if isinstance(text, str) and len(text) > FIRST_MESSAGE_CHARS:
        row["first_message"] = text[: FIRST_MESSAGE_CHARS - 1] + "…"
    return row


class ConversationBusy(Exception):  # noqa: N818
    """The conversation already has an active run (spec §6.1: one per conversation)."""


class ConversationNotFound(LookupError):  # noqa: N818
    """The conversation does not exist or belongs to another user."""


class UserRunLimit(Exception):  # noqa: N818
    """The user already has the maximum number of active runs (spec §8.4)."""


class ConversationBoundElsewhere(Exception):  # noqa: N818
    """The conversation is bound to another project than the run's (spec §10),
    ``None`` included: a run without a project in a bound conversation."""

    def __init__(self, project_id: UUID | None) -> None:
        super().__init__(project_id)
        self.project_id = project_id


def _row(record: asyncpg.Record | None) -> dict[str, Any] | None:
    return dict(record) if record is not None else None


class Repository:
    def __init__(self, db: Database) -> None:
        self.db = db

    # -- conversations -------------------------------------------------------

    async def create_conversation(
        self,
        user_id: UUID,
        origin_surface: str,
        project_id: UUID | None,
        title: str | None,
    ) -> dict[str, Any]:
        organization_id = await self.organization_of(user_id)
        record = await self.db.pool.fetchrow(
            f"INSERT INTO {self.db.t('conversation')} "
            "(user_id, organization_id, project_id, title, origin_surface) "
            "VALUES ($1, $2, $3, $4, $5) RETURNING *",
            user_id,
            organization_id,
            project_id,
            title,
            origin_surface,
        )
        if record is None:
            raise RuntimeError("INSERT ... RETURNING produced no row")
        return dict(record)

    async def get_conversation(
        self, conversation_id: UUID, user_id: UUID
    ) -> dict[str, Any] | None:
        return _row(
            await self.db.pool.fetchrow(
                f"SELECT * FROM {self.db.t('conversation')} WHERE id = $1 AND user_id = $2",
                conversation_id,
                user_id,
            )
        )

    async def delete_conversation(self, conversation_id: UUID, user_id: UUID) -> bool:
        status = await self.db.pool.execute(
            f"DELETE FROM {self.db.t('conversation')} WHERE id = $1 AND user_id = $2",
            conversation_id,
            user_id,
        )
        return bool(status == "DELETE 1")

    async def set_title_if_empty(self, conversation_id: UUID, title: str) -> bool:
        status = await self.db.pool.execute(
            f"UPDATE {self.db.t('conversation')} SET title = $2 "
            "WHERE id = $1 AND title IS NULL",
            conversation_id,
            title,
        )
        return bool(status == "UPDATE 1")

    # -- summaries, binding and project access (plan 4) ----------------------

    def _can_read_project(self, project: str, user: str) -> str:
        """The one definition of "this user can open that project": the project
        exists, is not trashed and core's authorization function allows it
        (as geoapi checks, spec §5). ``project`` and ``user`` are SQL
        expressions."""
        return (
            f"coalesce({project}.id IS NOT NULL AND {project}.deleted_at IS NULL AND "
            f"{self.db.customer('can')}('project', {project}.id, {user}, 'read'), false)"
        )

    def _summary_sql(self) -> str:
        t, c = self.db.t, self.db.customer
        return (
            "SELECT c.id, c.title, c.origin_surface, c.project_id, c.created_at, c.updated_at, "
            "p.name AS project_name, "
            f"CASE WHEN c.project_id IS NULL THEN NULL ELSE {self._can_read_project('p', 'c.user_id')} "
            "END AS project_access, "
            # One character past the limit, so `_summary` can tell it cut the text.
            "left(first_user.text, 201) AS first_message, "
            f"EXISTS (SELECT 1 FROM {t('run')} r WHERE r.conversation_id = c.id "
            "AND r.status IN ('queued', 'running')) AS running "
            f"FROM {t('conversation')} c "
            f"LEFT JOIN {c('project')} p ON p.id = c.project_id "
            "LEFT JOIN LATERAL ("
            f"SELECT m.parts -> 0 ->> 'text' AS text FROM {t('message')} m "
            "WHERE m.conversation_id = c.id AND m.role = 'user' ORDER BY m.seq LIMIT 1"
            ") first_user ON true "
        )

    async def list_conversation_summaries(
        self, user_id: UUID, project_id: UUID | None, q: str | None, limit: int
    ) -> list[dict[str, Any]]:
        """The history list (spec §10): newest first, optionally one project's
        conversations, optionally matching ``q`` in the title or first message."""
        pattern = _like(q.strip()) if q and q.strip() else None
        records = await self.db.pool.fetch(
            self._summary_sql()
            + "WHERE c.user_id = $1 AND ($2::uuid IS NULL OR c.project_id = $2) "
            "AND ($3::text IS NULL OR c.title ILIKE $3 OR first_user.text ILIKE $3) "
            "ORDER BY c.updated_at DESC LIMIT $4",
            user_id,
            project_id,
            pattern,
            limit,
        )
        return [_summary(r) for r in records]

    async def conversation_summary(
        self, conversation_id: UUID, user_id: UUID
    ) -> dict[str, Any] | None:
        record = await self.db.pool.fetchrow(
            self._summary_sql() + "WHERE c.id = $1 AND c.user_id = $2",
            conversation_id,
            user_id,
        )
        return _summary(record) if record is not None else None

    async def project_access(
        self, project_id: UUID, user_id: UUID
    ) -> tuple[bool, str | None]:
        """Whether the user can open the project, and its name when they can."""
        record = await self.db.pool.fetchrow(
            f"SELECT p.name, {self._can_read_project('p', '$2::uuid')} AS readable "
            f"FROM {self.db.customer('project')} p WHERE p.id = $1",
            project_id,
            user_id,
        )
        if record is None or not record["readable"]:
            return False, None
        name: str | None = record["name"]
        return True, name

    async def update_title(
        self, conversation_id: UUID, user_id: UUID, title: str | None
    ) -> bool:
        # Renaming keeps the conversation's place in the history (updated_at).
        status = await self.db.pool.execute(
            f"UPDATE {self.db.t('conversation')} SET title = $3 WHERE id = $1 AND user_id = $2",
            conversation_id,
            user_id,
            title,
        )
        return bool(status == "UPDATE 1")

    async def bind_project(
        self, conversation_id: UUID, user_id: UUID, project_id: UUID
    ) -> UUID | None:
        """Bind an unbound conversation (spec §10). Returns the project it is
        bound to afterwards, which differs from ``project_id`` when another
        request bound it first."""
        bound: UUID | None = await self.db.pool.fetchval(
            f"UPDATE {self.db.t('conversation')} SET project_id = $3 "
            "WHERE id = $1 AND user_id = $2 AND project_id IS NULL RETURNING project_id",
            conversation_id,
            user_id,
            project_id,
        )
        if bound is not None:
            return bound
        current: UUID | None = await self.db.pool.fetchval(
            f"SELECT project_id FROM {self.db.t('conversation')} WHERE id = $1 AND user_id = $2",
            conversation_id,
            user_id,
        )
        return current

    # -- runs ----------------------------------------------------------------

    async def begin_run(
        self,
        conversation_id: UUID,
        user_id: UUID,
        user_parts: list[dict[str, Any]],
        provider: str,
        model: str,
        max_concurrent: int,
        *,
        target: UUID | None = None,
    ) -> tuple[UUID, UUID]:
        """Insert the user message, the assistant placeholder and the run in one
        transaction. A per-user advisory lock makes the limit checks race-free.

        ``target`` is the project the conversation must be in once the run is
        recorded (spec §10): an unbound conversation is bound to it in the same
        transaction, so a refused run leaves no binding behind and a binding made
        by another request in between is seen here. Raises
        ``ConversationBoundElsewhere`` when the conversation ends up in another
        project; nothing is stored then.

        Ownership of the conversation is verified here. ``list_messages``,
        ``history`` and ``active_run`` are caller-checked: the router verifies
        ownership first."""
        async with self.db.pool.acquire() as conn, conn.transaction():
            await conn.execute(
                "SELECT pg_advisory_xact_lock(hashtext($1))", str(user_id)
            )
            if target is None:
                record = await conn.fetchrow(
                    f"SELECT project_id FROM {self.db.t('conversation')} "
                    "WHERE id = $1 AND user_id = $2 FOR UPDATE",
                    conversation_id,
                    user_id,
                )
            else:
                record = await conn.fetchrow(
                    f"UPDATE {self.db.t('conversation')} "
                    "SET project_id = COALESCE(project_id, $3) "
                    "WHERE id = $1 AND user_id = $2 RETURNING project_id",
                    conversation_id,
                    user_id,
                    target,
                )
            if record is None:
                raise ConversationNotFound()
            if record["project_id"] != target:
                raise ConversationBoundElsewhere(record["project_id"])
            busy = await conn.fetchval(
                f"SELECT 1 FROM {self.db.t('run')} "
                "WHERE conversation_id = $1 AND status = ANY($2)",
                conversation_id,
                list(ACTIVE),
            )
            if busy:
                raise ConversationBusy()
            running = await conn.fetchval(
                f"SELECT count(*) FROM {self.db.t('run')} "
                "WHERE user_id = $1 AND status = ANY($2)",
                user_id,
                list(ACTIVE),
            )
            if running >= max_concurrent:
                raise UserRunLimit()
            seq = await conn.fetchval(
                f"SELECT coalesce(max(seq), 0) FROM {self.db.t('message')} "
                "WHERE conversation_id = $1",
                conversation_id,
            )
            await conn.execute(
                f"INSERT INTO {self.db.t('message')} (conversation_id, seq, role, parts) "
                "VALUES ($1, $2, 'user', $3)",
                conversation_id,
                seq + 1,
                user_parts,
            )
            message_id: UUID = await conn.fetchval(
                f"INSERT INTO {self.db.t('message')} (conversation_id, seq, role) "
                "VALUES ($1, $2, 'assistant') RETURNING id",
                conversation_id,
                seq + 2,
            )
            run_id: UUID = await conn.fetchval(
                f"INSERT INTO {self.db.t('run')} "
                "(conversation_id, user_id, assistant_message_id, status, provider, model) "
                "VALUES ($1, $2, $3, 'queued', $4, $5) RETURNING id",
                conversation_id,
                user_id,
                message_id,
                provider,
                model,
            )
            await conn.execute(
                f"UPDATE {self.db.t('message')} SET run_id = $1 WHERE id = $2",
                run_id,
                message_id,
            )
            await conn.execute(
                f"UPDATE {self.db.t('conversation')} SET updated_at = now() WHERE id = $1",
                conversation_id,
            )
        return run_id, message_id

    async def mark_running(
        self, run_id: UUID, owner: str, lease_until: datetime
    ) -> bool:
        """Claim a queued run. False when it is no longer queued (already
        claimed, finished or swept)."""
        status = await self.db.pool.execute(
            f"UPDATE {self.db.t('run')} SET status = 'running', started_at = now(), "
            "lease_owner = $2, lease_expires_at = $3 WHERE id = $1 AND status = 'queued'",
            run_id,
            owner,
            lease_until,
        )
        return bool(status == "UPDATE 1")

    async def renew_lease(
        self, run_id: UUID, owner: str, lease_until: datetime
    ) -> bool:
        status = await self.db.pool.execute(
            f"UPDATE {self.db.t('run')} SET lease_expires_at = $3 "
            "WHERE id = $1 AND lease_owner = $2 AND status = 'running'",
            run_id,
            owner,
            lease_until,
        )
        return bool(status == "UPDATE 1")

    async def finish_run(
        self,
        run_id: UUID,
        status: str,
        error: str | None,
        parts: list[dict[str, Any]],
        model_messages: list[dict[str, Any]],
    ) -> bool:
        """End an active run and fold its message, in one transaction: a client
        that sees the run gone always finds the complete message (Review Focus 3).

        Compare-and-set: only a queued or running run ends. When it already ended
        (swept, cancelled elsewhere) this returns False and the message is left
        untouched."""
        async with self.db.pool.acquire() as conn, conn.transaction():
            message_id: UUID | None = await conn.fetchval(
                f"UPDATE {self.db.t('run')} SET status = $2, error = $3, "
                "finished_at = now(), lease_owner = NULL, lease_expires_at = NULL "
                "WHERE id = $1 AND status IN ('queued', 'running') "
                "RETURNING assistant_message_id",
                run_id,
                status,
                error,
            )
            if message_id is None:
                return False
            await conn.execute(
                f"UPDATE {self.db.t('message')} SET parts = $2, model_messages = $3 "
                "WHERE id = $1",
                message_id,
                parts,
                model_messages,
            )
        return True

    async def active_run(self, conversation_id: UUID) -> dict[str, Any] | None:
        return _row(
            await self.db.pool.fetchrow(
                f"SELECT * FROM {self.db.t('run')} "
                "WHERE conversation_id = $1 AND status = ANY($2)",
                conversation_id,
                list(ACTIVE),
            )
        )

    async def get_run(self, run_id: UUID) -> dict[str, Any] | None:
        return _row(
            await self.db.pool.fetchrow(
                f"SELECT * FROM {self.db.t('run')} WHERE id = $1", run_id
            )
        )

    async def set_run_model(self, run_id: UUID, provider: str, model: str) -> None:
        """Record the connection that took over after a fallback (spec §4.6)."""
        await self.db.pool.execute(
            f"UPDATE {self.db.t('run')} SET provider = $2, model = $3 WHERE id = $1",
            run_id,
            provider,
            model,
        )

    async def expired_runs(self, now: datetime) -> list[dict[str, Any]]:
        """Runs to sweep: a running run whose lease lapsed, or a run that stayed
        queued past ``QUEUED_GRACE``."""
        records = await self.db.pool.fetch(
            f"SELECT * FROM {self.db.t('run')} "
            "WHERE (status = 'running' AND lease_expires_at < $1) "
            "OR (status = 'queued' AND created_at < $2)",
            now,
            now - QUEUED_GRACE,
        )
        return [dict(r) for r in records]

    # -- events --------------------------------------------------------------

    async def append_event(self, run_id: UUID, seq: int, event: RunEvent) -> None:
        payload = EVENT_ADAPTER.dump_python(event, mode="json")
        await self.db.pool.execute(
            f"INSERT INTO {self.db.t('run_event')} (run_id, seq, type, payload) "
            "VALUES ($1, $2, $3, $4)",
            run_id,
            seq,
            payload["type"],
            payload,
        )

    async def list_events(
        self, run_id: UUID, after_seq: int = 0
    ) -> list[tuple[int, RunEvent]]:
        records = await self.db.pool.fetch(
            f"SELECT seq, payload FROM {self.db.t('run_event')} "
            "WHERE run_id = $1 AND seq > $2 ORDER BY seq",
            run_id,
            after_seq,
        )
        return [
            (r["seq"], EVENT_ADAPTER.validate_python(r["payload"])) for r in records
        ]

    async def next_seq(self, run_id: UUID) -> int:
        current: int = await self.db.pool.fetchval(
            f"SELECT coalesce(max(seq), 0) FROM {self.db.t('run_event')} WHERE run_id = $1",
            run_id,
        )
        return current + 1

    # -- messages ------------------------------------------------------------

    async def history(self, conversation_id: UUID) -> list[dict[str, Any]]:
        records = await self.db.pool.fetch(
            f"SELECT model_messages FROM {self.db.t('message')} "
            "WHERE conversation_id = $1 AND role = 'assistant' ORDER BY seq",
            conversation_id,
        )
        return [message for r in records for message in r["model_messages"]]

    async def end_code_of(self, assistant_message_id: UUID) -> RunErrorCode | None:
        """The failure code in the ``run_status`` part of an assistant message,
        or None when the message has none (the run succeeded, or the part was
        folded before codes existed)."""
        parts = await self.db.pool.fetchval(
            f"SELECT parts FROM {self.db.t('message')} WHERE id = $1",
            assistant_message_id,
        )
        for part in reversed(parts or []):
            if part.get("type") == "run_status":
                code = part.get("code")
                return (
                    cast(RunErrorCode, code) if code in get_args(RunErrorCode) else None
                )
        return None

    async def prompt_of(self, assistant_message_id: UUID) -> str | None:
        """The text of the user message an assistant message answers (the one
        right before it), or None when it has none."""
        parts = await self.db.pool.fetchval(
            f"SELECT u.parts FROM {self.db.t('message')} a "
            f"JOIN {self.db.t('message')} u ON u.conversation_id = a.conversation_id "
            "AND u.seq = a.seq - 1 AND u.role = 'user' WHERE a.id = $1",
            assistant_message_id,
        )
        for part in parts or []:
            if part.get("type") == "user_text" and part.get("text"):
                return str(part["text"])
        return None

    async def list_messages(
        self, conversation_id: UUID, exclude_message_id: UUID | None
    ) -> list[dict[str, Any]]:
        # An answer's row is written when its run starts, together with the
        # question: its time is when the run ended.
        records = await self.db.pool.fetch(
            "SELECT m.id, m.role, m.parts, m.seq, m.run_id, "
            "coalesce(r.finished_at, m.created_at) AS created_at "
            f"FROM {self.db.t('message')} m "
            f"LEFT JOIN {self.db.t('run')} r ON r.id = m.run_id "
            "WHERE m.conversation_id = $1 AND ($2::uuid IS NULL OR m.id <> $2) "
            "ORDER BY m.seq",
            conversation_id,
            exclude_message_id,
        )
        return [dict(r) for r in records]

    async def last_user_context(self, conversation_id: UUID) -> dict[str, Any] | None:
        """The page context stored with the latest user message (spec §6.3), or
        None when that message came from a page without an adapter."""
        parts = await self.db.pool.fetchval(
            f"SELECT parts FROM {self.db.t('message')} "
            "WHERE conversation_id = $1 AND role = 'user' ORDER BY seq DESC LIMIT 1",
            conversation_id,
        )
        for part in parts or []:
            if part.get("type") == "context" and isinstance(part.get("context"), dict):
                return dict(part["context"])
        return None

    # -- feedback on answers ---------------------------------------------------

    async def is_answer(self, conversation_id: UUID, message_id: UUID) -> bool:
        """Whether ``message_id`` is an assistant answer in this conversation."""
        role = await self.db.pool.fetchval(
            f"SELECT role FROM {self.db.t('message')} WHERE id = $2 AND conversation_id = $1",
            conversation_id,
            message_id,
        )
        return bool(role == "assistant")

    async def set_feedback(
        self,
        message_id: UUID,
        user_id: UUID,
        organization_id: UUID | None,
        rating: str,
        comment: str | None,
    ) -> None:
        """The user's rating of an answer, replacing an earlier one."""
        await self.db.pool.execute(
            f"INSERT INTO {self.db.t('feedback')} "
            "(message_id, user_id, organization_id, rating, comment) "
            "VALUES ($1, $2, $3, $4, $5) "
            "ON CONFLICT (message_id, user_id) DO UPDATE SET "
            "rating = EXCLUDED.rating, comment = EXCLUDED.comment, updated_at = now()",
            message_id,
            user_id,
            organization_id,
            rating,
            comment,
        )

    async def clear_feedback(self, message_id: UUID, user_id: UUID) -> None:
        await self.db.pool.execute(
            f"DELETE FROM {self.db.t('feedback')} WHERE message_id = $1 AND user_id = $2",
            message_id,
            user_id,
        )

    async def feedback_in(
        self, conversation_id: UUID, user_id: UUID
    ) -> dict[str, dict[str, Any]]:
        """The user's ratings in a conversation, by answer id."""
        records = await self.db.pool.fetch(
            f"SELECT f.message_id, f.rating, f.comment FROM {self.db.t('feedback')} f "
            f"JOIN {self.db.t('message')} m ON m.id = f.message_id "
            "WHERE m.conversation_id = $1 AND f.user_id = $2",
            conversation_id,
            user_id,
        )
        return {
            str(r["message_id"]): {"rating": r["rating"], "comment": r["comment"]}
            for r in records
        }

    # -- usage and identity --------------------------------------------------

    async def insert_usage(
        self,
        run_id: UUID,
        user_id: UUID,
        organization_id: UUID | None,
        provider: str,
        model: str,
        purpose: str,
        usage: UsageReported,
        *,
        connection_id: UUID | None = None,
    ) -> None:
        """One row per run and purpose (spec §11); ``connection_id`` None is GOAT AI."""
        await self.db.pool.execute(
            f"INSERT INTO {self.db.t('usage')} (run_id, user_id, organization_id, "
            "connection_id, provider, model, purpose, input_tokens, output_tokens, "
            "cache_read_tokens, cache_write_tokens) "
            "VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)",
            run_id,
            user_id,
            organization_id,
            connection_id,
            provider,
            model,
            purpose,
            usage.input_tokens,
            usage.output_tokens,
            usage.cache_read_tokens,
            usage.cache_write_tokens,
        )

    async def organization_of(self, user_id: UUID) -> UUID | None:
        value: UUID | None = await self.db.pool.fetchval(
            f"SELECT organization_id FROM {self.db.customer('user')} WHERE id = $1",
            user_id,
        )
        return value

    # -- tool calls (spec §7.5) ----------------------------------------------

    async def insert_tool_call(
        self,
        *,
        run_id: UUID | None,
        user_id: UUID,
        tool: str,
        tool_call_id: str | None,
        args_summary: dict[str, Any],
        result_bytes: int,
        duration_ms: int,
        status: str,
        error: str | None,
        created: dict[str, Any] | None = None,
        undo: dict[str, Any] | None = None,
    ) -> None:
        """``undo``: what takes a write's change of an existing document back
        (``runtime.Undoes``)."""
        await self.db.pool.execute(
            f"INSERT INTO {self.db.t('tool_call')} (run_id, user_id, tool, tool_call_id, "
            "args_summary, result_bytes, duration_ms, status, error, created, undo) "
            "VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)",
            run_id,
            user_id,
            tool,
            tool_call_id,
            args_summary,
            result_bytes,
            duration_ms,
            status,
            error,
            created,
            undo,
        )

    # -- undo of an answer's edits ---------------------------------------------

    async def undo_records(self, run_id: UUID) -> list[tuple[UUID, dict[str, Any]]]:
        """The undo records of a run's calls with their row ids, in the order
        the calls were made. Read by ``undo IS NOT NULL``, never by status: a
        call whose save landed keeps its record also when its result was then
        refused."""
        records = await self.db.pool.fetch(
            f"SELECT id, undo FROM {self.db.t('tool_call')} "
            "WHERE run_id = $1 AND undo IS NOT NULL ORDER BY created_at, id",
            run_id,
        )
        return [(r["id"], dict(r["undo"])) for r in records]

    async def claim_undo(self, ids: list[UUID]) -> list[UUID]:
        """Marks the records under way (``undoing_at`` in the record) that are
        neither undone nor under way, and returns those this call marked: of
        two Undo requests at once, only one writes the content back. A mark
        older than ``UNDO_CLAIM_TTL`` is left by a request that never
        finished and counts as none."""
        records = await self.db.pool.fetch(
            f"UPDATE {self.db.t('tool_call')} "
            "SET undo = undo || jsonb_build_object('undoing_at', now()) "
            "WHERE id = ANY($1::uuid[]) AND undo IS NOT NULL "
            "AND NOT undo ? 'undone_at' AND (NOT undo ? 'undoing_at' "
            "OR (undo ->> 'undoing_at')::timestamptz < now() - $2::interval) "
            "RETURNING id",
            ids,
            UNDO_CLAIM_TTL,
        )
        return [r["id"] for r in records]

    async def finish_undo(self, ids: list[UUID]) -> None:
        """Marks the records undone: their content went back."""
        await self.db.pool.execute(
            f"UPDATE {self.db.t('tool_call')} "
            "SET undo = (undo - 'undoing_at') || jsonb_build_object('undone_at', now()) "
            "WHERE id = ANY($1::uuid[]) AND undo IS NOT NULL",
            ids,
        )

    async def release_undo(self, ids: list[UUID]) -> None:
        """Takes the mark off again: the content did not go back."""
        await self.db.pool.execute(
            f"UPDATE {self.db.t('tool_call')} SET undo = undo - 'undoing_at' "
            "WHERE id = ANY($1::uuid[]) AND undo IS NOT NULL",
            ids,
        )

    async def undo_records_by_answer(
        self, conversation_id: UUID
    ) -> dict[UUID, list[tuple[UUID, dict[str, Any]]]]:
        """The undo records of a conversation's runs, by answer, in the order
        the calls were made."""
        records = await self.db.pool.fetch(
            f"SELECT r.assistant_message_id, c.id, c.undo FROM {self.db.t('run')} r "
            f"JOIN {self.db.t('tool_call')} c ON c.run_id = r.id "
            "WHERE r.conversation_id = $1 AND c.undo IS NOT NULL "
            "ORDER BY c.created_at, c.id",
            conversation_id,
        )
        found: dict[UUID, list[tuple[UUID, dict[str, Any]]]] = {}
        for r in records:
            found.setdefault(r["assistant_message_id"], []).append(
                (r["id"], dict(r["undo"]))
            )
        return found

    async def delete_mcp_tool_calls_before(
        self, cutoff: datetime, *, limit: int = 1000
    ) -> int:
        """Delete up to ``limit`` audit rows of MCP calls (no run) older than
        ``cutoff``; returns how many. Bounded, so one sweep never holds a long
        lock on a large backlog: the next sweep takes the rest."""
        status: str = await self.db.pool.execute(
            f"DELETE FROM {self.db.t('tool_call')} WHERE id IN ("
            f"SELECT id FROM {self.db.t('tool_call')} "
            "WHERE run_id IS NULL AND created_at < $1 LIMIT $2)",
            cutoff,
            limit,
        )
        return int(status.split()[-1])
