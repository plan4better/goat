"""Stored connection credentials (spec §4.4).

A Fernet token over a JSON object, so a connection may hold several fields
(an AWS key pair, a service account key). ``MultiFernet`` decrypts with any
configured key and encrypts with the first, which is what rotation needs: put
the new key first, keep the old one behind it, run ``rotate``, then drop the
old key.

Command: ``python -m assistant.llm.vault rotate`` (exit code 1 when a stored
value could not be read with any configured key).
"""

import argparse
import asyncio
import json
import logging
import sys
from collections.abc import Mapping

from cryptography.fernet import Fernet, InvalidToken, MultiFernet

from assistant.config import AssistantSettings
from assistant.db import Database

logger = logging.getLogger(__name__)


class CredentialsUnreadable(Exception):  # noqa: N818
    """The stored credentials cannot be decrypted with the configured keys."""


class SecretBox:
    def __init__(self, keys: list[str]) -> None:
        if not keys:
            raise ValueError("SecretBox needs at least one key")
        self._fernet = MultiFernet([Fernet(key.encode()) for key in keys])

    @classmethod
    def from_settings(cls, settings: AssistantSettings) -> "SecretBox | None":
        keys = settings.secrets_keys()
        return cls(keys) if keys else None

    def encrypt(self, data: Mapping[str, str]) -> str:
        payload = json.dumps(dict(data), sort_keys=True).encode()
        return self._fernet.encrypt(payload).decode()

    def decrypt(self, token: str) -> dict[str, str]:
        try:
            raw = self._fernet.decrypt(token.encode())
        except InvalidToken as exc:
            raise CredentialsUnreadable() from exc
        try:
            value = json.loads(raw)
        except ValueError as exc:
            raise CredentialsUnreadable() from exc
        if not isinstance(value, dict):
            raise CredentialsUnreadable()
        return {str(key): str(item) for key, item in value.items()}

    def rotate(self, token: str) -> str:
        try:
            return self._fernet.rotate(token.encode()).decode()
        except InvalidToken as exc:
            raise CredentialsUnreadable() from exc


async def rotate_all(db: Database, box: SecretBox) -> tuple[int, int]:
    """Re-encrypt every stored connection with the newest key, in one
    transaction. Returns (rotated, unreadable)."""
    rotated = unreadable = 0
    async with db.pool.acquire() as conn, conn.transaction():
        records = await conn.fetch(
            f"SELECT id, credentials_encrypted FROM {db.t('connection')} FOR UPDATE"
        )
        for record in records:
            try:
                token = box.rotate(record["credentials_encrypted"])
            except CredentialsUnreadable:
                unreadable += 1
                logger.warning(
                    "Connection %s: the credentials cannot be read with any configured key",
                    record["id"],
                )
                continue
            await conn.execute(
                f"UPDATE {db.t('connection')} SET credentials_encrypted = $2 WHERE id = $1",
                record["id"],
                token,
            )
            rotated += 1
    return rotated, unreadable


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m assistant.llm.vault",
        description="Re-encrypt stored connection credentials with the newest ASSISTANT_SECRETS_KEY.",
    )
    parser.add_argument("command", choices=["rotate"])
    parser.parse_args(argv)
    settings = AssistantSettings()
    box = SecretBox.from_settings(settings)
    if box is None:
        print("ASSISTANT_SECRETS_KEY is not set.", file=sys.stderr)
        return 2

    async def run() -> tuple[int, int]:
        db = Database(settings)
        await db.connect()
        try:
            return await rotate_all(db, box)
        finally:
            await db.close()

    rotated, unreadable = asyncio.run(run())
    print(f"Re-encrypted {rotated} connection(s); {unreadable} could not be read.")
    return 1 if unreadable else 0


if __name__ == "__main__":
    raise SystemExit(main())
