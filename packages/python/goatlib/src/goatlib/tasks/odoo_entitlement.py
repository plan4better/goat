"""Odoo -> GOAT entitlement adapter (see docs/odoo-entitlement-contract.md).

GOAT core is billing-agnostic: it only exposes
``POST /api/v2/webhooks/odoo/entitlement`` and enforces the entitlement state
on the organization row. This task is the adapter in between: it reads a
subscription (``sale.order``) from Odoo over XML-RPC, computes the
entitlement, and POSTs it to core.

Entitlement math::

    total_<quota> = sum(line qty x product.x_goat_<quota>)   # base product
                                                             # included: its
                                                             # own line carries
                                                             # the base values
    subscription-level x_goat_<quota> > 0  ->  override wins (negotiated deals)

Premium features: ``sale.order.x_goat_white_label`` checkbox -> ``extras``
grant-list (``["white_label"]`` / ``[]``).

Two modes, one task:
  * ``order_id > 0``  — push that subscription (live path: Odoo automation
    rule -> Windmill webhook -> this task).
  * ``order_id == 0`` — reconcile: push every subscription in a pushable
    state that is linked to a GOAT organization (nightly schedule; heals
    missed webhooks and doubles as the initial backfill).

Required environment (Windmill variables/secrets):
    ODOO_URL, ODOO_DB                            — Plan4Better's Odoo (shared)
    ODOO_BILLING_USER, ODOO_BILLING_API_KEY      — the billing user's XML-RPC
                                                   login (the user goes away
                                                   with JSON-2, see core.odoo)
    CORE_URL                                     — GOAT core base URL
    ODOO_WEBHOOK_SECRET                          — shared secret for core

Windmill path: f/goat/tasks/odoo_entitlement_push
"""

import logging
import os
import xmlrpc.client
from typing import Any, Self

import httpx
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)

__all__ = ["OdooEntitlementPushParams", "OdooEntitlementTask", "main"]

# subscription_state values (Odoo 19 sale_subscription) worth pushing.
# Draft/renewal/upsell quotations describe future state; '5_renewed' means a
# newer subscription supersedes this one (that one gets pushed instead).
PUSHABLE_STATES = {"3_progress", "4_paused", "6_churn"}
SUSPENDED_STATES = {"4_paused", "6_churn"}

# payload quota key -> x_goat field name (on products AND on the order)
QUOTA_FIELDS = {
    "total_editors": "x_goat_editors",
    "total_viewers": "x_goat_viewers",
    "total_projects": "x_goat_projects",
    "total_storage": "x_goat_storage_mb",
}

# order-level feature checkboxes -> extras entries. Extend as features are
# added in Odoo (checkbox on the GOAT tab) and gated in core (resource.extras).
FEATURE_FIELDS = {
    "x_goat_white_label": "white_label",
}


class OdooEntitlementPushParams(BaseModel):
    order_id: int = Field(
        default=0,
        description=(
            "Odoo sale.order id to push. 0 = reconcile all pushable "
            "subscriptions linked to a GOAT organization."
        ),
    )


def compute_entitlement(
    order: dict[str, Any], lines: list[dict[str, Any]]
) -> dict[str, Any] | None:
    """Compute the entitlement payload for one subscription. Pure function.

    Args:
        order: sale.order fields (subscription_state, next_invoice_date,
            x_goat_organization_id, x_goat_* overrides, feature checkboxes).
        lines: one dict per order line with ``qty`` and the product's
            ``x_goat_*`` values.

    Returns:
        The payload for POST /webhooks/odoo/entitlement, or None when the
        subscription is not in a pushable state or has no organization link.
    """
    state = order.get("subscription_state")
    if state not in PUSHABLE_STATES:
        return None
    organization_id = order.get("x_goat_organization_id")
    if not organization_id:
        return None

    payload: dict[str, Any] = {"organization_id": organization_id}

    for quota_key, field in QUOTA_FIELDS.items():
        override = order.get(field) or 0
        if override > 0:
            payload[quota_key] = override
        else:
            payload[quota_key] = sum(
                line["qty"] * (line.get(field) or 0) for line in lines
            )

    payload["extras"] = [
        feature for field, feature in FEATURE_FIELDS.items() if order.get(field)
    ]

    renewal = order.get("next_invoice_date")
    if renewal:
        payload["plan_renewal_date"] = str(renewal)

    payload["suspended"] = state in SUSPENDED_STATES
    # A real subscription exists, so whatever trial the org started on is
    # over — conversion clears the trial flag (and unsuspends an org that a
    # trial expiry had suspended, via `suspended` above).
    payload["on_trial"] = False
    # used_credits metering is phase 2; until then renewals have nothing to
    # reset and mid-cycle pushes must not zero anything.
    payload["reset_usage"] = False
    return payload


class OdooEntitlementTask:
    """XML-RPC read from Odoo -> compute -> POST to core."""

    ORDER_FIELDS = [
        "name",
        "subscription_state",
        "next_invoice_date",
        "x_goat_organization_id",
        "order_line",
        *QUOTA_FIELDS.values(),
        *FEATURE_FIELDS.keys(),
    ]

    def __init__(self: Self) -> None:
        self.odoo_url = os.environ["ODOO_URL"].rstrip("/")
        self.odoo_db = os.environ["ODOO_DB"]
        self.odoo_user = os.environ["ODOO_BILLING_USER"]
        self.odoo_key = os.environ["ODOO_BILLING_API_KEY"]
        # required only when actually pushing (see push_order); the CLI
        # --dry-run mode works without a running core.
        self.core_url = (os.environ.get("CORE_URL") or "").rstrip("/")
        self.webhook_secret = os.environ.get("ODOO_WEBHOOK_SECRET") or ""

        common = xmlrpc.client.ServerProxy(f"{self.odoo_url}/xmlrpc/2/common")
        self._uid = common.authenticate(self.odoo_db, self.odoo_user, self.odoo_key, {})
        if not self._uid:
            raise RuntimeError(f"Odoo authentication failed against {self.odoo_url}")
        self._models = xmlrpc.client.ServerProxy(f"{self.odoo_url}/xmlrpc/2/object")
        self._order_fields = self._available_order_fields()

    def _kw(self: Self, model: str, method: str, *args: Any, **kwargs: Any) -> Any:
        return self._models.execute_kw(
            self.odoo_db, self._uid, self.odoo_key, model, method, list(args), kwargs
        )

    def _available_order_fields(self: Self) -> list[str]:
        """Intersect wanted fields with what exists (x_goat_* are manual
        fields; a missing checkbox must not break the whole push)."""
        existing = self._kw("sale.order", "fields_get", self.ORDER_FIELDS)
        missing = set(self.ORDER_FIELDS) - set(existing)
        if missing:
            logger.warning("sale.order is missing fields: %s", sorted(missing))
        return [f for f in self.ORDER_FIELDS if f in existing]

    def _fetch(self: Self, order_id: int) -> tuple[dict, list[dict]]:
        orders = self._kw("sale.order", "read", [order_id], fields=self._order_fields)
        if not orders:
            raise ValueError(f"sale.order {order_id} not found")
        order = orders[0]

        lines: list[dict[str, Any]] = []
        line_ids = order.get("order_line") or []
        if line_ids:
            raw_lines = self._kw(
                "sale.order.line",
                "read",
                line_ids,
                fields=["product_id", "product_uom_qty"],
            )
            product_ids = [
                line["product_id"][0] for line in raw_lines if line.get("product_id")
            ]
            variants = self._kw(
                "product.product", "read", product_ids, fields=["product_tmpl_id"]
            )
            template_by_variant = {v["id"]: v["product_tmpl_id"][0] for v in variants}
            template_ids = sorted(set(template_by_variant.values()))
            templates = self._kw(
                "product.template",
                "read",
                template_ids,
                fields=list(QUOTA_FIELDS.values()),
            )
            quotas_by_template = {t["id"]: t for t in templates}
            for line in raw_lines:
                if not line.get("product_id"):
                    continue
                template = quotas_by_template[
                    template_by_variant[line["product_id"][0]]
                ]
                lines.append(
                    {
                        "qty": line["product_uom_qty"],
                        **{f: template.get(f) or 0 for f in QUOTA_FIELDS.values()},
                    }
                )
        return order, lines

    def compute_order(self: Self, order_id: int) -> dict[str, Any]:
        """Fetch + compute only — no POST. Used by push_order and --dry-run."""
        order, lines = self._fetch(order_id)
        payload = compute_entitlement(order, lines)
        if payload is None:
            return {
                "order_id": order_id,
                "order": order.get("name"),
                "status": "skipped",
                "reason": (
                    f"state={order.get('subscription_state')}, "
                    f"org={order.get('x_goat_organization_id') or 'unlinked'}"
                ),
            }
        return {
            "order_id": order_id,
            "order": order.get("name"),
            "status": "computed",
            "payload": payload,
        }

    def push_order(self: Self, order_id: int) -> dict[str, Any]:
        result = self.compute_order(order_id)
        if result["status"] == "skipped":
            return result
        if not self.core_url or not self.webhook_secret:
            raise RuntimeError("CORE_URL and ODOO_WEBHOOK_SECRET are required to push")
        payload = result["payload"]
        response = httpx.post(
            f"{self.core_url}/api/v2/webhooks/odoo/entitlement",
            headers={"X-Webhook-Secret": self.webhook_secret},
            json=payload,
            timeout=30.0,
        )
        response.raise_for_status()
        return {**result, "status": "pushed"}

    def reconcile(self: Self, dry_run: bool = False) -> dict[str, Any]:
        order_ids = self._kw(
            "sale.order",
            "search",
            [
                ("is_subscription", "=", True),
                ("subscription_state", "in", sorted(PUSHABLE_STATES)),
                ("x_goat_organization_id", "!=", False),
            ],
        )
        handle = self.compute_order if dry_run else self.push_order
        results = [handle(order_id) for order_id in order_ids]
        done = sum(1 for r in results if r["status"] != "skipped")
        return {
            "status": "ok",
            "subscriptions": len(results),
            "computed" if dry_run else "pushed": done,
            "skipped": len(results) - done,
            "results": results,
        }


def main(
    params: OdooEntitlementPushParams = OdooEntitlementPushParams(),
) -> dict[str, Any]:
    task = OdooEntitlementTask()
    if params.order_id:
        return task.push_order(params.order_id)
    return task.reconcile()


if __name__ == "__main__":
    import argparse
    import json

    parser = argparse.ArgumentParser(
        description="Odoo -> GOAT entitlement push (local runner)"
    )
    parser.add_argument(
        "--order-id", type=int, default=0, help="sale.order id; 0 = reconcile all"
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="compute and print payload(s) without POSTing to core",
    )
    cli_args = parser.parse_args()

    _task = OdooEntitlementTask()
    if cli_args.dry_run:
        _result = (
            _task.compute_order(cli_args.order_id)
            if cli_args.order_id
            else _task.reconcile(dry_run=True)
        )
    else:
        _result = (
            _task.push_order(cli_args.order_id)
            if cli_args.order_id
            else _task.reconcile()
        )
    print(json.dumps(_result, indent=2, default=str))
