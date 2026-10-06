from fastapi import APIRouter

from . import (
    asset,
    bundle,
    content,
    credits,
    custom_domain_lookup,
    datasets,
    favorite,
    folder,
    layer,
    organization_analytics,
    organization_domain,
    organizations,
    project,
    project_group,
    project_layer,
    project_public,
    report_layout,
    share,
    space,
    support,
    system,
    teams,
    template,
    transfer,
    users,
    webhooks,
    workflow,
)

router = APIRouter()

router.include_router(
    organizations.router, prefix="/organizations", tags=["Organizations"]
)
router.include_router(credits.router, prefix="/credits", tags=["Credits"])
router.include_router(teams.router, prefix="/teams", tags=["Teams"])
router.include_router(space.router, prefix="/space", tags=["Space"])
router.include_router(users.router, prefix="/users", tags=["Users"])
router.include_router(share.router, prefix="/share", tags=["Share"])
router.include_router(support.router, prefix="/support", tags=["Support"])
router.include_router(webhooks.router, prefix="/webhooks", tags=["Webhooks"])

router.include_router(favorite.router, prefix="/favorite", tags=["Favorite"])
router.include_router(folder.router, prefix="/folder", tags=["Folder"])
router.include_router(bundle.router, prefix="/bundle", tags=["Bundle"])
router.include_router(layer.router, prefix="/layer", tags=["Layer"])
router.include_router(project.router, prefix="/project", tags=["Project"])
router.include_router(project_layer.router, prefix="/project", tags=["Project Layers"])
router.include_router(project_public.router, prefix="/project", tags=["Project Public"])
router.include_router(
    project_group.router, prefix="/project", tags=["Project Layer Groups"]
)
router.include_router(report_layout.router, prefix="/project", tags=["Report Layout"])
router.include_router(workflow.router, prefix="/project", tags=["Workflow"])
router.include_router(system.router, prefix="/system", tags=["System Settings"])
router.include_router(asset.router, prefix="/asset", tags=["Asset"])
router.include_router(datasets.router, prefix="/datasets", tags=["Datasets"])
router.include_router(content.router, prefix="/content", tags=["Content"])
router.include_router(template.router, prefix="/template", tags=["Template"])
router.include_router(transfer.router, prefix="/content/transfer", tags=["Transfer"])
router.include_router(
    organization_domain.router,
    prefix="/organizations",
    tags=["Organization Domain"],
)
router.include_router(
    organization_analytics.router,
    prefix="/organizations",
    tags=["Organization Analytics"],
)
router.include_router(
    custom_domain_lookup.router,
    tags=["Custom Domain Lookup"],
)
