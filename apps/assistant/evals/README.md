# GOAT eval set

36 catalog, 26 project, 13 workflow and 45 map tasks that grade a model on what GOAT's assistant does (spec §12). The agent,
prompt, tools and limits are the production ones; the services behind the tools are fixed (decision E16): the
catalog app over its fixture catalog plus its named rows, and canned answers for one fixture project
("Radverkehr Leipzig"). Checks are deterministic (expected records, filters, numbers, named values, tools, docs pages
read, layers never sent, values not stated, cards asked, workflows created, styles and map state stored, answer length); nine
free-text tasks go to an LLM judge.
The answer graded is what the dock shows: the text of every response of the last turn, the text before a tool call or a
card too, but not text an answer asked for again in the message's language (or the interface's) replaced; a card counts as asked for an option's `value` and for the datasets its `adds` names.
Questions about GOAT's own interface (`proj-26` to `proj-30`) are graded on the docs page the answer read with
`docs_read` and the interface labels from that page in the answer, in the language of the user's interface. An `answer` check
with `with_shown_items` also counts the names on the cards of the user's own items, since the prompt has the model show
those as cards and not list them again; one with `max_chars` bounds the length of the answer the dock shows.

The workflow suite (`workflow_tasks.jsonl`, `wf-NN`) builds workflows in three more fixture projects: one to build in
("Erreichbarkeit Leipzig"), the same layers for a user who may only view them, and an empty one in Munich, where
adding a catalog dataset adds its layers. A fourth project ("Schulwege Leipzig") holds one workflow whose run is
refused before it starts and whose save core refuses as for a viewer (the task asks to run it, never to change it), and a fifth ("Nahversorgung zu Fuß") one workflow the assistant changes, which core saves
on its revision only (`base_revision`, 409 `changed_elsewhere` otherwise), keeping each version for the graders.
Processes answers with descriptions captured from processes
(`tests/fixtures/process_descriptions.json`: what processes' `tool_registry.get_process_list` and
`get_process_description` give for the eight tools the tasks use) and a stand-in for its workflow check
(`backends.fixture_check`) that follows processes' check step by step, each tool step validated with the tool's own
parameter model, so a draft production refuses is refused here too. One gap: it predicts no tool's columns but a
join's right before a step, so a field that a join further up renamed passes here and is refused in production.
Processes' runs are a stand-in too
(`_run_routes`): as in processes, a run whose stored config has a damaged or error issue in that check is refused with
its issues and nothing starts; any other run of a workflow core saved finishes at once and saves `RESULT_LAYER`
(residents per district and band) for each export step, and `aggregation-stats` groups the fixture layers' features,
so the answer's numbers can be checked. The graders read the workflows core saved. A task with `answer_card` runs a
second turn when the first one showed a card: the eval user answers every question with its first option, the
recommended one when there is one, and the turn gets the answer as the app renders it. A task with `undo` has the eval
user press Undo under the last answer, as the dock does (`assistant.undo` over the audit rows the answer's calls left,
kept in memory by the harness), and the `workflow_updated` check grades the version the edit saved and, with `undone`,
that the workflow is as it was afterwards.

The map suite (`map_tasks.jsonl`, `map-NN`) styles layers and changes the map of one more fixture project ("Stadtplan
Beispiel", `map_fixture.py`) on the map page, and of the same project for a user who may only view it. Its tables are
generated and seeded, with shapes chosen on purpose: a long tail, a few categories holding most features, values around
zero, missing values. Its stand-ins (`map_backends.py`) run the real style logic on them: a style save goes through
core's own save steps (`core.services.style`), and where core asks processes to check a style, the stand-in runs
goatlib's `describe`, `compute_into` and `validate` over a DuckDB table per layer, so classes, domains and issues are
the ones the servers would store. Core is imported for this on the first map route a task calls, so map tasks need
core importable with its settings in the environment (the root `.env`, which `run` loads). Rasters are graded on the
stored document only (it validates against the bands, it draws the asked form on the asked band): nothing reads their
pixels. The harness records the project as core held it before the run, when the eval user answered a card, after the
run and after the Undo, and the `style` and `map` checks (`map_graders.py`) grade those: the style the layer draws
(edited in place, or new where the request asks for a new style or for options and then which of the styles made is drawn, its classification, paths, legend shares, no error stored), the map state (what is drawn, the
order, groups, basemap, filters and their areas as the filter panel reads them, layers removed or kept, nothing
stored) and that Undo brought back the state before,
computed stamps aside. The `view` check reads the view the answer's `map_update` calls set. The `tools` check bounds the calls of a tool in an answer (`at_most`); a key that joins tools with `+` bounds their calls together. A task with
`answer_value` has the eval user pick the option of that value in the card instead of the first one. The tools get what
the eval user typed (the task's turns and prompt) and the skills the task's turns loaded, as in a run, so a new style
needs a quote of the prompt's words. A workflow can be
created and run in the map project too: its run saves one fixed result layer (catchment areas, `MAP_RESULT_LAYER`)
into the project's state with the look the catchment tool gives its result, and a `style` check on that layer compares
with the style it arrived with. The eval catalog holds two invented regions where the map project's data lies
(`AREA_REGIONS` in `backends.py`): a rectangle, and one whose edge has more positions than a filter's area takes, so a
filter limited to it is simplified as the filter panel simplifies it. The statistics stand-ins test an area against
each feature's geometry (`selected_features`), and the graders count a filter's features the same way.

`run` spends provider tokens, so it runs by hand, never in CI: it refuses when `CI` is set. The other commands spend
none.

```bash
cd apps/assistant
uv run python -m evals list
# A candidate model (ASSISTANT_EVAL_API_KEY) judged by a different model (ASSISTANT_EVAL_JUDGE_API_KEY):
ASSISTANT_EVAL_API_KEY=<key> ASSISTANT_EVAL_JUDGE_API_KEY=<judge key> \
  uv run python -m evals run --provider openai_compatible \
  --model <model id> --base-url https://llm.example.org/v1 \
  --judge-provider <judge provider> --judge-model <judge model id>
# GOAT AI as ASSISTANT_DEFAULT_* configure it, judged by the same settings' model
# (fine for a look; promotion refuses a model that judged itself):
uv run python -m evals run
uv run python -m evals run --suite catalog --task cat-14 --no-judge   # a quick look
```

`run` always names its model: `--provider` and `--model`, or the instance's `ASSISTANT_DEFAULT_*`. Use a judge
that is not the model under test (`--judge-provider`, `--judge-model`, `--judge-base-url`, `--judge-region`):
`promote` refuses a run in which the model graded itself, and records the judge in the list entry.

`ASSISTANT_DEFAULT_API_KEY` is used only for GOAT AI's own provider and endpoint. Any other model or judge needs its
key in `ASSISTANT_EVAL_API_KEY` or `ASSISTANT_EVAL_JUDGE_API_KEY` (or the variable named by `--api-key-env` /
`--judge-api-key-env`); without it `run` refuses. Bedrock and Vertex AI use the SDK credential chain. Flags that
would be ignored (`--model` without `--provider`, `--judge-*` without `--judge-provider` or with `--no-judge`) are
an error. Promotion recomputes the score from the per-task records and needs a judge that is neither the test provider nor the model under test.

Each run writes `evals/results/<time>-<provider>-<model>.json` (not committed): per task the grades, the answer,
the tools called, tokens, the time to the first text and in total; a summary with the score per suite and the
critical tasks that failed.

**Regression workflows.** `workflow_runs.json` keeps workflows the assistant builds in the workflow project's layers
(`WORKFLOW_LAYERS` in `backends.py`): drafts written the way the assistant drafts, with the config `to_config` gives
for each, and workflows eval runs created, with the config core saved. CI runs every case on layers with that
project's ids, names and fields: goatlib's workflow chain tests run the cases without routing, the routing chain tests
(`workflow chains (routing)`, `.github/workflows/workflow-chains.yml`) the ones with routing (`run`). A workflow the
assistant creates counts as good only once it runs there; the graders here check what it contains. A run's results
file records the workflows each task created; keep the ones worth keeping with
`uv run python -m evals runs --add-from evals/results/<file>.json`, which says which it skipped and why (a dataset
step left open, a layer the runners lack). After a change to `to_config`, `uv run python -m evals runs` rewrites the
drafts' configs; `tests/test_eval_runs.py` fails until it is run. Neither spends tokens.

**Tested models.** A model enters `src/assistant/llm/tested_models.json`, which the admin AI page reads, only
through `uv run python -m evals promote evals/results/<file>.json`. It refuses unless the run covered every
task of the current `EVAL_SET_VERSION`, every judge check was decided, no critical task failed, and the score
is at least 0.85 overall and 0.8 per suite. Commit the changed `tested_models.json`.

**Changing tasks.** One task per line in `catalog_tasks.jsonl`, `project_tasks.jsonl`, `workflow_tasks.jsonl` and
`map_tasks.jsonl`. A map task needs a right answer in `tests/eval_map_answers.py`, applied to the stand-in by
`tests/test_eval_map.py`, which also checks that no map task passes when the answer changes nothing. Bump
`EVAL_SET_VERSION` in `tasks.py` when a task or check changes meaning: models tested against an older version
keep their entry until re-run, and `promote` only accepts results of the current version.
