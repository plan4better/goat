"""Test users and organizations for the end-to-end suite with auth on.

Creates the cast the role-based specs log in as, in Keycloak and, through
core's real API, in GOAT:

- owner, admin, editor, editor2, viewer: one organization (owner creates
  it, invites the other four, who accept); editor2 is a second editor, for
  specs where two members act independently (two users of one template);
- outsider: an organization of their own;
- newcomer, invitee: Keycloak users without an organization (onboarding,
  invitation acceptance).

With `--datasets`, the owner then uploads the suite's datasets
(`apps/web/playwright/fixtures/data`) the way the app does: a presigned PUT
to S3, then the `layer_import` job, which needs Windmill and its workers.

Writes them, with their ids, organization ids and dataset ids, to the JSON
file the Playwright setup and specs read. Idempotent: users, organizations,
memberships and datasets that already exist are reused, so a second run
changes nothing.

Only for a throwaway stack: it creates users with a known password.

    uv run python scripts/e2e/provision.py [--datasets]
"""

import argparse
import json
import os
import sys
import time
from pathlib import Path
from typing import Any

import httpx

KC_URL = os.environ.get("E2E_KEYCLOAK_URL", "http://localhost:8080").rstrip("/")
KC_REALM = os.environ.get("REALM_NAME", "goat")
KC_CLIENT_ID = os.environ.get("KEYCLOAK_CLIENT_ID", "goat")
KC_CLIENT_SECRET = os.environ["KEYCLOAK_CLIENT_SECRET"]
KC_ADMIN_USER = os.environ.get("E2E_KEYCLOAK_ADMIN", "admin")
KC_ADMIN_PASSWORD = os.environ["E2E_KEYCLOAK_ADMIN_PASSWORD"]
CORE_URL = (
    os.environ.get("E2E_CORE_URL", "http://localhost:8000").rstrip("/") + "/api/v2"
)
PROCESSES_URL = os.environ.get("E2E_PROCESSES_URL", "http://localhost:8300").rstrip("/")
PASSWORD = os.environ.get("E2E_PASSWORD", "E2e-Passw0rd!")
OUT = Path(os.environ.get("E2E_USERS_FILE", "apps/web/playwright/.auth/users.json"))

# The owner's first name is the built-in development user's, so specs that
# greet "GOAT" read the same with auth on and off.
CAST: dict[str, dict[str, str]] = {
    "owner": {"firstname": "GOAT", "lastname": "Owner"},
    "admin": {"firstname": "Ada", "lastname": "Admin"},
    "editor": {"firstname": "Ed", "lastname": "Editor"},
    "editor2": {"firstname": "Eva", "lastname": "Editor2"},
    "viewer": {"firstname": "Vi", "lastname": "Viewer"},
    "outsider": {"firstname": "Otto", "lastname": "Outsider"},
    "newcomer": {"firstname": "Nora", "lastname": "Newcomer"},
    "invitee": {"firstname": "Ivo", "lastname": "Invitee"},
}
MEMBERS = {
    "admin": "organization-admin",
    "editor": "organization-editor",
    "editor2": "organization-editor",
    "viewer": "organization-viewer",
}
ORGANIZATION = {
    # What the one-step onboarding form sends; the CRM fields (industry,
    # department, use case, location, phone) are gone with migration 0012.
    "type": "government",
    "region": "EU",
}


SETTINGS = {"preferred_language": "en", "client_theme": "light", "unit": "metric"}

# The owner's datasets, by key in the users file.
DATA_DIR = Path("apps/web/playwright/fixtures/data")
DATASETS = {
    "points": ("E2E Points", DATA_DIR / "points.geojson", "application/geo+json"),
    "table": ("E2E Table", DATA_DIR / "table.csv", "text/csv"),
    # Its own copy for the editing specs, so the others keep counting 26.
    "editable": (
        "E2E Editable Points",
        DATA_DIR / "points.geojson",
        "application/geo+json",
    ),
}
IMPORT_TIMEOUT_SECONDS = 300


def email(role: str) -> str:
    return f"e2e-{role}@goat.test"


def admin_token(client: httpx.Client) -> str:
    response = client.post(
        f"{KC_URL}/realms/master/protocol/openid-connect/token",
        data={
            "grant_type": "password",
            "client_id": "admin-cli",
            "username": KC_ADMIN_USER,
            "password": KC_ADMIN_PASSWORD,
        },
    )
    response.raise_for_status()
    return str(response.json()["access_token"])


def ensure_keycloak_user(client: httpx.Client, token: str, role: str) -> str:
    headers = {"Authorization": f"Bearer {token}"}
    users = f"{KC_URL}/admin/realms/{KC_REALM}/users"
    found = client.get(
        users, params={"email": email(role), "exact": "true"}, headers=headers
    )
    found.raise_for_status()
    if found.json():
        user_id = str(found.json()[0]["id"])
        # A user left by an earlier run may have another password: reset it,
        # so a rerun can always log in.
        client.put(
            f"{users}/{user_id}/reset-password",
            headers=headers,
            json={"type": "password", "value": PASSWORD, "temporary": False},
        ).raise_for_status()
        return user_id
    created = client.post(
        users,
        headers=headers,
        json={
            "username": email(role),
            "email": email(role),
            "firstName": CAST[role]["firstname"],
            "lastName": CAST[role]["lastname"],
            "enabled": True,
            "emailVerified": True,
            "requiredActions": [],
            "credentials": [
                {"type": "password", "value": PASSWORD, "temporary": False}
            ],
        },
    )
    created.raise_for_status()
    return str(created.headers["Location"].rsplit("/", 1)[-1])


def user_token(client: httpx.Client, role: str) -> str:
    response = client.post(
        f"{KC_URL}/realms/{KC_REALM}/protocol/openid-connect/token",
        data={
            "grant_type": "password",
            "client_id": KC_CLIENT_ID,
            "client_secret": KC_CLIENT_SECRET,
            "username": email(role),
            "password": PASSWORD,
            "scope": "openid",
        },
    )
    response.raise_for_status()
    return str(response.json()["access_token"])


def core(
    client: httpx.Client, token: str, method: str, path: str, **kwargs: Any
) -> httpx.Response:
    return client.request(
        method,
        f"{CORE_URL}{path}",
        headers={"Authorization": f"Bearer {token}"},
        **kwargs,
    )


def organization_of(client: httpx.Client, token: str) -> str | None:
    response = core(client, token, "GET", "/users/organization")
    return str(response.json()["id"]) if response.status_code == 200 else None


def ensure_organization(client: httpx.Client, token: str, name: str) -> str:
    existing = organization_of(client, token)
    if existing:
        return existing
    created = core(
        client, token, "POST", "/organizations", json={"name": name, **ORGANIZATION}
    )
    if created.status_code >= 300:
        sys.exit(
            f"creating organization {name!r} failed: {created.status_code} {created.text}"
        )
    return str(created.json()["id"])


def ensure_member(
    client: httpx.Client, owner_token: str, organization_id: str, role: str
) -> None:
    member_token = user_token(client, role)
    if organization_of(client, member_token) == organization_id:
        return
    invited = core(
        client,
        owner_token,
        "POST",
        f"/organizations/{organization_id}/invitations",
        json={"user_email": email(role), "role": MEMBERS[role]},
    )
    if invited.status_code >= 300:
        sys.exit(f"inviting {role} failed: {invited.status_code} {invited.text}")
    accepted = core(
        client, member_token, "PATCH", f"/users/invitations/{invited.json()['id']}"
    )
    if accepted.status_code >= 300:
        sys.exit(
            f"{role} accepting the invitation failed: {accepted.status_code} {accepted.text}"
        )


def home_folder(client: httpx.Client, token: str) -> str:
    folders = core(client, token, "GET", "/folder")
    folders.raise_for_status()
    # The list holds folders shared with the caller too, other users' homes
    # among them.
    return str(
        next(
            f["id"] for f in folders.json() if f["name"] == "home" and f.get("is_owned")
        )
    )


def ensure_dataset(client: httpx.Client, token: str, key: str) -> str:
    """Uploads one dataset and waits for its import, unless it exists."""
    name, path, content_type = DATASETS[key]
    found = core(client, token, "POST", "/layer", json={"search": name})
    found.raise_for_status()
    existing = [layer for layer in found.json()["items"] if layer["name"] == name]
    if existing:
        return str(existing[0]["id"])

    body = path.read_bytes()
    presigned = core(
        client,
        token,
        "POST",
        "/datasets/request-upload",
        json={
            "filename": path.name,
            "content_type": content_type,
            "file_size": len(body),
        },
    )
    presigned.raise_for_status()
    upload = presigned.json()
    put = client.put(upload["url"], content=body, headers=upload["headers"])
    if put.status_code >= 300:
        sys.exit(f"uploading {path.name} failed: {put.status_code} {put.text}")

    submitted = client.post(
        f"{PROCESSES_URL}/processes/layer_import/execution",
        headers={"Authorization": f"Bearer {token}"},
        json={
            "inputs": {
                "folder_id": home_folder(client, token),
                "name": name,
                "s3_key": upload["key"],
            }
        },
    )
    if submitted.status_code >= 300:
        sys.exit(
            f"importing {name!r} failed to start: {submitted.status_code} {submitted.text}"
        )
    job_id = submitted.json()["jobID"]

    deadline = time.monotonic() + IMPORT_TIMEOUT_SECONDS
    while time.monotonic() < deadline:
        job = client.get(
            f"{PROCESSES_URL}/jobs/{job_id}",
            headers={"Authorization": f"Bearer {token}"},
        ).json()
        if job.get("status") == "successful":
            # The import names the layers it creates.
            result = client.get(
                f"{PROCESSES_URL}/jobs/{job_id}/results",
                headers={"Authorization": f"Bearer {token}"},
            ).json()
            imported = result.get("result", {}).get("imported") or []
            if len(imported) != 1:
                sys.exit(f"importing {name!r} gave {json.dumps(result)}")
            layer_id = str(imported[0]["layer_id"])
            print(f"imported {name!r} as {layer_id}")
            return layer_id
        if job.get("status") in ("failed", "dismissed"):
            sys.exit(f"importing {name!r} failed: {json.dumps(job)}")
        time.sleep(2)
    sys.exit(f"importing {name!r} did not finish in {IMPORT_TIMEOUT_SECONDS}s")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--datasets",
        action="store_true",
        help="also upload the owner's datasets (needs Windmill)",
    )
    args = parser.parse_args()
    datasets: dict[str, str] = {}

    with httpx.Client(timeout=60) as client:
        token = admin_token(client)
        ids = {role: ensure_keycloak_user(client, token, role) for role in CAST}

        owner = user_token(client, "owner")
        organization_id = ensure_organization(client, owner, "E2E Organization")
        for role in MEMBERS:
            ensure_member(client, owner, organization_id, role)
        outsider_organization_id = ensure_organization(
            client, user_token(client, "outsider"), "E2E Other Organization"
        )
        # Listing folders provisions each member's personal space and home
        # folder, which the seed and the specs expect to exist. New users
        # default to German; the specs read the English labels.
        for role in ("owner", *MEMBERS, "outsider"):
            token = user_token(client, role)
            listed = core(client, token, "GET", "/folder")
            if listed.status_code >= 300:
                sys.exit(
                    f"provisioning {role}'s home folder failed: {listed.status_code} {listed.text}"
                )
            settings = core(client, token, "PUT", "/system/settings", json=SETTINGS)
            if settings.status_code >= 300:
                sys.exit(
                    f"setting {role}'s language failed: {settings.status_code} {settings.text}"
                )
        if args.datasets:
            owner = user_token(client, "owner")
            datasets = {key: ensure_dataset(client, owner, key) for key in DATASETS}

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(
        json.dumps(
            {
                "organization_id": organization_id,
                "outsider_organization_id": outsider_organization_id,
                "datasets": datasets,
                "users": {
                    role: {"id": ids[role], "email": email(role), **CAST[role]}
                    for role in CAST
                },
            },
            indent=2,
        )
    )
    print(f"provisioned {len(CAST)} users into {OUT}")


if __name__ == "__main__":
    main()
