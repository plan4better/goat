from uuid import UUID

from fastapi import APIRouter, Body, Depends, Request
from pydantic import UUID4
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from core.accounts.sync import report_language
from core.crud.crud_system_setting import system_setting as crud_system_setting
from core.crud.crud_user import user as crud_user
from core.deps.auth import auth_z, user_token
from core.deps.keycloak import report_locale
from core.endpoints.deps import get_db, get_user_id
from core.schemas.system_setting import (
    SystemSettingsCreate,
    SystemSettingsRead,
    SystemSettingsUpdate,
    default_system_settings,
)
from core.schemas.system_setting import (
    request_examples as system_settings_request_examples,
)

router = APIRouter()

GOAT_LANGUAGES = ("de", "en")


def _initial_language(token: dict, accept_language: str | None) -> str:
    """A new user's GOAT language: the one Keycloak keeps for them (picked on its
    pages), else the browser's first GOAT language, else GOAT's default."""
    weighted = []
    for position, part in enumerate((accept_language or "").split(",")):
        tag, _, params = part.partition(";")
        q = (
            params.strip().removeprefix("q=")
            if params.strip().startswith("q=")
            else "1"
        )
        try:
            weight = float(q)
        except ValueError:
            weight = 0.0
        weighted.append((-weight, position, tag))
    browser = [tag for _, _, tag in sorted(weighted)]
    for candidate in (token.get("locale"), *browser):
        code = str(candidate or "").strip().lower().split("-")[0]
        if code in GOAT_LANGUAGES:
            return code
    return default_system_settings.preferred_language.value


# Not behind auth_z: a user reads only their own settings, also while their
# organization is suspended, so its page shows in their language. The token is
# still verified (user_token), as for /users/organization.
@router.get(
    "/settings",
    summary="Retrieve system settings",
    response_model=SystemSettingsRead,
    status_code=200,
)
async def read_system_settings(
    *,
    request: Request,
    async_session: AsyncSession = Depends(get_db),
    token: dict = Depends(user_token),
) -> SystemSettingsRead:
    """Retrieve system settings"""
    user_id = UUID(token["sub"])

    existing_settings = await crud_system_setting.get_by_multi_keys(
        async_session, keys={"user_id": user_id}
    )

    if not existing_settings or len(existing_settings) == 0:
        # A user who just signed up has no row yet (the workspace provisions it),
        # and the settings point to it: create it from the verified token, without
        # reporting the sign-up anywhere.
        lang = _initial_language(token, request.headers.get("accept-language"))
        default_system_settings_obj_in = SystemSettingsCreate(
            **{**default_system_settings.model_dump(), "preferred_language": lang}
        )
        default_system_settings_obj_in.user_id = user_id
        try:
            await crud_user.upsert_from_token(token=token, db_session=async_session)
            created = await crud_system_setting.create(
                async_session, obj_in=default_system_settings_obj_in
            )
        except IntegrityError:
            # A parallel first request (the layout and the page both ask) created
            # the user or the settings first: use what it wrote.
            await async_session.rollback()
            existing_settings = await crud_system_setting.get_by_multi_keys(
                async_session, keys={"user_id": user_id}
            )
            if not existing_settings:
                raise
            return SystemSettingsRead(**existing_settings[0].model_dump())
        # Keycloak's pages and emails start in the same language.
        if token.get("locale") != lang:
            report_locale(str(user_id), lang)
        return SystemSettingsRead(**created.model_dump())

    return SystemSettingsRead(**existing_settings[0].model_dump())


@router.put(
    "/settings",
    summary="Update system settings",
    response_model=SystemSettingsRead,
    status_code=200,
    dependencies=[Depends(auth_z)],
)
async def update_system_settings(
    *,
    async_session: AsyncSession = Depends(get_db),
    user_id: UUID4 = Depends(get_user_id),
    system_settings_in: SystemSettingsUpdate = Body(
        ..., examples=[system_settings_request_examples["update"]]
    ),
) -> SystemSettingsRead:
    """Update system settings"""

    if system_settings_in.preferred_language:
        lang = system_settings_in.preferred_language
        report_language(user_id, lang)
        # Keycloak's pages and emails follow the language chosen in GOAT.
        report_locale(str(user_id), str(getattr(lang, "value", lang)))

    existing_settings = await crud_system_setting.get_by_multi_keys(
        async_session, keys={"user_id": user_id}
    )

    if not existing_settings or len(existing_settings) == 0:
        # A first save: the defaults, with what the request sets on top. The
        # update schema leaves every field optional, so it cannot stand in
        # for a full row on its own.
        new_system_settings = SystemSettingsCreate(
            **{
                **default_system_settings.model_dump(),
                **system_settings_in.model_dump(exclude_unset=True, exclude_none=True),
                "user_id": user_id,
            }
        )

        return SystemSettingsRead(
            **(
                await crud_system_setting.create(
                    async_session, obj_in=new_system_settings
                )
            ).model_dump()
        )

    return SystemSettingsRead(
        **(
            await crud_system_setting.update(
                async_session, db_obj=existing_settings[0], obj_in=system_settings_in
            )
        ).model_dump()
    )
