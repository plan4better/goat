CREATE OR REPLACE FUNCTION customer.role_rank(role_name TEXT)
RETURNS INT
LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE
        WHEN role_name IS NULL THEN 0
        WHEN role_name = 'owner'  OR role_name LIKE '%-owner'  THEN 3
        WHEN role_name = 'editor' OR role_name LIKE '%-editor' THEN 2
        WHEN role_name = 'viewer' OR role_name LIKE '%-viewer' THEN 1
        ELSE 0
    END
$$;

CREATE OR REPLACE FUNCTION customer.rank_role(rank INT)
RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE rank WHEN 3 THEN 'owner' WHEN 2 THEN 'editor' WHEN 1 THEN 'viewer' ELSE NULL END
$$;

/* Direct grants on one resource for one user, through every grantee kind.
   Capped at rank 2 (editor): a grant row can never mint ownership. Rank 3
   comes only from the space (its owner, or an owner/admin of its team or
   organization); creating an item gives no rights of its own. */
CREATE OR REPLACE FUNCTION customer.direct_grant_rank(resource_type_input TEXT, resource_id_input UUID, user_id_input UUID)
RETURNS INT
LANGUAGE sql STABLE AS $$
    SELECT COALESCE(MAX(LEAST(customer.role_rank(r.name), 2)), 0)
    FROM customer.resource_grant rg
    JOIN customer.role r ON r.id = rg.role_id
    WHERE rg.resource_type = resource_type_input
      AND rg.resource_id   = resource_id_input
      AND (
            (rg.grantee_type = 'user' AND rg.grantee_id = user_id_input)
         OR (rg.grantee_type = 'team' AND EXISTS (
                SELECT 1 FROM customer.user_team ut
                WHERE ut.team_id = rg.grantee_id AND ut.user_id = user_id_input))
         OR (rg.grantee_type = 'organization' AND EXISTS (
                SELECT 1 FROM customer."user" u
                WHERE u.id = user_id_input AND u.organization_id = rg.grantee_id))
      )
$$;

/* Whether a layer is a catalog dataset: a materialization of an external
   STAC item (`catalog_external_uid` set), shared by every organization
   that added it. Readable by everyone, anonymous included, capped at
   viewer, and writable by nobody — promote gives it no space, and
   layer_write_allowed refuses a spaceless layer before any other rule.
   Provenance, not the `public_read` flag, decides this: a public dataset
   is ordinary content whose owner opened it to every signed-in user, and
   its editors keep editing it. Shared by effective_role and
   layer_write_allowed so the predicate is defined once. */
CREATE OR REPLACE FUNCTION customer.layer_is_catalog(layer_id UUID)
RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
    SELECT l.catalog_external_uid IS NOT NULL FROM customer.layer l WHERE l.id = layer_id
$$;

/* The same for a bundle: a shared catalog bundle (an XPlan plan added from
   the catalog) has no space, is readable by everyone and writable by nobody. */
CREATE OR REPLACE FUNCTION customer.bundle_is_catalog(bundle_id UUID)
RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
    SELECT b.catalog_external_uid IS NOT NULL FROM customer.bundle b WHERE b.id = bundle_id
$$;

/* A folder and its ancestors, nearest first; the depth trigger keeps this to at most 4 rows. */
CREATE OR REPLACE FUNCTION customer.folder_chain(folder_id_input UUID)
RETURNS SETOF UUID
LANGUAGE sql STABLE AS $$
    WITH RECURSIVE chain AS (
        SELECT f.id, f.parent_id, 1 AS depth FROM customer.folder f WHERE f.id = folder_id_input
        UNION ALL
        SELECT p.id, p.parent_id, c.depth + 1 FROM customer.folder p JOIN chain c ON p.id = c.parent_id WHERE c.depth < 4
    )
    SELECT id FROM chain
$$;

/* Restricted (spec D9): the resource itself is marked restricted, or any folder on its chain is,
   or — for a layer — a bundle holding it is (rule 5 propagates a bundle's grants to its member
   layers, so it propagates Restricted too). Suppresses the space-default step only; grants,
   bundle and project paths still apply. An unknown resource type is never restricted: the CASE
   falls through to NULL and COALESCE reads that as FALSE. The five known types are enforced by
   the API (`ResourceType`) and by `authz.require`'s own allow-list, not here.
   `folder_chain(NULL)` is empty, so a resource with no folder needs no guard. */
CREATE OR REPLACE FUNCTION customer.restricted_applies(resource_type_input TEXT, resource_id_input UUID, folder_ref UUID)
RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
    SELECT COALESCE(
               CASE resource_type_input
                   WHEN 'layer'   THEN (SELECT l.restricted FROM customer.layer l   WHERE l.id = resource_id_input)
                   WHEN 'project' THEN (SELECT p.restricted FROM customer.project p WHERE p.id = resource_id_input)
                   WHEN 'bundle'  THEN (SELECT b.restricted FROM customer.bundle b  WHERE b.id = resource_id_input)
                   WHEN 'folder'  THEN (SELECT f.restricted FROM customer.folder f  WHERE f.id = resource_id_input)
                   WHEN 'template' THEN (SELECT t.restricted FROM customer.template t WHERE t.id = resource_id_input)
                   ELSE NULL
               END, FALSE)
        OR EXISTS (
               SELECT 1 FROM customer.folder_chain(folder_ref) fc
                 JOIN customer.folder f ON f.id = fc
                WHERE f.restricted)
        OR (resource_type_input = 'layer' AND EXISTS (
               SELECT 1 FROM customer.bundle_layer bl
                 JOIN customer.bundle b ON b.id = bl.bundle_id
                WHERE bl.layer_id = resource_id_input
                  AND (b.restricted
                       OR EXISTS (SELECT 1 FROM customer.folder_chain(b.folder_id) bfc
                                    JOIN customer.folder bf ON bf.id = bfc
                                   WHERE bf.restricted))))
$$;

/* THE rule (spec §3.2). Space owner/admin > space default for members > direct grant > ancestor-folder
   grants > bundle grant > project→layer read > public dataset read > template dataset read > catalog read.
   Max role wins; the one exception is Restricted (D9), which withholds the space default. A
   soft-deleted item is visible to the space owner/admin only. Returns the rank: 3 owner, 2 editor,
   1 viewer, 0 none; `effective_role` below is the role name over it.

   `derived_reads` FALSE leaves out the layer reads that come from something holding the layer
   (rules 6, 6b, 6c). They only ever grant viewer, so a check for editor or more, like "may this
   user share the layer", is the same without them; and rule 6c needs exactly that check for
   another user, which with the derived reads included could come back to rule 6c through that
   user's templates and recurse without end. */
CREATE OR REPLACE FUNCTION customer.effective_rank(resource_type_input TEXT, resource_id_input UUID, user_id_input UUID, derived_reads BOOLEAN)
RETURNS INT
LANGUAGE plpgsql STABLE AS $$
DECLARE
    best        INT := 0;
    space_ref   UUID;
    folder_ref  UUID;
    deleted     TIMESTAMPTZ;
    is_catalog  BOOLEAN := FALSE;
    space_level INT := 0;
BEGIN
    IF resource_type_input = 'layer' THEN
        SELECT l.space_id, l.folder_id, l.deleted_at INTO space_ref, folder_ref, deleted FROM customer.layer l WHERE l.id = resource_id_input;
        IF FOUND THEN
            is_catalog := customer.layer_is_catalog(resource_id_input);
        END IF;
    ELSIF resource_type_input = 'project' THEN
        SELECT p.space_id, p.folder_id, p.deleted_at INTO space_ref, folder_ref, deleted FROM customer.project p WHERE p.id = resource_id_input;
    ELSIF resource_type_input = 'bundle' THEN
        SELECT b.space_id, b.folder_id, b.deleted_at INTO space_ref, folder_ref, deleted FROM customer.bundle b WHERE b.id = resource_id_input;
        IF FOUND THEN
            is_catalog := customer.bundle_is_catalog(resource_id_input);
        END IF;
    ELSIF resource_type_input = 'folder' THEN
        SELECT f.space_id, f.parent_id, f.deleted_at INTO space_ref, folder_ref, deleted FROM customer.folder f WHERE f.id = resource_id_input;
    ELSIF resource_type_input = 'template' THEN
        SELECT t.space_id, t.folder_id, t.deleted_at INTO space_ref, folder_ref, deleted FROM customer.template t WHERE t.id = resource_id_input;
    ELSE
        RAISE EXCEPTION 'effective_role: unknown resource_type %', resource_type_input;
    END IF;

    IF NOT FOUND THEN
        RETURN 0;
    END IF;

    /* 1–2. the space: owner/admin → owner, member → the space default */
    IF space_ref IS NOT NULL AND user_id_input IS NOT NULL THEN
        space_level := customer.space_rank(space_ref, user_id_input);
    END IF;

    /* trash: only the space owner/admin keeps access (to restore) */
    IF deleted IS NOT NULL THEN
        RETURN CASE WHEN space_level = 3 THEN 3 ELSE 0 END;
    END IF;

    IF space_level = 3 THEN
        RETURN 3;
    END IF;

    /* catalog datasets: readable by everyone, including anonymous; never more than viewer */
    IF is_catalog THEN
        RETURN 1;
    END IF;

    IF user_id_input IS NULL THEN
        RETURN 0;
    END IF;

    /* 2 (Restricted, D9): a restricted item/folder does not hand members the space default */
    IF space_level IN (1, 2) AND customer.restricted_applies(resource_type_input, resource_id_input, folder_ref) THEN
        best := 0;
    ELSE
        best := space_level;
    END IF;

    /* 3. direct grants on the resource itself */
    best := GREATEST(best, customer.direct_grant_rank(resource_type_input, resource_id_input, user_id_input));

    /* 4. grants on the folder and its ancestors (depth ≤ 3) */
    IF folder_ref IS NOT NULL THEN
        SELECT GREATEST(best, COALESCE(MAX(customer.direct_grant_rank('folder', fc, user_id_input)), 0))
          INTO best
          FROM customer.folder_chain(folder_ref) fc;
    END IF;

    IF resource_type_input = 'layer' THEN
        /* 5. bundle inheritance: a member layer is never shared on its own */
        SELECT GREATEST(best, COALESCE(MAX(customer.direct_grant_rank('bundle', bl.bundle_id, user_id_input)), 0))
          INTO best
          FROM customer.bundle_layer bl
         WHERE bl.layer_id = resource_id_input;

        /* 6. project → layer: any access to a containing project grants READ on the layer,
              but only through a SHAREABLE link (D7). A link is non-shareable when whoever
              added the layer to the project lacked `share` on it, so adding a dataset you
              may only view cannot hand the project's other members access to it. */
        IF derived_reads AND best < 1 AND EXISTS (
            SELECT 1 FROM customer.layer_project lp
             WHERE lp.layer_id = resource_id_input
               AND lp.shareable
               AND customer.effective_role('project', lp.project_id, user_id_input) IS NOT NULL
        ) THEN
            best := 1;
        END IF;

        /* 6b. public dataset: its owner opened it to every signed-in user, in any
              organization. A floor, never a cap — the space role, grants and the
              project path above still decide anything higher, so editors keep
              editing. Anonymous callers returned above and never reach it. */
        IF derived_reads AND best < 1 AND EXISTS (
            SELECT 1 FROM customer.layer l
             WHERE l.id = resource_id_input AND l.public_read
        ) THEN
            best := 1;
        END IF;

        /* 6c. template dataset: a template ships its author's dataset to whoever may use it, so
              whoever may read the template may read the datasets it links ("ship") or copies
              with their rows ("copy"), however the template reached them: a grant on it, a
              folder shared above it, its space, the catalog. Read live, so access ends as soon
              as the dataset leaves the template, the template stops reaching the user, or its
              author may no longer share the dataset; that last check keeps a dataset the author
              may only view from travelling on through a template. An empty copy takes only the
              columns, so its dataset stays private. Unindexed: templates are few and this runs
              only for a layer nothing else lets the user read. */
        IF derived_reads AND best < 1 AND EXISTS (
            SELECT 1 FROM customer.template t
             CROSS JOIN LATERAL jsonb_array_elements(COALESCE(t.inputs, '[]'::jsonb)) i
             WHERE t.deleted_at IS NULL
               AND t.inputs @> jsonb_build_array(jsonb_build_object('layer_id', resource_id_input::text))
               AND i->>'layer_id' = resource_id_input::text
               AND (i->>'mode' = 'ship'
                    OR (i->>'mode' = 'copy' AND COALESCE((i->>'copy_content')::boolean, TRUE)))
               AND customer.effective_rank('template', t.id, user_id_input, TRUE) >= 1
               AND customer.effective_rank('layer', resource_id_input, t.user_id, FALSE) >= 2
        ) THEN
            best := 1;
        END IF;
    END IF;

    /* 7. the GOAT catalog shelf (T4): a published template is readable by every
          authenticated user regardless of the space it lives in. A fallback only:
          a member's own space role, a grant or a folder grant above still wins,
          so a team editor keeps editing its published template. Anonymous callers
          returned above and never reach the shelf. */
    IF best = 0 AND resource_type_input = 'template' AND EXISTS (
        SELECT 1 FROM customer.template t
         WHERE t.id = resource_id_input AND t.catalog_status = 'published' AND t.deleted_at IS NULL
    ) THEN
        best := 1;
    END IF;

    RETURN best;
END;
$$;

/* The rule as a role name: 'owner' | 'editor' | 'viewer' | NULL, every read included. */
CREATE OR REPLACE FUNCTION customer.effective_role(resource_type_input TEXT, resource_id_input UUID, user_id_input UUID)
RETURNS TEXT
LANGUAGE sql STABLE AS $$
    SELECT customer.rank_role(customer.effective_rank(resource_type_input, resource_id_input, user_id_input, TRUE))
$$;

CREATE OR REPLACE FUNCTION customer.can(resource_type_input TEXT, resource_id_input UUID, user_id_input UUID, action TEXT)
RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
    SELECT customer.role_rank(customer.effective_role(resource_type_input, resource_id_input, user_id_input)) >=
        CASE action
            WHEN 'read'   THEN 1
            WHEN 'write'  THEN 2
            WHEN 'share'  THEN 2
            WHEN 'delete' THEN 3
            ELSE 99
        END
$$;
