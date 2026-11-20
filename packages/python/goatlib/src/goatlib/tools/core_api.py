"""Core's HTTP API for uploaded files.

Uploaded icons and images are core's: a job never reads or writes where core
keeps them, it calls core's asset routes. processes puts core's address
(`CORE_URL`, as the jobs reach it) into the job inputs. An export reads each
file from core's public file route and needs no token; an import uploads
them as the user with the access token processes gives it, as its first step
while the token is fresh. Nothing here refreshes a token: an expired one is
an error like any other.
"""

from __future__ import annotations

from pathlib import Path
from typing import Self

import httpx
from pydantic import BaseModel, Field

API_PREFIX = "/api/v2"
TIMEOUT = 60.0

_HIDDEN = {"x-ui": {"hidden": True}}


class CoreAddressInput(BaseModel):
    """Core's address, set by processes for a tool that calls core."""

    core_url: str | None = Field(
        default=None,
        description="Core's address as the job reaches it (set by processes)",
        json_schema_extra=_HIDDEN,
    )


class CoreTokenInput(BaseModel):
    """The user's access token, set by processes for a tool that calls core
    as the user."""

    access_token: str | None = Field(
        default=None,
        description="The user's access token (set by processes)",
        json_schema_extra=_HIDDEN,
    )


class CoreSession:
    """Calls core's API, with the user's access token when there is one."""

    def __init__(
        self: Self,
        core_url: str,
        access_token: str | None,
        *,
        client: httpx.Client | None = None,
    ) -> None:
        self.api = core_url.rstrip("/") + API_PREFIX
        self.access_token = access_token
        self._client = client or httpx.Client(timeout=TIMEOUT)

    def _send(self: Self, method: str, path: str, **kwargs: object) -> httpx.Response:
        headers = (
            {"Authorization": f"Bearer {self.access_token}"}
            if self.access_token
            else {}
        )
        response = self._client.request(
            method, self.api + path, headers=headers, **kwargs
        )
        response.raise_for_status()
        return response

    def download_upload(self: Self, asset_id: str, dest: Path) -> None:
        """An uploaded icon or image by its id, through core's public file
        route (a redirect to the file, followed; a token would not be sent to
        another host)."""
        response = self._send("GET", f"/asset/{asset_id}/file", follow_redirects=True)
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(response.content)

    def upload(
        self: Self,
        path: Path,
        file_name: str,
        mime_type: str | None,
        asset_type: str,
        display_name: str | None,
        category: str | None,
    ) -> str:
        """Upload a file as the user through core's upload route; core keeps
        it, records it (an identical file of the user's is reused) and returns
        its id. Core takes the file type from `file_name`."""
        data = {"asset_type": asset_type}
        name = display_name or (Path(file_name).stem if asset_type == "icon" else None)
        if name:
            data["display_name"] = name
        if category:
            data["category"] = category
        response = self._send(
            "POST",
            "/asset/upload",
            files={"file": (file_name, path.read_bytes(), mime_type)},
            data=data,
        )
        return str(response.json()["id"])

    def upload_ids(self: Self) -> set[str]:
        """The ids of the user's own uploads."""
        return {str(a["id"]) for a in self._send("GET", "/asset").json()}

    def delete_upload(self: Self, asset_id: str) -> None:
        """Delete one of the user's uploads."""
        self._send("DELETE", f"/asset/{asset_id}")

    def close(self: Self) -> None:
        self._client.close()
