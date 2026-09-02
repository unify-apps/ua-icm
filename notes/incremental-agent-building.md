# Incremental building with the copilot (started 2026-08-22)

> **Inherited from `ua-automationkit` (the Axis kit), 2026-09-02.** The
> build/test/fix loop for the text-to-workflow copilot. Platform behaviour, not
> product behaviour: it applies unchanged here. Axis names in the examples are
> where the lessons were learned.

Why: one-shot "build all 9 nodes" prompts make the agent work for 5-7 minutes
in a single turn. Long turns are exactly where the platform error
("service_hub_message ... required fromCustomerUserIdentityId") bites, and
when it bites the whole turn dies and no edit lands. Small steps = short
turns = fewer chances to die, plus we can verify, revert, and test after
every step.

## What the backend code says (read from ~/uacode, workflow/rt)

- The copilot delegates edits to sub-agents via two actions:
  "Invoke Workflow editor Agent" (edit existing) and "Invoke Workflow builder
  agent" (build). Both end in `UpsertAutomationAction`, which saves the
  WHOLE workflow definition in one call. There is no partial-save API - an
  "incremental" step still rewrites the full definition, it's just a smaller
  delta for the agent to get right, and a shorter turn.
- `UpsertAutomationAction`: if `workflowObject.id` is blank it CREATES a new
  automation (permission CREATE) instead of updating (permission EDIT). This
  is the mechanical cause of the misplaced-save trap - the sub-agent dropped
  the id and a stray "AI Generated" automation appeared with the build.
- The flaky error: when a turn's response message is persisted,
  `applyRequiredChannelFields` (AbstractPersistingResponseSink) stamps
  `fromCustomerUserIdentityId` from the turn context's agentId. On
  parked/recovered turns the context can come back without it -> required
  field null -> service_hub_message validation kills the turn -> the edit is
  lost. Long turns park and recover more, so they hit this more.
- The copilot has a `workflow-debugging` skill ("MANDATORY whenever the user
  asks to test, run, verify or debug") - so the agent can test-run the
  automation for us between steps.

## The step recipe

One chat per step (a NEW chat each time - stuck chats stay stuck). Each
prompt:
1. Names the step ("STEP N of an incremental build. Do ONLY this step.").
2. Names the workflow id explicitly.
3. Describes one small delta (a couple of nodes, or one node's logic).
4. Pre-confirms ("apply now without asking me again") to save a round trip.
5. Ends with: re-fetch, check the version moved, report it, admit failure
   plainly if the save did not persist.

After every step WE verify from the kit (never trust the agent's claim):
`node scripts/ua.mjs fetch <id>` - version moved? nodes as expected? Then
snapshot if it's a real automation. Revert = direct
POST /api/workflow-definition/update/{id} with the last good snapshot.

## Step plan used for a teams-directory-shaped callable

1. Skeleton: callable trigger with the full setup+result schema, respond node
   with static empty result. 2 nodes, wired.
2. Add 3 bulk fetch nodes: team, teamMember, platform users.
3. Add 3 more: issue, projectTeam, project.
4. Add the Groovy compute node with full logic, rewire respond to its output.
5. Ask the agent to test-run with a sample input and show the output.

## Results log

2026-08-22, throwaway "Fetch Teams" (6a896c04a96f7949f37d9974), one fresh
chat per step, every step verified by re-fetching the definition:

- Step 1 (skeleton: trigger schema + static respond): applied in ~2 min,
  version 0 -> 1. BONUS FINDING: it fixed the untouchable UI placeholder
  nodes in place - small steps get past the "placeholder nodes can't be
  edited" wall that killed one-shot builds.
- Step 2 (3 fetch nodes): ~1 min, version 2, exact inputs as asked.
- Step 3 (3 more fetch nodes): ~1 min, version 3.
- Step 4 (Groovy compute + rewire respond + applicationId fix to 'axis-qa'):
  ~6 min turn but survived; version 4, wiring all correct.
- Step 5 (test run): the copilot's test tool failed on ITS OWN missing
  'host' parameter (infra bug in the tool, not our workflow). Direct
  alternative: POST /api/test-workflow/initiate-test/{id} with
  {type, workflowDefinition, payload, version} - type REAL needs the
  workflow DEPLOYED first; type MOCK starts (returns runId) but waits for
  hand-fed mock outputs, so it is useless headless. So: real testing
  requires a deploy (human-gated), then initiate-test REAL, then
  POST /api/test-workflow/fetch-execution-details {executionId, nodeIds}.
  Deploy endpoint: POST /api/workflow-definition/{id}/deploy.

Verdict: 4/4 applies landed with zero platform errors, versus repeated
7-minute one-shot failures the same day. Incremental is the default way to
build from now on.

## Results log 2: the team-status family (2026-08-22, three automations)

Create/Update/Delete Team Status built in one session with the incremental
recipe. What the session added to the playbook:

- **Three agent chats in PARALLEL on three DIFFERENT workflows works.**
  Waves: the same step number for all three automations at once, verify
  all, next wave. No cross-talk seen in ~13 steps; total build time
  roughly a third of sequential.
- **Division of labor that held up**: the agent builds structure (new
  nodes + wiring), the kit does mechanical work directly (schema cleanup,
  edge fixes, renames, one Groovy rewrite, condition unwrapping). When an
  agent save died on the flaky platform error, redoing the step as a
  direct update from a proven node shape was faster than retrying chats.
- **Verify EVERY wave with a fetch** - the agent miswired Delete's first
  IF (both branches to the same respond, plus an edge out of a STOP node),
  claimed success anyway, and repeated the same class of mistake later on
  the in-use respond. The diff checklist caught all of them.
- **Test-run driven config fixes**: the first real run exposed the
  IF-conditions wrapper bug, the Groovy `inputs.x` binding bug, and the
  EXISTS-on-empty-string trap in one go (all now in runtime-facts.md).
  Nothing before the first testrun.mjs run is trustworthy.
- **Suites can chain workflows**: regress.mjs cases may name a different
  workflowId (fixtures via the Create callable, cleanup via Delete) and
  reference earlier case outputs with {{case:<name>:<path>}} - suites for
  WRITING automations stay repeatable by creating their own temps and
  deleting them at the end, with two permanent anchor fixtures for the
  refusal cases (ids in docs/automations/team-status.md).

## Headless test runs: SOLVED (same day, via a HAR from the builder UI)

The builder's Test button works on DRAFTS, no deploy needed, and we can call
it ourselves - that's `scripts/testrun.mjs <workflowId> ['{...inputs}']`:

1. `POST /api/test-workflow/initiate-test/{id}` with
   `{type:"MOCK", workflowDefinition:<full draft>, payload:<trigger inputs>}`
   -> `{runId}`. Despite the name MOCK the nodes really execute against real
   data. (`type:"REAL"` needs a deployed version; MOCK is the draft path.)
2. Read any node's inputs/outputs/error:
   `POST /api/lookup` `{type:"ByKeys", lookupType:"TEST_WORKFLOW_VARIABLE",
   keys:["<runId>.<runId>.<nodeId>"], options:{workflowId, startTime, endTime}}`.
3. Per-node status list (needs the signed test-deploy id, so less useful for
   us): POST /api/workflow-runs/node-executions with the aggregation query
   the UI sends.

Full fix loop proven on the throwaway: test run failed at the users fetch ->
read the exact backend error from the lookup -> prompted the copilot with the
error and the exact fix -> re-ran -> pipeline green up to the respond node.

## Facts learned from the first real test runs

- `standard_entities_fetch_users_by_criteria` wants the PLATFORM filter shape
  in criteria: `{op, values:[{field, op, values}]}`. The storage shape
  (`{operator, filters:[{property, filter:{operator,value}}]}`) makes the
  service blow up with "Filter$Op ... op is null". Storage fetch_records uses
  the storage shape. Two different filter dialects - know which app you're in.
- `axisNoCodeTeamMember.userId` IS the platform user id: a member row had
  userId "85973" and `__USER__.outputs.id` came through as 60340 - same id
  space, so isMember/isOwner/membership='mine' work as designed. (Old open
  question: answered.)
- The Axis interface (app) id on orbit is `axis-no-code` ("Axis No Code");
  it replaced `axis-qa` on 2026-08-22 (Fetch Teams Directory updated the
  same day, suite green on the new id).
- "No config found for resource callables_return_to_automation" on the
  respond node is NOT a harness artifact (first guess, wrong): it means the
  respond node's TYPE is ACTION when it must be STOP. That happens when the
  agent upgrades a UI placeholder node in place and keeps its ACTION type.
  Setting type STOP (one-field direct update) fixes it; STOP-typed respond
  nodes pass test runs fine.
- The copilot can report "save failed" while the save actually landed (the
  reverse of the misplaced-save lie). Version 4 -> 9 happened during a chat
  that swore nothing persisted. The ONLY truth is re-fetching the definition.

## Abandoned chats stomp minutes later (2026-08-23, Emit Entity Event)

An abandoned copilot chat applied its stale plan ~15 minutes after we gave
up on it and switched to direct updates: it silently REPLACED the finished
8-node build with its own 4-node step-1 skeleton (both IF arms wired to the
same respond). Worse, the stomp landed BETWEEN our fetch and our next
patch, so the patch script edited the gutted graph, its weak assert passed,
and we re-uploaded the wreck twice believing it was the fix.

Rules this adds:
- After abandoning a copilot chat, the workflow is CONTESTED until the
  conversation's responseGenerationStatus reads "completed" (fetch_conversation
  callable 66ab98083d73300e63962287 via POST /api/workflow/execute/node with
  {parameters:{caseId}}). Check it BEFORE any direct update.
- Every direct-update patch script must ASSERT the node ids it expects to
  touch actually exist in the fetched base ("patched ok" on a no-op is how
  the wreck slipped through), and every post-update verify prints the node
  LIST, not just the version.
- The update API is optimistic-concurrency guarded (HTTP 500 "version N is
  stale") - that error means someone else saved since your fetch: re-fetch
  and look at WHAT changed, never just bump the version and resend.

## send_mqtt_request: builder needs the dynamic-fields shape (2026-08-23)

utility_by_unifyapps_send_mqtt_request runs fine with parameters mapped as
ONE pill to a whole object, but the BUILDER cannot render that form - it
draws the graph only up to that node and drops everything after it (looks
like a half-deleted automation; validate and lint both still say clean).
The builder-conformant shape (from shipped platform workflows in
~/uacode/configs/platform-features/.../WORKFLOW_DEFINITION/): inputs carry
an `input` JSON schema describing each payload field plus per-field
`parameters` pills, and context carries resourceVersion. MQTT payload =
the parameters map, so field names become the event's keys.
