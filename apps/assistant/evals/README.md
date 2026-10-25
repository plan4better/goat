# GOAT eval set

36 catalog, 24 project and 11 workflow tasks that grade a model on what GOAT's assistant does (spec §12). The agent,
prompt, tools and limits are the production ones; the services behind the tools are fixed (decision E16): the
catalog app over its fixture catalog plus its named rows, and canned answers for one fixture project
("Radverkehr Leipzig"). Checks are deterministic (expected records, filters, numbers, named values, tools, layers
never sent, values withheld, cards asked, workflows created); six free-text tasks go to an LLM judge. An `answer` check
with `with_shown_items` also counts the names on the cards of the user's own items, since the prompt has the model show
those as cards and not list them again.

The workflow suite (`workflow_tasks.jsonl`, `wf-NN`) builds workflows in three more fixture projects: one to build in
("Erreichbarkeit Leipzig"), the same layers for a user who may only view them, and an empty one in Munich, where
adding a catalog dataset adds its layers. A fourth project ("Schulwege Leipzig") holds one workflow whose run is
refused before it starts. Processes answers with descriptions captured from processes
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
recommended one when there is one, and the turn gets the answer as the app renders it.

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

**Changing tasks.** One task per line in `catalog_tasks.jsonl`, `project_tasks.jsonl` and `workflow_tasks.jsonl`. Bump
`EVAL_SET_VERSION` in `tasks.py` when a task or check changes meaning: models tested against an older version
keep their entry until re-run, and `promote` only accepts results of the current version.
