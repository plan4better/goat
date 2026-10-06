"""GOAT Odoo configurator — all Odoo-side setup in one replayable CLI.

Implements the single-product commercial model + entitlement wiring decided
2026-07-16 (see docs/odoo-entitlement-contract.md):

Subcommands:
    probe             read-only: automation/webhook capabilities + GOAT fields
    catalog           one "GOAT" base product + per-unit add-ons, archive tiers
    white-label       x_goat_white_label checkbox on subscriptions (GOAT tab)
    remove-plan-name  drop the legacy x_goat_plan_name field + view usages
    automation        automation rule + webhook action -> Windmill
                      (requires --webhook-url)
    all               catalog, white-label, remove-plan-name, automation

Credentials come from the environment, so the API key never appears on a
command line:

    export ODOO_URL=https://odoo-staging.example.org
    export ODOO_DB=odoo-staging
    export ODOO_ADMIN_LOGIN=admin@example.org   # an admin's login (XML-RPC)
    export ODOO_ADMIN_KEY=...                   # and their API key

Usage:
    python3 scripts/odoo/odoo_setup.py <subcommand>            # dry-run
    python3 scripts/odoo/odoo_setup.py <subcommand> --apply    # write

Safety: refuses non-staging hosts unless --allow-prod. Every subcommand is
idempotent — rerunning after --apply reports "already up to date". Nothing is
ever deleted except the legacy plan-name field; tier products are archived,
not removed. Staging rebuilds wipe all of this: rerun `all` afterwards.
"""

import argparse
import os
import re
import sys
import xmlrpc.client
from typing import Any

GB = 1024  # MB per GB

# --- catalog ----------------------------------------------------------------
# Products are identified by OUR external ids (ir.model.data), not database
# ids: db ids differ between instances and names get renamed by this very
# script. Resolution order per product:
#   1. external id (stable once bound)
#   2. adoption: exact-name match on any known past/current name -> bind the
#      external id to that record (one-time)
#   3. create it (unless create=False, e.g. legacy tiers: nothing to archive
#      on an instance that never had them)
XID_MODULE = "goat_billing"

PRODUCT_SPECS: list[dict] = [
    {
        "xid": "product_goat_base",
        "adopt_names": ("GOAT", "GOAT Starter"),
        "values": {
            "name": "GOAT",
            "x_goat_editors": 3,
            "x_goat_viewers": 2,
            "x_goat_storage_mb": 5 * GB,
            "x_goat_projects": 50,
        },
        "create": True,
    },
    {
        "xid": "product_goat_extra_editor",
        "adopt_names": ("GOAT Extra Editor User",),
        "values": {"name": "GOAT Extra Editor User", "x_goat_editors": 1},
        "create": True,
    },
    {
        "xid": "product_goat_extra_viewer",
        "adopt_names": ("GOAT Extra Viewer User",),
        "values": {"name": "GOAT Extra Viewer User", "x_goat_viewers": 1},
        "create": True,
    },
    {
        "xid": "product_goat_extra_project",
        "adopt_names": ("GOAT Extra Project", "GOAT Extra Projects (10)"),
        "values": {"name": "GOAT Extra Project", "x_goat_projects": 1},
        "create": True,
    },
    {
        "xid": "product_goat_extra_storage",
        "adopt_names": ("GOAT Extra Storage (GB)", "GOAT Extra Storage (100 GB)"),
        "values": {"name": "GOAT Extra Storage (GB)", "x_goat_storage_mb": 1 * GB},
        "create": True,
    },
    {
        "xid": "product_goat_tier_professional",
        "adopt_names": ("GOAT Professional",),
        "values": {"active": False},
        "create": False,
    },
    {
        "xid": "product_goat_tier_enterprise",
        "adopt_names": ("GOAT Enterprise",),
        "values": {"active": False},
        "create": False,
    },
]
# applied only when this script creates a product from scratch
PRODUCT_CREATE_DEFAULTS = {
    "type": "service",
    "recurring_invoice": True,
    "list_price": 0.0,
}
PRODUCT_FIELDS = [
    "name",
    "active",
    "x_goat_editors",
    "x_goat_viewers",
    "x_goat_storage_mb",
    "x_goat_projects",
]

# --- white-label checkbox ----------------------------------------------------
WL_FIELD = "x_goat_white_label"
WL_ANCHOR = '<field name="x_goat_viewers"/>'
SALE_VIEW_NAME = "sale.order.form.goat.entitlements"
PRODUCT_VIEW_NAME = "product.template.form.goat.entitlements"

# --- legacy plan-name removal -------------------------------------------------
PLAN_FIELD = "x_goat_plan_name"
PLAN_FIELD_MODELS = ["product.template", "sale.order"]
PLAN_VIEW_NAMES = [PRODUCT_VIEW_NAME, SALE_VIEW_NAME]

# --- entitlement automation ---------------------------------------------------
AUTOMATION_NAME = "GOAT: push entitlement to Windmill"
ACTION_NAME = "GOAT: entitlement webhook"
TRIGGER_FIELDS = [
    "subscription_state",
    "next_invoice_date",
    "order_line",
    "x_goat_organization_id",
    "x_goat_editors",
    "x_goat_viewers",
    "x_goat_projects",
    "x_goat_storage_mb",
    WL_FIELD,
]
WEBHOOK_FIELDS = ["x_goat_organization_id"]
FILTER_DOMAIN = "[('is_subscription', '=', True)]"


class OdooClient:
    """XML-RPC connection with creds from the environment (see the module doc)."""

    def __init__(self, apply: bool) -> None:
        self.url, self.db = os.environ["ODOO_URL"], os.environ["ODOO_DB"]
        self._key = os.environ["ODOO_ADMIN_KEY"]
        self.apply = apply

        common = xmlrpc.client.ServerProxy(f"{self.url}/xmlrpc/2/common")
        self.uid = common.authenticate(
            self.db, os.environ["ODOO_ADMIN_LOGIN"], self._key, {}
        )
        if not self.uid:
            raise SystemExit(f"ABORT: authentication failed against {self.url}")
        self._models = xmlrpc.client.ServerProxy(f"{self.url}/xmlrpc/2/object")
        print(f"Connected to {self.url} db={self.db} as uid={self.uid}")
        print(f"Mode: {'APPLY' if apply else 'DRY-RUN (no writes)'}\n")

    def kw(self, model: str, method: str, *a: Any, **k: Any) -> Any:
        return self._models.execute_kw(
            self.db, self.uid, self._key, model, method, list(a), k
        )

    def field_ids(self, model: str, names: list[str]) -> tuple[list[int], list[str]]:
        recs = self.kw(
            "ir.model.fields",
            "search_read",
            [("model", "=", model), ("name", "in", names)],
            fields=["id", "name"],
        )
        found = {r["name"]: r["id"] for r in recs}
        return [found[n] for n in names if n in found], [
            n for n in names if n not in found
        ]

    def view_by_name(self, name: str) -> dict | None:
        views = self.kw(
            "ir.ui.view", "search_read", [("name", "=", name)], fields=["id", "arch_db"]
        )
        return views[0] if views else None


# ---------------------------------------------------------------------------


def cmd_probe(c: OdooClient, _args: argparse.Namespace) -> int:
    f = c.kw(
        "ir.actions.server",
        "fields_get",
        ["state", "webhook_url", "webhook_field_ids"],
        ["string", "selection"],
    )
    print("server action types:", [s[0] for s in f["state"]["selection"]])
    print(
        "has webhook_url / webhook_field_ids:",
        "webhook_url" in f,
        "/",
        "webhook_field_ids" in f,
    )
    fa = c.kw("base.automation", "fields_get", ["trigger"], ["selection"])
    print("automation triggers:", [t[0] for t in fa["trigger"]["selection"]])
    fs = c.kw(
        "sale.order",
        "fields_get",
        [
            "subscription_state",
            "is_subscription",
            "next_invoice_date",
            "x_goat_organization_id",
            WL_FIELD,
        ],
        ["string", "selection"],
    )
    print("sale.order fields present:", sorted(fs.keys()))
    if "subscription_state" in fs:
        print("subscription_state options:", fs["subscription_state"]["selection"])
    return 0


def _resolve_product(c: OdooClient, spec: dict) -> tuple[int | None, str]:
    """Resolve a managed product: external id -> name adoption -> not found.

    Returns (product_id or None, how) where how explains the resolution and
    is used for logging. Cleans up a dangling external id (bound record was
    deleted) so adoption/creation can proceed.
    """
    xid = spec["xid"]
    data = c.kw(
        "ir.model.data",
        "search_read",
        [("module", "=", XID_MODULE), ("name", "=", xid)],
        fields=["id", "res_id"],
    )
    if data:
        res_id = data[0]["res_id"]
        exists = c.kw(
            "product.template",
            "search",
            [("id", "=", res_id)],
            context={"active_test": False},
        )
        if exists:
            return res_id, "external id"
        print(f"[{xid}] external id points at deleted product {res_id} — rebinding")
        if c.apply:
            c.kw("ir.model.data", "unlink", [data[0]["id"]])

    for name in spec["adopt_names"]:
        matches = c.kw(
            "product.template",
            "search",
            [("name", "=", name)],
            context={"active_test": False},
        )
        if len(matches) > 1:
            raise LookupError(
                f"[{xid}] ambiguous: {len(matches)} products named '{name}' "
                f"(ids {matches}) — resolve manually"
            )
        if matches:
            return matches[0], f"adopted by name '{name}'"
    return None, "not found"


def _bind_xid(c: OdooClient, xid: str, product_id: int) -> None:
    if c.apply:
        c.kw(
            "ir.model.data",
            "create",
            {
                "module": XID_MODULE,
                "name": xid,
                "model": "product.template",
                "res_id": product_id,
                "noupdate": True,
            },
        )


def cmd_catalog(c: OdooClient, _args: argparse.Namespace) -> int:
    failures = 0
    for spec in PRODUCT_SPECS:
        xid = spec["xid"]
        try:
            product_id, how = _resolve_product(c, spec)
        except LookupError as exc:
            print(exc)
            failures += 1
            continue

        if product_id is None:
            if not spec["create"]:
                print(f"[{xid}] not found — nothing to do (legacy product)")
                continue
            values = {**PRODUCT_CREATE_DEFAULTS, **spec["values"]}
            print(f"[{xid}] will CREATE '{spec['values']['name']}' with {values}")
            if c.apply:
                product_id = c.kw("product.template", "create", values)
                _bind_xid(c, xid, product_id)
                print(f"[{xid}] created (id {product_id}), external id bound")
            continue

        if how != "external id":
            print(f"[{xid}] {how} (id {product_id}) — will bind external id")
            _bind_xid(c, xid, product_id)

        rec = c.kw(
            "product.template",
            "read",
            [product_id],
            fields=PRODUCT_FIELDS,
            context={"active_test": False},
        )[0]
        diff = {f: v for f, v in spec["values"].items() if rec[f] != v}
        if not diff:
            print(f"[{xid}] '{rec['name']}' (id {product_id}): already up to date")
            continue
        pretty = ", ".join(f"{f}: {rec[f]!r} -> {v!r}" for f, v in diff.items())
        print(f"[{xid}] '{rec['name']}' (id {product_id}): {pretty}")
        if c.apply:
            c.kw("product.template", "write", [product_id], diff)
            print(f"[{xid}] written")
    if failures:
        print(f"{failures} product(s) unresolved — review before trusting the result.")
    return 1 if failures else 0


def cmd_white_label(c: OdooClient, _args: argparse.Namespace) -> int:
    existing = c.kw(
        "ir.model.fields",
        "search_read",
        [("model", "=", "sale.order"), ("name", "=", WL_FIELD)],
        fields=["id"],
    )
    if existing:
        print(f"field {WL_FIELD}: already exists (id {existing[0]['id']})")
    else:
        model_id = c.kw("ir.model", "search", [("model", "=", "sale.order")], limit=1)[
            0
        ]
        print(f"field {WL_FIELD}: will create on sale.order")
        if c.apply:
            fid = c.kw(
                "ir.model.fields",
                "create",
                {
                    "name": WL_FIELD,
                    "model": "sale.order",
                    "model_id": model_id,
                    "field_description": "GOAT White Label",
                    "ttype": "boolean",
                    "state": "manual",
                    "copied": True,
                },
            )
            print(f"field {WL_FIELD}: created (id {fid})")

    view = c.view_by_name(SALE_VIEW_NAME)
    if view is None:
        print(f"ABORT: view '{SALE_VIEW_NAME}' not found — was the GOAT tab set up?")
        return 1
    arch = view["arch_db"]
    if WL_FIELD in arch:
        print(f"view {view['id']}: checkbox already present")
    elif WL_ANCHOR not in arch:
        print(
            f"ABORT: anchor {WL_ANCHOR!r} not found in view {view['id']} — arch "
            "drifted, insert manually. Current arch:\n" + arch
        )
        return 1
    else:
        print(f"view {view['id']}: will insert checkbox after {WL_ANCHOR}")
        if c.apply:
            c.kw(
                "ir.ui.view",
                "write",
                [view["id"]],
                {
                    "arch_db": arch.replace(
                        WL_ANCHOR,
                        WL_ANCHOR + "\n" + " " * 24 + f'<field name="{WL_FIELD}"/>',
                    )
                },
            )
            print(f"view {view['id']}: written")
    return 0


def cmd_remove_plan_name(c: OdooClient, _args: argparse.Namespace) -> int:
    element_re = re.compile(r"[ \t]*<field[^>]*name=\"" + PLAN_FIELD + r"\"[^>]*/>\n?")
    for view_name in PLAN_VIEW_NAMES:
        view = c.view_by_name(view_name)
        if view is None:
            print(f"view '{view_name}': not found, skipping")
            continue
        arch = view["arch_db"]
        if PLAN_FIELD not in arch:
            print(f"view {view['id']} ('{view_name}'): field not present")
            continue
        new_arch, n = element_re.subn("", arch)
        if PLAN_FIELD in new_arch:
            print(
                f"ABORT: view {view['id']} still references {PLAN_FIELD} after "
                "element removal — remove manually. Current arch:\n" + arch
            )
            return 1
        print(f"view {view['id']} ('{view_name}'): will remove {n} element(s)")
        if c.apply:
            c.kw("ir.ui.view", "write", [view["id"]], {"arch_db": new_arch})
            print(f"view {view['id']}: written")

    for model in PLAN_FIELD_MODELS:
        recs = c.kw(
            "ir.model.fields",
            "search_read",
            [("model", "=", model), ("name", "=", PLAN_FIELD)],
            fields=["id", "state"],
        )
        if not recs:
            print(f"field {PLAN_FIELD} on {model}: already gone")
            continue
        rec = recs[0]
        if rec["state"] != "manual":
            print(
                f"ABORT: field {PLAN_FIELD} on {model} has state '{rec['state']}' — "
                "defined in code, cannot unlink via RPC."
            )
            return 1
        print(f"field {PLAN_FIELD} on {model}: will delete (id {rec['id']})")
        if c.apply:
            c.kw("ir.model.fields", "unlink", [rec["id"]])
            print(f"field {PLAN_FIELD} on {model}: deleted")
    return 0


def cmd_automation(c: OdooClient, args: argparse.Namespace) -> int:
    if not args.webhook_url:
        print(
            "ABORT: automation requires --webhook-url (Windmill webhook of "
            "f/goat/tasks/odoo_entitlement_push, token included)"
        )
        return 1

    model_id = c.kw("ir.model", "search", [("model", "=", "sale.order")], limit=1)[0]
    trigger_ids, trigger_missing = c.field_ids("sale.order", TRIGGER_FIELDS)
    webhook_ids, webhook_missing = c.field_ids("sale.order", WEBHOOK_FIELDS)
    if trigger_missing:
        print(
            f"WARNING: trigger fields missing on sale.order: {trigger_missing} "
            "(run the white-label subcommand?) — continuing without them"
        )
    if webhook_missing:
        print(f"ABORT: webhook payload fields missing: {webhook_missing}")
        return 1

    automation_values = {
        "name": AUTOMATION_NAME,
        "model_id": model_id,
        "trigger": "on_create_or_write",
        "filter_domain": FILTER_DOMAIN,
        "trigger_field_ids": [(6, 0, trigger_ids)],
        "active": True,
    }
    existing = c.kw(
        "base.automation",
        "search_read",
        [("name", "=", AUTOMATION_NAME)],
        fields=["id"],
        context={"active_test": False},
    )
    if existing:
        automation_id = existing[0]["id"]
        print(f"automation {automation_id}: exists, will update trigger config")
        if c.apply:
            c.kw("base.automation", "write", [automation_id], automation_values)
    else:
        print(f"automation: will create '{AUTOMATION_NAME}'")
        automation_id = None
        if c.apply:
            automation_id = c.kw("base.automation", "create", automation_values)
            print(f"automation: created (id {automation_id})")

    action_values = {
        "name": ACTION_NAME,
        "model_id": model_id,
        "state": "webhook",
        "webhook_url": args.webhook_url,
        "webhook_field_ids": [(6, 0, webhook_ids)],
        "usage": "base_automation",
    }
    if automation_id is not None:
        action_values["base_automation_id"] = automation_id

    existing_action = c.kw(
        "ir.actions.server",
        "search_read",
        [("name", "=", ACTION_NAME)],
        fields=["id", "webhook_url"],
    )
    if existing_action:
        action_id = existing_action[0]["id"]
        print(
            f"server action {action_id}: exists "
            f"(url {existing_action[0]['webhook_url']!r} -> {args.webhook_url!r})"
        )
        if c.apply:
            c.kw("ir.actions.server", "write", [action_id], action_values)
            print(f"server action {action_id}: updated")
    else:
        print(f"server action: will create '{ACTION_NAME}' -> {args.webhook_url}")
        if c.apply:
            if automation_id is None:
                print("ABORT: automation id unknown (dry-run artifact?)")
                return 1
            action_id = c.kw("ir.actions.server", "create", action_values)
            print(f"server action: created (id {action_id})")
    return 0


def cmd_all(c: OdooClient, args: argparse.Namespace) -> int:
    steps = [
        ("catalog", cmd_catalog),
        ("white-label", cmd_white_label),
        ("remove-plan-name", cmd_remove_plan_name),
    ]
    if args.webhook_url:
        steps.append(("automation", cmd_automation))
    else:
        print("NOTE: no --webhook-url given — skipping the automation step.\n")
    rc = 0
    for name, fn in steps:
        print(f"===== {name} =====")
        rc = max(rc, fn(c, args))
        print()
    return rc


COMMANDS = {
    "probe": cmd_probe,
    "catalog": cmd_catalog,
    "white-label": cmd_white_label,
    "remove-plan-name": cmd_remove_plan_name,
    "automation": cmd_automation,
    "all": cmd_all,
}


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("command", choices=COMMANDS)
    parser.add_argument("--apply", action="store_true", help="write changes")
    parser.add_argument(
        "--allow-prod", action="store_true", help="permit a non-staging host"
    )
    parser.add_argument(
        "--webhook-url",
        default=None,
        help="Windmill webhook URL (automation / all subcommands)",
    )
    args = parser.parse_args()

    url = os.environ["ODOO_URL"]
    if "staging" not in url and not args.allow_prod:
        print(f"ABORT: {url} does not look like staging (use --allow-prod).")
        return 1

    client = OdooClient(apply=args.apply)
    rc = COMMANDS[args.command](client, args)
    if args.command != "probe":
        print("Done." if args.apply else "Dry-run complete. Re-run with --apply.")
    return rc


if __name__ == "__main__":
    sys.exit(main())
