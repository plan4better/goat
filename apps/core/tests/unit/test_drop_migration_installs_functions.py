"""C2: the upgrade must not leave a pod calling `customer.authorization()`
against tables it has just dropped.

`0003_sharing_grants` drops the six legacy share-link tables; the function
bodies that read them are replaced by `0005_home_templates`, the head of the
chain, which is the first point where the schema those new bodies read
(`layer.space_id`, `folder.parent_id`, the `restricted` columns,
`customer.template`) exists. `env.py` commits each revision on its own, so a
database that starts below 0005 runs without these tables between the two
commits and is upgraded while nothing serves it — what must hold is that the
install is in the chain, after the drop, and in the right file order.

Imports the migration modules by path (alembic revision modules are not
package-importable) rather than executing them against a database: the drop
is irreversible, so this only checks the code is right, never runs alembic.
"""

import importlib.util
from pathlib import Path
from types import ModuleType

import pytest

pytestmark = pytest.mark.unit

VERSIONS_DIR = Path(__file__).parents[2] / "alembic" / "versions"
INSTALL_PATH = VERSIONS_DIR / "0005_home_templates.py"
DROP_PATH = VERSIONS_DIR / "0003_sharing_grants.py"


def _load_migration(path: Path) -> ModuleType:
    spec = importlib.util.spec_from_file_location(f"{path.stem}_migration", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_authz_sql_files_is_the_exact_ordered_list() -> None:
    module = _load_migration(INSTALL_PATH)
    assert module.AUTHZ_SQL_FILES == [
        # effective_role calls space_rank, so it is installed first; a
        # database left with effective_role but no space_rank fails every
        # authz call.
        "space_rank.sql",
        "effective_role.sql",
        "layer_write_allowed.sql",
        "check_layer.sql",
        "check_project.sql",
    ]


def test_each_authz_sql_file_exists_and_starts_with_create_or_replace_function() -> (
    None
):
    module = _load_migration(INSTALL_PATH)
    for name in module.AUTHZ_SQL_FILES:
        path = module.AUTHZ_SQL_DIR / name
        assert path.is_file(), f"{path} does not exist"
        assert path.read_text().startswith(
            "CREATE OR REPLACE FUNCTION"
        ), f"{name} must start with CREATE OR REPLACE FUNCTION"


def test_the_install_is_the_last_thing_the_chain_head_does() -> None:
    """A regression that moves the install before the template table would
    break it (`restricted_applies` is a SQL function reading
    `customer.template`), and one that removes it would leave the previous
    generation of function bodies reading the dropped tables."""
    source = INSTALL_PATH.read_text()
    install_pos = source.index("    _replace_previous_generation_authz()\n")
    template_pos = source.index("    _create_template_table()\n")
    assert template_pos < install_pos


def test_the_revision_that_drops_the_tables_comes_before_the_install() -> None:
    drop = _load_migration(DROP_PATH)
    install = _load_migration(INSTALL_PATH)
    assert 'DROP TABLE IF EXISTS "{S}"' in DROP_PATH.read_text()
    assert install.down_revision == "0004_spaces"
    assert drop.revision == "0003_sharing_grants"
