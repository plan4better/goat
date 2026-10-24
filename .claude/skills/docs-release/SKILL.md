---
name: docs-release
description: Use to keep apps/docs in step with GOAT releases, in two stages. "propose" lists every release since the last proposal, says which changes need docs, where and what, and posts that list as a GitHub issue for review; it edits nothing. "apply <issue>" makes only the changes agreed on that issue and opens a draft PR. Runs weekly from the docs-release routine (propose), or by hand (e.g. "docs-release apply #3901").
---

# Docs after releases

Most releases and fixes need no docs change. So this works in two stages, and a person agrees on the list before any page is touched:

1. **propose:** a GitHub issue that lists every release and commit, with a verdict per change. It edits nothing.
2. **apply:** after the reviewer has agreed on the issue, it makes exactly the ticked changes and opens a draft PR.

When in doubt, propose less. A missed change costs one line on the next issue; an unneeded edit costs the reviewer's time. Never push to `main`, never merge, never mark a PR ready.

The writing rules in `apps/docs/CLAUDE.md` and `apps/docs/docs/nerdy_content/documentation_writing_guide.md` apply to every edit. Read both before either stage.

## Stage 1: propose

### Range

```bash
git fetch -q --tags origin main
NEW=$(git tag --list 'v*' --sort=-v:refname | head -1)
gh issue list --state all --search 'in:title "docs-release:"' --json number,title --limit 20
```

- Proposal issues are titled `docs-release: <BASE>..<NEW>`. **Base** is the `<NEW>` of the latest one. If there isn't one yet, use the tag right before `$NEW`.
- **Stop if `BASE` = `$NEW`:** no release since the last proposal. Say so and end; don't open an issue.

### Verdicts

For every tag in the range, go through `git log --no-merges --format='%h %s' <prev>..<tag>` and the PRs behind it (`gh pr view <n>`). Give each commit one verdict:

- **Docs**: what a user sees or does has changed, and a docs page describes it or should: a new feature, a renamed label, changed steps, a new setting or tool parameter, a changed default or limit, or a self-hosting setting (`deploy/`, `.env.example`, Helm values).
- **No docs**: everything else, including tests, CI, refactors, internal fixes, `docs:` commits, dependencies, and fixes that only restore what the docs already say.

For **Docs**, check before you claim it: grep the old label, the feature name and the i18n key across `apps/docs/docs` and `apps/docs/i18n/de/docusaurus-plugin-content-docs/current`, and read the page. If the page already matches the new behaviour, the verdict is **No docs**.

### The issue

Open it with `gh issue create --repo plan4better/goat --title "docs-release: $BASE..$NEW"` (no `--assignee`: the account may not assign issues). Body:

```markdown
Releases <BASE>..<NEW> ([compare](https://github.com/plan4better/goat/compare/<BASE>...<NEW>)).
Tick the changes to make, edit or strike out anything, then run `docs-release apply #<this issue>`.

## Proposed changes

- [ ] **<short title>** (#<PR>, <tag>)
  - **Where:** `docs/<path>.md` § <section> · DE `i18n/de/…/<path>.md` (or: new section after § <section>; new page under <sidebar category>)
  - **What:** <one or two sentences: what the page says now, and what it should say>
  - **Media:** <screenshot/recording that's now out of date, or "none">

## No docs needed

### <tag>
| Commit | Change | Why no docs |
|---|---|---|
| `<sha>` (#<PR>) | <subject> | <a few words> |
```

Keep the proposals to the real changes. Keep the "No docs needed" table complete, with every commit in the range, so the reviewer can move any of them up. List merge commits under their PR, not on their own. If nothing needs docs, leave "Proposed changes" empty and still open the issue: it marks the range as reviewed.

## Stage 2: apply

Input: the issue number, after the reviewer has agreed on it.

1. Read the issue body and **all its comments**. Only ticked items count, as edited by the reviewer. A comment overrides the body. If something is unclear, ask in an issue comment and stop. Don't guess.
2. Range and tag come from the title. Branch `docs/release-<NEW>` from `origin/main`.
3. For each ticked item:
   - Read every TSX component that renders the UI, in full, on `main`.
   - Take each label from `apps/web/i18n/locales/en/common.json` and `…/de/common.json`, and each German UI term from `apps/docs/docs/nerdy_content/GOAT_ui_glossary.md`.
   - Edit the English and German page in the same commit, scoped to what the item says: no unrelated rewording or restyling.
   - If the components contradict the item, follow the components and flag it in the PR.
   - Screenshots and recordings can't be taken from here. Leave the old ones in place and list them in the PR.
   - Use one commit per item: `docs(<area>): …`.
4. Check: `pnpm install --filter @p4b/docs...` then `pnpm --filter @p4b/docs build`. The build must pass; it fails on broken links. If you added any images, also run `bash scripts/check-file-sizes.sh origin/main`.
5. Push to the fork, since direct pushes to `plan4better/goat` are refused: add it if needed (`git remote add fork https://github.com/cnarbaitzsarsur/goat.git`), then `git push -u fork docs/release-<NEW>` and `gh pr create --repo plan4better/goat --head cnarbaitzsarsur:docs/release-<NEW> --draft --base main --title "docs: update for <BASE>..<NEW> (EN + DE)"`. Body:
   - `Closes #<issue>`
   - **Changed:** one bullet per item, naming the components and i18n keys it was checked against.
   - **Needs a person:** stale media (file path + what changed), and anywhere you departed from the issue, with the reason.
6. Comment the PR link on the issue.
