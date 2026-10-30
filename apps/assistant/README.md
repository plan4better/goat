# assistant

GOAT's AI assistant service: conversations, detached agent runs and their event streams. Design:
`docs/superpowers/specs/2026-10-01-goat-ai-assistant-design.md`.

Run locally (port 8500): `ASSISTANT_DEFAULT_PROVIDER=test ASSISTANT_DEFAULT_MODEL=demo uv run uvicorn assistant.main:app --port 8500` from `apps/assistant`.
Without `ASSISTANT_DEFAULT_PROVIDER` the service has no default model and reports AI as unavailable.

`/mcp` is the MCP endpoint (Streamable HTTP, stateless, JSON responses): the read-only catalog tools
`catalog_search`, `catalog_describe`, `catalog_get_record`, `catalog_suggest_terms`, `catalog_find_region`. It
replaces the catalog
service's `/mcp`. `ASSISTANT_ENABLE_MCP` switches it, `ASSISTANT_MCP_ALLOWED_HOSTS` is its DNS-rebinding host
allow-list (`*` by default; name the real ingress host in production, as `host` and `host:*` if clients may send a
port). With `AUTH=True` it needs a GOAT bearer token. It takes `POST` only.
An MCP client that signs in through a Keycloak client of its own needs that client in `AUTH_ALLOWED_CLIENTS` when
the list is set: the assistant checks tokens as core does, and core checks them again when a tool passes one on.
Its tool-call audit rows belong to no conversation; the run sweeper deletes them after
`ASSISTANT_MCP_AUDIT_RETENTION_DAYS` (30 by default, at least 1).

Anything about GOAT data (dataset names, ids, counts, field values) comes only from tool results. Other questions
(history, places, planning terms) the model answers from its own knowledge; a detail a planner might rely on, such
as which district a quarter belongs to, is marked as general knowledge that was not checked against data.

Catalog searches filter places by NUTS region (`catalog_find_region`, then `nuts` on `catalog_search`), not by
the place name in the search text, which only matches datasets whose text names the place. NUTS names places in
their own languages, so `catalog_find_region` also knows each NUTS country by its English and German name. The dock shows a
dataset card only for what the answer recommends, named with `catalog_show_records`: an answer searches several
times, and its first hits are rarely the datasets it ends up recommending. The cards come in groups with a one-line
note each, so the answer's text keeps to the purpose, caveats and gaps instead of listing the datasets again.
`core_show_items` does the same for the user's own projects, datasets, bundles and project layers, and for a project's
workflows and print layouts (read with `project_get_workflows` and `project_get_layouts`). `core_find` finds all of
these by name, folder or owner in every space the user can open, shared folders included, through core's
`GET /content/search`, plus matching templates; a search of names alone missed what colleagues share with a team or
the organization. A question for data about a topic or place searches the datasets the user's organization already
has and the catalog in the same step, and the answer shows the organization's first: a planner first wants to know
"we have this already". `core_find` matches names, so a synonym the dataset is not named by misses it. Both tools take only
references; the server reads each one in core or the catalog with the user's sign-in, so a card never shows a name
the model made up or an item the user cannot open. Which buttons a card has is decided by the web app
(`apps/web/lib/assistant/itemActions.ts`), from the item's kind and the page, never by the model: a model reads text
other people wrote, and a button it chose could act on an instruction hidden in that text. Each card has at most one
button: Open a project, or a workflow or layout in its project's Workflows or Layouts view, Zoom to a layer of the open project (anything already in it has no preview, the real map is
beside the dock), or Add to an editable open project, which adds on the click with an Undo notice; the model adds a
dataset of its own choosing only with `project_add_catalog_layer` or `project_add_dataset`, after the user picked it in a card, and a
workflow template it uses brings the datasets the template ships (Write tools and Templates, below). The thumbnail,
owner and last change are read by the web app when the card is shown, with
the user's session, not taken from the tool result: thumbnail links expire, and names of colleagues need not go to the
model provider. For the same reason `core_find` gives an owner's name only where the search matched the owner (the
user typed it) and says "you" for the user's own items. A search result row carries one line of description,
type, publisher, years and a rounded bbox, and only the first page brings facet counts (each facet's most
frequent values), because every later model call of the answer resends them; `catalog_get_record` and
`catalog_describe` have the rest. A search that finds nothing brings a note instead of its empty facet lists: what an
empty result means and when to stop, since a model given only the empty lists searched on with other words until
the answer's budget was gone and could not build the workflow it was asked for. For the same reason, after
`FRUITLESS_SEARCHES` catalog searches in a row of one answer found nothing (`catalog_search` and
`catalog_suggest_terms`, the tools with `ToolSpec.found_nothing`), the answer's next catalog searches are refused
without running (`assistant/tools/toolset.py`); a search that finds something starts the count again, so an answer
can still look for several datasets.

**Asking the user.** `ask_user` shows a card in the dock on every page: up to four questions answered together, two
to four options each, and a free-text field the card adds by itself. It is a general mechanism, not tied to
workflows. The card is a `data-ask` part named by its card id, `ask-` and an id the tool mints (`tools/ask.py`), not
the provider's tool call id, which some providers number per response and so repeat in a later answer; the tool's
stored result carries the card id, by which `asks.AskHistory` finds the card again. A shown card ends the answer
before the model is called again (`runs/turn.py`): a model that reasons before it replies otherwise kept the answer
running while the card already waited; the card's result stays in the history. An answer shows one card: a second
`ask_user` call in the same response runs after the first and is refused, without a card, with a note to put every
question into one card (`tools/toolset.py`). A card is refused the same way after a finished workflow run's result
while no response written after that result holds text (`ToolSpec.report_first`): cards withheld finished runs'
numbers or asked whether to go on, and a response that made the run's call wrote its text before the result. The refusal
says to write the text and the card in one response, since text alone ends the answer. Cards were refused in a loop for
two reasons: at the step that answers, which offered only `ask_user`, a model that meant to call another tool called
`ask_user`, and a model that knew text alone ends its answer kept its card and sent it again without text. So cards are
refused in at most two responses per result (`REPORT_REFUSALS`), a repeat of the card refused before it with a shorter
note, and the gate lets the next one through. A card that fails validation (a placeholder label, say) gets that error
instead, which leaves the count alone. Validation refuses test cards and generic option labels ("Test", "Option 1",
"Erste Option", `asks.LABEL_RULE`): a probe card with such options reached a user. A header names a topic within the
chain of picks that answers one request, the cards answered since the user's last typed message (`AskHistory.chain`):
a card with a question under the header of one the user answered in that chain, with a pick or with text, is refused
whatever it offers, while after a typed message a common header ("Zeitraum") may name another topic. A card that
offers again the option picked under the same question is refused across the whole conversation; the refusal names
the answer (`asks.repeated_question`). Models asked a topic again under new labels, mostly when an
answer's look-ups ran out and a card was the way to go on. The refusal says to use the answer, or to ask only what it
left open under a header that names that, so a pick that did not work can still be replaced. A question the user left
open, in a card they answered or by replying in their message instead, may be asked again. A Run question is left
out, the decline too, since each run and each workflow needs a pick of its own and a user who declined may want the
run after all; and a card whose Run pick was used counts no more with any of its questions. A pick without a value or
datasets beside options that add datasets (the skill's "Leave it open") is left out as well: it chose no data, and
every dataset card offers it. A stopped answer keeps the cards and workflows it showed in the history too, so a later answer to the card
finds it. The user's answer is the next run's message (`RunMessage.answer`): it is checked against the stored card
before anything is stored (a card is answered once), kept with the user message and returned as that message's
`metadata.answer`, and given to the model with the values the card attached (`asks.answer_lines`, in a block of its own
after the user's text, `prompt.with_note`). The card never carries its option values, such as a layer or a catalog id,
to the web: the card part leaves them out (`asks.card_data`), so do the stream and the transcript of the `ask_user` call
(`asks.public_args`), and the stored rows keep them. An option that adds datasets names their ids in `adds`, hidden the
same way, and its `value` can then be a short key: models gave such an option a slug as its value, the add tool found no
pick of the dataset, and the card was asked again. Each id in `adds` is looked up before the card is shown, in the
catalog and, for a UUID, in core as a dataset or a bundle the user can read, as the add tools check them: an id neither
knows refuses the card, so a cut-off id is fixed before the user picks it, and a lookup the service fails for lets the
card through, since the add tools check again. A card names at most `MAX_CHECKED_ADDS` (50) distinct ids in `adds`; one
with more is refused unchecked. An id that exists may still not be the dataset its label names: an option for a census
grid once added the user's own export of stops. So the card's result names each option's datasets by the titles those lookups
found (`AskShown.adds`), and the model sees a wrong id before the user picks it. An option whose label names a catalog
dataset the answer found (its title, or a part of the title that is a name of its own, `asks.label_names`) while a pick
of it lets no tool add one is refused with that dataset's id (`asks.unadded_dataset`): such options left the next
answer without the user's consent to add the data, and a second card asked only for that. The match is narrow, so an
ordinary choice ("Bezirke", "ÖV-Güteklassen") beside a dataset of such words passes; an option whose value is a
layer of the project or the dataset's own id needs no `adds`. An id the model then passes to another tool is streamed
with that call, as any argument is. The card is not on `/mcp`: its clients cannot show one.

**Write tools.** Next to read tools and proposals there is a third risk class, `write` (`ToolSpec.risk` in
`tools/runtime.py`): tools that create a workflow in the open project, run one, change one or add a dataset to it.
They create, a run replaces its workflow's previous results, and `workflow_update` changes a workflow (Changing
workflows, below); nothing else changes or deletes what exists. They belong to the workflows pack
(`tools/workflows.py`, the runs in `tools/workflow_runs.py`, the edits in `tools/workflow_edits.py`), which is offered
on the Map and Workflows pages only and never on `/mcp`. Every write goes
into the project of the page: no write tool takes a project id, so text inside a dataset, a template or a tool
description cannot make the assistant write into another project. The user's rights apply, since every call carries
their token: a viewer is told they can view the project but not create or change workflows or add datasets in it, and the
instructions tell the model not to try again (core answers 401 for missing rights as well as 403). So a tool says the
sign-in expired only when the request's token is missing or past its `exp` (`http.sign_in_expired`); any other 401 from
core means no access. A write called again with the same arguments anywhere in the conversation returns its first
result, a repeatable write (`ToolSpec.repeatable`) only within one answer: `workflow_run` repeated in an answer returns
that answer's first summary and runs again in a later answer, where "run it again" asks for a new run. Each answer
starts with the conversation's earlier results of the other writes (`toolset.earlier_writes`, from the stored parts,
which also keep the calls of an answer cancelled afterwards), and writes run one at a time, so an identical twin in the
same response finds the first one's result. A retry or a "try again" with the same arguments thus never creates a second
workflow (a changed draft is a new call); only a write that returned counts, so one that failed can be tried again. The
audit row of a write keeps what it created (the `created` column of `assistant.tool_call`, from the result's
`created()`), and that of an edit what takes it back (`undo`); if reading either fails, it is logged and the call still
answers, since what was written exists. A dataset
the model chooses, a catalog dataset (`project_add_catalog_layer`) or one of the user's own (`project_add_dataset`, with
the id `core_find` gives), is added only when the user picked it in a card: `dataset_picked` in `tools/workflows.py`
reads the stored cards and answers (`asks.recent_picked_ids`), never the model's words, and a typed reply is no pick. A
pick counts when the option's `value` or `adds` names the dataset or a bundle it belongs to. The user's own dataset is
read with their sign-in before it is added, so only a dataset they can read reaches the project. A catalog id can be a
UUID like a user's dataset's, and models gave one to the other's tool (and a dataset of the user's to
`catalog_get_record`): when an add or that read fails, the other service is asked whether it knows the id (core only for
a UUID), and the error names the tool that takes it. The lookup runs only on that failure, so an add that works costs no
second call. The datasets a workflow template ships come with the template instead (Templates, below). Consent is only
as good as the card's labels: the model writes them and the option values stay hidden, so the user agrees to what a
label and its description say; a pick adds one dataset to the page's project, where it is visible and can be removed.

**Running workflows.** `workflow_run` runs a workflow of the open project through processes'
`POST /workflows/{id}/execute`, as the Run button does, and waits for it inside the tool call: no model call is made
while it waits, and the run's progress goes out as a `workflow-run` data part (one per job, replaced as it changes, sent
again after `HEARTBEAT_SECONDS` without a change, `tools/workflow_runs.py`). A run replaces the workflow's previous
results, so it starts without asking only for a workflow this conversation created, with no export set to overwrite and
whose latest run, if any, this conversation started (`run_permission` in `workflows/runs.py`, read from the
conversation's stored parts); any other run needs the user's pick of Run in a card, one pick per run, and the refusal
names the condition that failed, so the card says what a run does. A workflow with a dataset step without a layer is
not started: processes refuses such a run anyway, and the refusal names the steps whose layer the user chooses first.
A run processes refuses and a wait on a run already going use up the pick as well. A run already going is waited for, never started twice. The answer keeps one clock:
`ASSISTANT_RUN_MAX_SECONDS`, which a waiting run moves to `ASSISTANT_RUN_WAIT_MAX_SECONDS` from the answer's start
(`clock.AnswerClock`); a run is not started when the answer has too little time left to wait for its first status, and
when the wait has to end first, the run goes on and `workflow_last_run` reads it later. Stopping the answer cancels the
run it started, never one it only waited for; a Stop while the start request is still on its way cannot, since the
job's id comes only with processes' answer. A shutdown of the service, or a run that lost its lease to the sweeper and
is ended here for it, ends the answer, not the run (`ToolEnv.stopping`): the job goes on, and `workflow_last_run` reads
it in the next answer. Once the run has started, a read does not fail the call, since a failed call may be tried
again and that would start the workflow again: a status read that fails because processes is briefly unavailable is read
again while the answer has time, any other failed read ends the wait with the run as still going, and a saved layer's
fields are read best effort. They list the fields the run added first (joined fields and the steps' result names), since
a join adds its fields last and the list stops at `MAX_SAVED_FIELDS`. The permission and the wait for a run already
going read processes' job list, which holds the user's jobs of the last three days, at most 100 of them: the permission
does not see a run of the user's older than that, and an active run whose workflow the list does not name (processes
leaves out the inputs of a job it could not read) stops a start, since it may be this workflow's. The summary of a
failed or cancelled run names the failing step and its error and marks each step the run reports nothing for as
`unknown`, which may have finished: processes attaches the steps' results to a successful run only and their statuses
while it runs. Each tool step lists the settings the run was sent, its variables resolved (`step_settings` in
`workflows/runs.py`), so the answer states the method as it ran (time window, mode, limits): the nodes and variables
processes keeps with the job, since the toolbox runs with other variable values than the stored ones and the editor with
its unsaved nodes, and the stored config for what the job lacks. Plain values are listed as they are, statistics as
`sum(field)` and opportunities by name and `max_cost`; ids, filters, geometries, SQL text (its literals can hold data
values) and the names of result layers are left out, before the cap counts. Besides the settings it was sent, each tool
step lists the settings it left out at the tool's default (`step_defaults`): the assistant's drafts hold only what the
model wrote, so a run at the defaults would otherwise state no time window. They come from the tool's process
description, read once per tool and cached, and a description that cannot be read leaves them out. A default is listed
only when the editor shows its setting for the step's values (`goatlib.workflows.visibility`, advanced settings counted
as shown, since they apply all the same) and the tool applies that very value: a setting whose form value follows other
settings (`default_from`, `default_by_field`, ...) is left out, since tools resolve those themselves and the static
default is not always what runs: a catchment's limit follows its mode, and a travel cost matrix's street limit
(`max_cost`) left out is unbounded, not the form's value. `project_group_statistics` reads results per group, or one row
for the whole filtered layer without `group_by`, through processes' `aggregation-stats`, the statistics behind the
dashboard charts; with `share_of` it reads the other layer's statistic too, with a filter of its own (residents in a
catchment over all residents: the denominator needs another filter than the numerator), and divides each row's value by
the other layer's for the same group, or by its total, in this service, so shares and totals in an answer never come
from the model's arithmetic, and its note says how many groups have no share and why. The rows stop at 100 groups, but
the denominator is read with up to `DENOMINATOR_GROUPS`, since a row's group may come anywhere in the other layer's
list. A denominator from another layer gets a note: if the layers come from different sources, check that both count the
same population (source and year). Under Restricted it sends counts only, for few groups (judged over the whole layer,
also with a filter), no count of a group under `MIN_RESTRICTED_GROUP` features, nothing for a filter that matches fewer
features than that, and nothing at all with `share_of`. A join names the fields it adds `join_<name>`, and models often
leave the prefix out, so the statistics tools and the count's filter read `join_x` for a field `x` the layer lacks and
say so in the result's note. The name is resolved before anything else, so the Restricted checks judge `join_x` exactly
as when the model names it.

**Building a workflow.** The model is shown only the tools of the user's toolbox (`offered` in
`tools/workflow_tools.py`: `GET /processes` for the user, without the tools hidden from the toolbox, such as custom
SQL), and the check and the create refuse a draft naming any other tool: processes describes, checks and runs every
tool it knows, the hidden ones and beta tools for a user outside the beta included. The model writes one draft for
the whole workflow. A pure function turns the draft into the editor's config (`to_config` in `workflows/draft.py`:
ids derived from the draft's and a salt, the editor's handles and dataset filter format, a layout and a stored
viewport, since the editor opens a workflow at its stored view), so the check, the create and the editor read the
same config. Every call converts the draft once with a fresh salt: the create saves the config it has just checked,
and two workflows made from one draft share no node id, which goatlib finds an export's result layer by. A draft's
notes (at most 5) become the editor's note nodes (`textAnnotation`), placed above the steps they explain, which the
runner and the check skip: the model writes plain text, escaped into the editor's HTML, so no markup of its own
reaches the canvas. More than one note gets a warning (`note_issues`), not an error, since only the user can ask for
more; an over-long note is refused with the words to shorten it by, so the model never asks the user about a note.
The check is
the editor's own (`POST /workflows/check` on processes) plus the assistant's check of filter fields
(`filter_field_issues` in `workflows/issues.py`, which does not judge a layer geoapi lists no fields for yet, such as
a catalog dataset just added), a warning for catchments split by budget where one with bands would do
(`band_issues`), and an error for a catchment whose dataset steps give more start points than one run takes and
for a travel cost matrix with more origin and destination pairs than one run takes (`starting_point_issues`,
`matrix_pair_issues`: each dataset step's layer counted once with its filter through processes' `feature-count`,
against the limits in goatlib's `tools/limits.py`), which the run would otherwise fail on only once it reaches that
step. The count follows merge and centroid steps, whose rows are their inputs' together, and stops at any other
step, whose rows only its run knows; a sum with a count that could not be read is left out rather than reported low.
Under Restricted, a filtered count below `MIN_RESTRICTED_GROUP` counts as one that could not be read: the issues'
messages name the counts, and `project_count_features` withholds such a count too.
The check's issues come back in the draft's ids, the message of a one-step issue starting with the step's name
(`draft_issues`). It needs the user's toolbox and the tools' process descriptions, for the steps'
titles, the layer inputs and the field settings: without them a draft is unchecked and `workflow_create` refuses.
Each setting reaches the model with what it means, its description and the tool's example where it gives one
(`workflows/tool_info.py`): a name and a type do not tell a band edge from the width of a band.
Processes' 400 or 422 on a draft goes back to the model as an error to fix; only when processes cannot be reached or
fails is a draft left unchecked.
The model can tell a dataset that covers far more than the place asked about, which then gets an area filter:
`project_get_layers` gives each layer's extent, rounded, and, for a catalog dataset, the feature count its copy
recorded (core keeps no count for other layers, and counting each layer on every call would read whole tables). A
heatmap whose destinations exceed what it takes is processes' `too_many_destinations`, which blocks the create like
any other error, unless an If step may skip the heatmap: then it is a warning, which blocks nothing. A template's
inputs are bound without a filter, so the skill binds them only to layers that fit the place and drafts the workflow
with an area filter otherwise; the check of the template's workflow (Templates, below) catches such a binding only
where it would stop a run.
Only readable layers of the page's project reach processes, as for the project tools: a locked layer is refused
before anything is sent, and a tool step's settings may not name one of its layer inputs, because layers reach tools
only through connections and a layer set as a setting would pass by the step's `layer`, the connections and the
refusal of a locked layer. That rule needs the descriptions too, and a draft without them is never created (`prepare`
and `check` in `tools/workflows.py`). A workflow is created only when every issue that would stop a run is one the
user resolves by choosing the layers of the steps left open, on such a step or a step downstream of it: no layer
chosen, a required field setting whose layer is still to be chosen, or a setting the tool rejects where it reads such
a layer (the input itself, a field setting or a list whose items read it, the settings of an opportunity on that
handle, and the opportunities as a whole while every connected one reads such a layer, since processes then cannot
say which one an error belongs to). A rejection of such a step as a whole, naming no setting, stays open too,
whatever its cause, since the check does not name one. Everything else blocks, a rejected setting that reads no such
layer among them (`split_issues`, fed by `layer_settings`). The create also answers with the assistant's own warnings
(bands, notes), apart from the issues left open, since a model may create a draft without checking it first and would
not hear them otherwise. Creating starts no run: `workflow_run` does (Running workflows, above), or the user with Run.

**Changing workflows.** `workflow_get` shows the model a stored workflow by its node ids, and `workflow_update` changes
it with step-level operations (`workflows/edits.py`, applied by `goatlib.workflows.ops`), not with a whole new config, so
the model cannot drop or garble what it did not mean to touch; an added step is built by the draft converter, so an edit
writes what a create writes. A create's rules hold for an edit, and the stored config is checked together with the
edited one: only a blocking issue the edit adds refuses it (issues are compared by code, steps and field, never the
message), so a workflow with an unrelated error stays editable. The save goes through core's PUT on the revision the
edit read (`base_revision`), so no edit silently overwrites another; a damaged stored config is refused, never repaired
by a guess. Edits are direct, with no card, because the dock's Undo takes them back (`undo.py`): the call's audit row
keeps the config before the edit and both revisions, outside what the model reads, and Undo writes that config back
under the user's own sign-in, so core decides whether they may still change the workflow. It saves once per workflow,
the oldest content on the newest revision, since saving edit by edit would conflict with itself, and it asks before it
writes over a save made between or after the answer's edits. Its mark (under way, undone) lives in those audit rows
rather than a column of its own. Filters and If conditions hold literals picked from the data, so `workflow_get`
withholds them under Restricted, as `project_get_layers` does a layer's filter. An edit makes the answer's earlier reads
of workflows stale, so a later read runs again (`ToolSpec.invalidates`).

**Templates.** `workflow_find_templates` searches the whole query and also its longer words (`MAX_SEARCH_WORDS` and
`MIN_SEARCH_WORD_CHARS` in `tools/workflows.py`), because core matches the whole query as one piece of a template's
name or description (`ILIKE`, no categories, no stemming, in the language the author wrote). Template texts are often
German while the user and the model write English, and a user can use only a few workflow templates, so when no search
finds one, the tool lists the workflow templates the user can use instead (`MAX_LISTED_TEMPLATES`, most recently
changed first, with a note saying whether these are all of them) and the model judges the fit from their names and
descriptions. When the searches find fewer than that, the other usable templates come beside the hits
(`other_templates`, up to `MAX_LISTED_TEMPLATES` in all, without repeating a hit), since a word can match a template
that fits worse than one written in the other language; the list is read in the same round trip as the searches, and
when only it fails, the hits come alone. It searches once per answer (`ToolSpec.once_per_answer`): every later call in
the same answer, whatever its words, gets the first call's result with a note instead of asking core, and runs alone,
so a twin in the same response finds that result too. A rephrased query searches the same names and descriptions,
while each call takes one of the answer's look-ups; a repeat still takes one, since the run budget counts every call
let run. Before a write the template is read, and only a workflow template is used (core would put a
layout template into the project's layouts). A binding must name one of the template's input keys: core ignores an
unknown key, which would leave that input open, and the corrected call would make a second workflow. The workflow a
template makes is checked before it exists: core's `POST /template/{id}/use/preview` answers with the config the use
would write with the same bindings, writing nothing, because a template's frozen config is not readable by its viewers
and binding it here would copy core's rules. That config goes through the draft's check and create gate
(`_check_template`, `config_graph`): a step without a layer is open like a draft step left open, so an input left
unbound stays open, and any other error refuses the use with the issues and what to do instead (`_refusal`): bind
another layer or draft with an area filter when the issue is on a bound input's step or downstream of it, such as
`too_many_destinations` for a bound layer that is too large; use another template or a draft otherwise, since no
binding fixes the template's own issues, and also when processes refuses the config itself. An unbound input the
check does not name (processes checks nothing in a workflow without a tool step) is named from the preview's
unresolved inputs. A step that reads an empty copy's dataset is open too, and its `layer_not_readable` is dropped
(`_empty_copy_steps`): core shares no empty copy's dataset, so the user cannot read it until the copy job points the
steps at their copy. Core's preview clears the tool settings that name that dataset by an entry (the use points them
at the copy's new entry), so a tool step it feeds that is still `layer_not_readable` names another layer, and blocks.
Using a template also links the datasets it ships into the project, catalog datasets among them, without a card; the
result's notes list the layers it added by layer_project_id and say when copies of its datasets are still being made.
Template text from other users is clipped before it reaches the model, step names and the check's messages about its
workflow included.

**Skills.** Built-in skills are instructions in the Agent Skills format: a folder per skill under `skills/` with a
`SKILL.md` (front matter with `name` and `description`, then the instructions) and Markdown reference files next to
it. Nothing in a skill is executed. All of them are read at import (`skills/__init__.py`), so a malformed skill stops
the service at startup naming its file; the instructions list each skill in one line after the fixed prompt (in the
cached prefix, `prompt.static_instructions`), and `skills_load` serves only what was read: a file name is looked up
among those files, never opened as a path. A loaded skill stays whole in the conversation's history
(`history.KEPT_TOOLS`), so it is not loaded again each turn. The first skill, `build-a-workflow`, carries GOAT's
common chains in one reference file per kind of question (heatmaps, catchment areas, public transport service, joins
and distances), and its `SKILL.md` says which file a question needs: every file loaded stays in the history and is
sent again with every later call, so a conversation loads only the one it uses. Its tests
(`tests/test_build_a_workflow_skill.py`) check that every assistant tool it names exists, that each recipe sits in
exactly one file, and that its example drafts use only tools, inputs, settings and choices found in process
descriptions captured from processes (`tests/fixtures/process_descriptions.json`).

Prompt caching: every model call of an answer resends the instructions, tool definitions and the conversation so
far. OpenAI, Azure OpenAI, DeepSeek and Mistral cache that prefix by themselves; Claude (direct, Bedrock, Vertex) and
models behind OpenRouter that need it get explicit cache markers (`llm/providers.py`). The page note (language,
page, filters) travels in each user message (`prompt.with_note`), not in the instructions: it changes when the user
moves or filters, and anything that changed ahead of the conversation would make every call read it again. For the
same reason every call of an answer offers the same tools, and the note on the answer's stage near the run's limits
comes after the conversation (`agent.StageNote`, below). Cached tokens are recorded per run and shown in the answer
details.

OpenRouter sends one model to many providers, which differ in price, speed and precision (some serve 4-bit weights),
and picks one per call unless told otherwise. An OpenRouter connection can therefore name its providers in order
(`provider_order`, with `allow_fallbacks` for when those fail); the connection test runs with them, so it tests the
pinned provider. Only OpenRouter connections take them (`llm/providers.normalize_connection`).

Long conversations: because every call resends the conversation, earlier answers' search results and reasoning soon made
up most of each call, and an answer ran into `ASSISTANT_RUN_MAX_TOKENS` after a few searches. So before each call
earlier answers' long tool results go to the model as their counts and their reasoning is left out
(`assistant/history.py`); what the answers said and the cards they showed stay, and the stored history keeps everything.
What an answer read about a dataset, its catalog record or a layer's fields (`history.KEPT_READS`), stays whole up to
`KEPT_READ_CHARS`: shortened to counts, the next answer read the same records again, most of all after an answer
that ended on a card with little text. The cap is there because a kept result is resent in every later call; a
bundle's record, which lists its datasets, grows with them and is shortened as before, and of the same call made in
several earlier answers only the newest result stays whole. The current answer's reads change none of the earlier
ones, so its calls keep their cached prefix.
And before either run limit, the model's next call is told to answer with what it found (`assistant/budget.py`), so a
long search ends in an answer, or in a card when the user has to choose, not only in the limit error. Every call of an
answer offers the same tools with the same instructions; the stage of the step (`answer_step` in
`assistant/tools/toolset.py`) applies as its calls run: a call the stage does not allow is refused with one line on
what to do instead (`STAGE_REFUSALS`), and counts toward the tool-call limit. After a step whose calls its stage all
refused, the run answers in text: its calls go out with tool_choice "none" and the same tools (`RunDeps.text_only`),
since each attempt of a model that insisted was a model call of the whole context. The step that answers with room for a
card still runs two kinds of calls besides the card, since a card that asks whether to do them takes the user a turn
for a choice already made: `workflow_run` of a workflow the answer created and has not run, while a read step and the
answer step still fit and no other result waits to be written about, so its result is read before the answer; and
`project_add_catalog_layer` of a dataset the user picked in the card that came with the message, as the add tool's
own check reads that pick (an id in a picked option's value or `adds`, or a member of a bundle one names;
`asks.answered_pick`). Nothing else: a workflow from an earlier answer, a second run in the step, a workflow whose
run the answer already started, whatever came of it (`RunDeps.run_attempts`), or a dataset picked in an earlier card
is refused (`ANSWER_STEP_REFUSALS`). The note offers them only when they apply, and
the room for the run is decided with the stage (`RunDeps.run_room`), so the note and the call agree.
The note on the stage is the last content of the call, after the conversation, and goes only into what the model is
sent, not into the history (`agent.StageNote`); the stored request records its stage in its metadata instead
(`agent.STAGE_KEY`). An answer step that changed the tools and the instructions made the provider read almost none of
the answer from its cache, and so had to be sized as a call that misses it. Once an answer's look-ups end, they stay
ended. A finished workflow run's result the answer has not written about yet is the exception: the answer may
still read it with the project's read tools and `workflow_describe_tool` (what the result's fields and scales mean),
one call per layer the run saved and one more, at least `RESULT_READS` and at most `MAX_RESULT_READS` in all
(`budget.read_allowance`), also past the tool-call limit, while two calls fit before each read step: the read step and
the answer step. A look-up keeps the same room after it, so a workflow run in an answer's last look-up still leaves
room to read its result; with room for the answer step alone it did not. Room for a third call, to ask a response
without text again, would keep the read step out of reach, so after a read near the
token limit, asking a response without text again can end the run at the limit (`run_limit`), before the fixed text
that `runs/turn.py` gives an answer without text once its retries are used up; a model that writes its text always
gets its answer in. The note that allows the card always asks for the text first, in the same response: cards that
came alone left the user a question with nothing said before it, and while a result is not yet in the text such a
card is refused. Reads of the result that reach the
tool-call limit in a step that may still look things up run past it too, from the same allowance: models read a
result's layers in one batch, and the limit cut such a batch halfway. The answer step keeps its room (`StepGuard`);
after reading, the run looks nothing else up. Allowed only the card, answers could not read more of their results,
and their attempts to read came out as cards; with three reads, a run that saved four layers left one unread. The
note names no budget, and says a card ends the answer: models repeated the word to users, and a note that promised
the next answer a fresh budget made them ask with a card for permission to go on. The instructions name it as a third
kind of GOAT note, after the language and page notes, to follow and never to quote, and tell answers to leave out how
the assistant works (budgets, limits, stages, its look-up steps).
`ASSISTANT_RUN_MAX_TOKENS` counts tokens read from the provider's cache at a tenth, roughly what they cost: every call
rereads the cached prefix, and counting it fully stopped answers on cheap rereads. The budget and the
hard limit count the same way, and the hard limit leaves room beyond the budget for one call that misses the
provider's cache (`budget.RunLimits`): the calls that end an answer are planned at the newest call's cache reads, a
miss charges those tokens in full, and such an overshoot costs tokens while a run failed at the limit costs the answer.
A provider that read nothing from its cache in the run gets room for one call of the newest call's context instead:
a call more than planned (a card refused until the result is written about, a call its stage refused) costs that
much.
The calls that end an answer are sized at their whole context, read from the run's messages (the newest call's input and
output plus the tool results the next call sends), with what the newest call read from the cache counted as cached
(`budget.call_cost`); a provider that reports no cache reads pays the whole context for each. One more look-up is
allowed only while, after it, the read step and the answer step still fit with the run's largest step added; the card
while the answer step fits, since a card ends the answer, and otherwise the step answers in text. Within a step, calls
past the run's tool-call limit are refused as they run, and
every call let run counts toward that limit, failed ones too. A call a service failed twice for (a 429 or 5xx answer, no
answer in time, or none: `http.service_failed`) is refused on its next repeat without asking the service again
(`SERVICE_FAILED_TWICE` in `assistant/tools/toolset.py`); the first retry still runs, since a service can fail for a
moment. A 4xx answer does not count: it is the service's verdict on the call. A result that would leave the answer step
too little room is refused (`StepGuard`), which ends the run's look-ups (`answer_step` in `assistant/tools/toolset.py`).
The step's other calls go on, and where the answer step still fits after the run's first call (which is not checked),
the run answers with what it found instead of failing at a limit.

An answer also has to end in text. Pydantic AI asks again after a response without text or a tool call (only
reasoning, or nothing), with the same tools, and a model that gave one often gave the next alike until the run failed
on its output retries ("Exceeded maximum output retries"). It also takes any text that is not empty as the answer, so
an answer could end after its cards with a single space. Such an answer is asked for its text
(`agent.ends_with_text`); only the last retry's answer is taken as it is, since failing the run then would lose what
the user has already seen. And the second response of a run without a tool call or text beyond whitespace ends its
look-ups (`SILENT_RESPONSES` in `assistant/tools/toolset.py`): the next call is the answer step, told why
(`prompt.ANSWER_IN_TEXT`). A model can still give no text until Pydantic AI gives up. After a `workflow_run` that
succeeded and saved layers, with nothing written since, that would end the answer as a failure while the run card and
the layers are there: such an answer ends with a fixed text instead (`runs/turn.py`, `NO_ANSWER_CAVEAT`), a caveat the
dock shows in the user's language by its kind, the run completes, and a warning is logged. The next answer finds the
text in the history after everything the run found, so the user can ask for the numbers. Otherwise the answer still
fails: after a failed run or one without layers there are no numbers, and `workflow_last_run` shows no run card.

Behind a connection pooler in transaction mode, set `POSTGRES_TRANSACTION_POOLER`: the pool then prepares no
statements on the server. The assistant holds no session state in Postgres (its locks are per transaction, its
streams go through Redis), so nothing else changes.

Tests need the local Postgres and Redis from the repo's `compose.yaml`: `uv run pytest apps/assistant/tests`.

Evals (by hand, never in CI; the regression workflows they keep do run in CI): see [evals/README.md](evals/README.md).
