# Runtime facts (dug out of ~/uacode, workflow/rt) - the critique's ammunition

> **Inherited from `ua-automationkit` (the Axis kit), 2026-09-02.** These are
> facts about the UnifyApps *runtime*, dug out of the backend source and proven
> by real runs — they hold for any product on this platform, including ICM. The
> examples name Axis objects (teams, issues, projects) because that is where
> they were found; read past the example to the mechanism. Nothing here has
> been re-verified against ICM objects yet. When something in this repo
> confirms or contradicts a fact below, edit it here with the date.

Every performance/scalability critique must stand on a fact from this file,
a measured test-run number, or a fresh read of uacode. No vibes. When a
question isn't answered here, read the runtime first and ADD the answer.

Search ~/uacode freely and often - it is the ground truth for how every
node, filter, cache, trigger, and agent behavior actually works. Ripgrep is
your friend (`rg -n "<thing>" ~/uacode/workflow/rt`); connectors live in
~/uacode/connectors, platform configs in ~/uacode/configs. Whatever you
learn, write it into this file so the next question starts warmer.

## Parallelism: the runtime has it, our flows don't use it

- Node type BRANCH splits flow across its outgoing edges. Split types
  (SplitType.java): AND = ALL outgoing edges fire, OR = every edge whose
  constraint passes, XOR = exactly one (highest priority passing).
- BranchNodeRuntime starts AND-split branches IN PARALLEL (in non-debug
  runs; debug mode runs them one by one). Fork/join is real:
  ForkJoinRuntime + JoinType govern how branches meet again.
- Consequence: a chain of independent bulk fetches (like Fetch Teams
  Directory's six) pays 6x sequential latency for no reason. Independent
  reads belong on parallel branches that join before the compute step.

## Node-level caching exists

- Every node's `options.cacheConfig` can cache the node's execution result:
  TTL in seconds, `useInMemoryCache` for per-pod memory vs the shared cache
  (NodeCacheManagerImpl: persist(cacheKey, nodeId, workflowId, result, ttl,
  useInMemoryCache)).
- Good for slowly-changing reads (a user directory, config-like objects).
  Wrong for anything the same run just wrote.

## Sub-automations

- CallWorkflowNodeRuntime = one automation calling another (this is what
  the DRY doctrine builds on). CallBatchWorkflowNodeRuntime exists for
  batch invocation - check it before looping a call node.

## Execution + failure model

- Nodes default to `fallbackMode: STOP`: an error kills the run. Decide per
  node whether dying is correct (a missing optional enrichment should not
  kill the response).
- LOOP (LoopNodeRuntime) runs per item - an API call inside is a
  multiplier; BREAK/CONTINUE exist.
- The whole data of a run flows through node outputs held by the execution
  instance - one code node holding every record of five object types means
  the run's memory is the SUM of all fetched data. At lakhs of records that
  is the bottleneck.

## Data-fetch scaling truths

- A bulk fetch with limit N silently caps at N: with 10000 teams and limit
  10000 you're fine; with 10001 the answer is silently wrong. Every bulk
  fetch needs an answer to "what happens past the limit?" - either a
  provable bound, pagination, or a server-side filter that shrinks the set.
- Counting by fetching everything and counting in code stops scaling first
  (e.g. fetching ALL issues to compute per-team counts). Prefer server-side
  filters/aggregation once volumes are real - the platform has an
  aggregation API (POST /api/aggregation; group STANDARD needs projections).
- Fetch only the fields you use (`fields` projection on fetch_records) -
  payload size is part of latency.

## Filter dialects (crashes at RUN time, not save time)

- storage_by_unifyapps actions: `{operator, filters:[{property:
  "properties.x", filter:{operator, value}}]}`.
- standard_entities actions: `{op, values:[{field, op, values}]}` - the
  storage shape here throws "Filter$Op ... op is null".

## Node-config traps proven by test runs (2026-08-22, team-status build)

- IF_ELSE inputs are `{operator, filters:[...]}` at the TOP level. The
  text-to-workflow agent sometimes wraps them as `{conditions:{operator,
  filters}}` - the runtime then sees no filters and the condition is
  silently FALSE (flow always takes the `next` edge). Unwrap before
  trusting any agent-built IF node.
- Filter operator EXISTS treats the empty string as present. To test "this
  optional id was produced", use NOT_EQUAL "" - EXISTS on a `''` value
  fires TRUE.
- Groovy code nodes receive each `parameters` entry as its OWN binding
  variable (like `siblings`, `name`). There is no `inputs` map - a script
  referencing `inputs.x` dies with "No such property: inputs".
- A parameter pill pointing at a key the upstream node doesn't emit
  resolves to nothing and the binding is missing entirely
  ("No such property: x") - it does not arrive as null.
- `storage_by_unifyapps_update_record_fields_by_id` returns only
  `{success:true}` - NOT the updated record. A respond node that should
  echo post-update values needs a re-fetch node after the update.
- BRANCH (AND split) traps, proven on the Add Favorite build (2026-08-22,
  confirmed in uacode BranchNodeRuntime): the nodes AFTER the join must sit
  in the branch node's own parent `groupId` - the runtime then sees the
  `default` arm as empty and treats the third `branch` edge as the join
  continuation. If the agent puts them in the `...@default` group instead,
  the "continuation" becomes a third parallel arm and the run stalls/races.
  Also give every real arm a non-empty `conditions.filters` (an always-true
  filter is fine); the agent leaves `filters: []` on arms it considers
  unconditional.
- Test-run lookups (TEST_WORKFLOW_VARIABLE, parent run id) CANNOT see nodes
  inside branch arms - they run as child execution instances with their own
  ids. "not reached" on an arm node proves nothing; ground truth is the
  join-side node whose inputs show what the arms produced, or the record
  the arm wrote.
- More favorites-build facts (2026-08-22): every `branch`-type edge out of
  a BRANCH node needs a `name` field matching its entry in the node's
  `branches` array ("1", "2", ..., "default" for the join edge) - without
  names the arms NEVER spawn, conditions evaluate but no child runs.
  IF_ELSE filter entries must nest as `{property, filter:{operator,
  value}}` - a flat `{property, operator, value}` entry is silently false.
  Comparison operator names are `GT`/`GTE`/`LT`/`LTE` (SimpleOps enum in
  uacode infra/filter) - `GREATER_THAN` crashes initiate-test with
  "FilterBlock.getOperator() is null". And `fetch_records` STRIPS system
  fields: projecting `createdTime` returns nothing - store your own
  timestamp in a property (favorites use `position`) if you need to sort
  by creation time.
- Builder vs runtime, the 2026-08-23 post-mortem facts (Fetch Favorites
  rendered broken while every suite was green): the builder draws the
  graph from edge NAMES and groups, not from what the runtime tolerates.
  IF edges are named `yes`/`no`; branch edges are named by branch id
  ("1".. and "default"); every branch arm's LAST node needs an explicit
  `next` edge to the join node (runtime joins without it, builder shows
  the arm dangling and the validator flags "add a step to send a
  response"). `POST /api/workflow-definition/validate?strict=true` (body:
  the full definition) returns the builder's Violation[] - wrapped as
  `ua.mjs validate <id>`, the machine version of opening the builder. It
  caught the same defect in agent-built Add Favorite that eyes had missed.
- Record ids minted by `create_record` carry an `e_` prefix
  (`e_6a89...`); ids returned by `/api/entity/{type}` searches don't show
  one. Don't string-compare ids from the two sources without normalizing.
- `storage_by_unifyapps_fetch_records` with `includeTotalCount:true` +
  limit 1 gives a server-side count usable for existence/usage checks at
  any scale (proven: usedByIssues came back 1 with one matching issue).
- BRANCH fork/join works as runtime-facts promised: two AND arms with
  fetches, joined into a Groovy node, and the join waited for both arms'
  outputs.
- The agent wires STOP (respond) nodes with outgoing edges and both IF
  branches to the same node often enough that EVERY agent-built graph diff
  must check: no edge leaves a STOP node, and `if`/`next` point at
  different nodes.
- The BUILDER UI flags `NOT_EQUAL` with value `""` as an incomplete field
  (red error on the node) even though the runtime evaluates it fine. For
  "this string is non-empty" use `MIN_LENGTH` value 1 - builder-clean and
  runtime-proven. (Saumya hit the red node in the builder 2026-08-22.)
- Completion detection for headless runs: an automation with several
  respond nodes ends at ANY of its STOP nodes. Polling only the last node
  of the definition times out on early-exit paths - poll every STOP node
  (regress.mjs does this now).

## Write failures proven on a real run (2026-08-23, Create Team run 6a8a9a23c8d69a657f708b8e)

- Entity schemas declare real Mongo unique indexes: `uniqueKeyFields` at the
  top of the snapshot, `uniqueKey: true` on the field. `create_record` with
  a duplicate value throws the raw Mongo error (`E11000 duplicate key ...
  index: properties.identifierPrefix_1`) at RUN time — nothing warns at
  save time, and with default fallbackMode STOP the run dies and the CALLER
  receives that engine error as the outcome.
- There is no rollback across nodes. A side-effecting CallWorkflow that
  already succeeded (Matrix team created) stays done when a later node
  dies — the failed run left an orphaned Matrix team, and each retry of the
  same payload mints another one. Guards that can refuse a request must run
  BEFORE any side-effecting call.
- Consequence for every automation that writes: pre-check every unique
  field with a server-side filtered fetch and respond DUPLICATE_* cleanly;
  suite includes the same-payload-twice case.

## Project-family facts (2026-08-23, proven by test runs)

- `create_record` on `axisNoCodeProject` mints the RECORD id equal to the
  `publicId` property value (created "KUPR" → `outputs.id == "KUPR"`), so
  get-by-id with the public id works for projects. Do not generalize:
  team/status records get platform `e_…`/hex ids.
- `get_record_by_id` whose `id` pill DOES NOT RESOLVE (the upstream key is
  absent, e.g. an optional trigger field the caller never sent) outputs
  `{"exceptionClass":"java.lang.NullPointerException"}` and the run STALLS
  right there — even with fallbackMode CONTINUE and stepError CONTINUE. An
  id pill that resolves to `""` or garbage is fine (clean miss). Rule:
  route every optional input through a normalizing Groovy so every
  downstream pill always resolves to at least `''`.
- Suite discipline: never run two regression suites that share fixtures
  (or reuse ids) while an earlier run is still finishing — a timed-out
  suite keeps executing its remaining cases in the background and its
  late cleanup can race the next run (seen: a "phantom" PUBLIC_ID_TAKEN).

## Known scale numbers (update as we measure)

- 2026-08-22 test runs, single-digit record counts: each storage fetch ~
  10-50ms, Groovy compute ~ms, whole 9-node run well under 2s. No
  measurements yet at real volumes - measure before optimizing further than
  the structural rules above.

## Fetch Issues build facts (2026-08-23)

- Groovy code nodes must END WITH `return [ ...map ]`; that map becomes
  `outputs.result` (consumed as `{{ n_X.outputs.result.key }}`). Assigning
  loose bindings (`valid = true; q = [...]`) does NOT populate the declared
  output props - the engine fell back to the last Map binding (`q`) and every
  other declared property was missing. Proven: an IF reading `result.valid`
  saw nothing and took the else path though `valid` was computed true.
- Storage `fetch_records` server-side sort parameter is `sortBy`: an array of
  `{field, order}` with order `ASC`/`DESC`, field in DOT form
  (`properties.title`). Proven working for real fields (title asc/desc
  reversed). It does NOT sort by system-time fields: `sortBy` on
  `createdTime`/`modifiedTime` returned identical asc/desc order (system
  fields are stripped) - reject created/updated sort rather than mislead.
- A respond-node array field set to an empty `mappedArray`
  (`{ua:type:mappedArray, source:[], items:{}}`) serializes as MISSING, not
  `[]`. Use a literal `[]` for guaranteed-empty array outputs; keep mappedArray
  only for real pill sources.
- Storage filter `property` uses the UNDERSCORE form (`properties_teamId`,
  `properties_priority`); the `fields` projection uses the DOT form
  (`properties.teamId`). Same field, two spellings by position. (Confirmed on
  the deployed Fetch Projects and re-proven here: team/project/priority filters
  all returned correct sets.)
- Standard-entities User fetch (entityType User, group STANDARD), probed
  2026-08-23 on the member-records build: an `id IN [...]` FilterBlock
  (UIFilter dialect) silently returns ZERO rows — with string values AND
  with numeric values — while `id EQUAL <single id>` works fine; and the
  platform `{op,field,values}` dialect on the same node is silently
  IGNORED (returns the unfiltered directory). Bulk user lookups must
  fetch the app directory (applicationId EQUAL) and join in code — the
  pattern the deployed Axis | Fetch Users automation uses.
- Node output JSON DROPS null-valued keys (probed 2026-08-23: a Groovy
  map entry `name: null` vanishes from the node's outputs). A contract
  that promises "field present, value null" cannot be kept - use "" (and
  write it in the spec).
- axisNoCodeIssue carries TWO constraints its schema snapshot does NOT
  declare (probed 2026-08-23, raw creates for the stats fixtures): `rank`
  is required ("Non Empty Validations ... required rank"), and Mongo holds
  a UNIQUE index on `properties.allocationKey` that is NOT sparse - a
  second issue with allocationKey null dies with E11000. Any future
  issue-creating automation must set both. Also: issue FK values keep the
  `e_` prefix (statusId "e_..."), while a raw project record's id equals
  its publicId (no prefix).
- Loop-with-results pattern (proven on Overview Stats + Add Team Members):
  the agent's `{items: pill}` LOOP config is WRONG ("null is required in
  {items=...} for For Each node") - real inputs are {repeatMode:'SINGLE',
  listSource: <pill>, captureIterations: bool}. There is no
  `outputs.iterations` on loop nodes; collect results with a
  variable_by_unifyapps_create_list node BEFORE the loop and an
  add_item_to_list node INSIDE it (listName pill = createList.outputs
  .items[0]), then read createList.outputs.items after the join. Loopback
  edge from the last inner node to the loop node is type `next` named
  `loopback`; inner nodes' group is <loopId>@<parent>@l.


## Builder saves silently drop mappings it cannot represent (2026-08-22)

Opening an automation in the builder and saving can DELETE parts of a node's
config without warning. Seen on Axis | Fetch Projects, which went from a
green suite to failing every case:

- the respond node lost its `projects` array mapping
  (`{{ n_ASM.outputs.result.projects }}`) - the other three scalar keys
  survived;
- the BRANCH node lost `splitType: "AND"`, which is what makes its arms run
  in parallel at all.

Both were restored from the committed snapshot and the suite went green
again. Same family as the platform stripping nulls on write: config the UI
cannot render is quietly discarded rather than rejected.

Practical consequence: after ANYONE opens an automation in the builder,
re-run its suite before trusting it. `ua.mjs drift` catches the version move
but not what was lost inside it, and the JSON still round-trips cleanly.

## Deleting records

The action is `storage_by_unifyapps_delete_records` (plural), driven by a
filter, not an id argument:

```
object_type, numberOfRecordsToDelete: "SINGLE",
triggerInputCondition: {operator:"AND", filters:[{property:"id",
  filter:{operator:"EQUAL", value:"<recordId>"}}]}
```

`storage_by_unifyapps_delete_record` (singular) does not exist and returns
"No config found for resource".

## skipIfBlank: empty string is blank, boolean false is NOT (2026-08-23)

Measured on KITB through Axis | Update Project, whose every updateField
carries skipIfBlank: true:

```
archived: true      -> written
archived omitted    -> untouched   (skipIfBlank doing its job)
archived: false     -> WRITTEN     the flag flips
name: ""            -> ignored     empty string is blank
```

So `skipIfBlank` blanks empty STRINGS only. A boolean `false` is a real value
and is written. An earlier note in this repo claimed the opposite and it was
wrong - it was never actually measured, only inferred from the ISBLANK
behaviour on a different action.

Practical consequence: archive AND un-archive both work through the ordinary
update path. A restore needs no special mechanism.

## `archived` is frequently MISSING, not false

Live on orbit: team "sujal" has `archived` undefined - the flag was never set.
Two rules follow:

- Filter with `archived NOT_EQUAL true`, NEVER `archived EQUAL false`. The
  latter silently drops every record whose flag was never set.
- `archivedAt` is not stamped automatically. KITB sat at
  `archived: true, archivedAt: undefined` after being archived through the
  update path. Anything that selects on `archivedAt` (a retention purge) will
  never see such a record - it becomes immortal trash. Always write the flag
  and the timestamp together.

## Clearing a foreign-key field needs UNSET, not an empty string (2026-08-23)

`axisNoCodeIssue.parentIssueId` has `foreignKeyConstraintEnforced: true`.
Writing `SET parentIssueId = ""` fails:

```
Reference entity with ID  not found in entity type axisNoCodeIssue
```

`actionType: "UNSET"` works and leaves the field undefined. `SET` with a null
value plus `unsetIfNull: true`, and `actionType: "REMOVE"`, also work. Any
cascade that needs to orphan a record must use one of those, not a blank.

## The `fields` projection on fetch_records does nothing for scale - but it DOES strip system fields (corrected 2026-08-24)

Fetching one record with `fields: ["properties.parentIssueId"]` and without
any projection returned byte-identical full records. The projection is
accepted and ignored, so it does not reduce payload or latency. Designs that
lean on it for scale - the issue-count arm in Fetch Projects, the tree fetches
in the delete automations - are pulling whole records.

**It is not a complete no-op, though.** On the Fetch Saved Views build
(2026-08-24) a projection listing only `properties.*` entries came back with
the record's SYSTEM fields gone: `createdTime` and `ownerUserId` were absent,
so the flow's `createdAt` shaped to `0` and its owner join had nothing to join
on. Adding `"createdTime"` to the `fields` list did NOT bring it back. Removing
`fields` entirely did. So: a projection costs you the system fields and buys
you nothing - if a flow needs `createdTime`, `modifiedTime`,
`lastModifiedBy` or `ownerUserId`, it must fetch without `fields`.

**`id` is the exception - it ALWAYS survives (corrected 2026-08-25).** The
fetch action appends `id` to the projection by itself: a node configured with
`fields: ["properties.name","properties.publicId"]` had resolved run-time
inputs of `["properties.name","properties.publicId","id"]`, and the row came
back as `{id: "kitrdproj1", properties: {...}}`. Proven on run
`6a8cc9b758b7d3259cbf67c4` (Axis | Remove Project from Team). So a flow that
projects `properties.*` and then reads `row.id` is CORRECT, not broken - do
not "fix" one by removing its projection.

## `ownerUserId` is the record's creator, and survives later edits (2026-08-24)

Every storage record carries `ownerUserId` alongside `createdTime`,
`modifiedTime` and `lastModifiedBy`. It is stamped by whoever created the
record and is NOT rewritten by later updates: the saved view `KITDELV` reads
`ownerUserId: 99293` while `lastModifiedBy: 60340`, after the delete/restore
suites had rewritten it several times. That makes it the only creator signal
available when an entity's schema has no `createdBy` property - used by
`Axis | Fetch Saved Views` for the Views page's Owner column. Caveat: it is
the identity that WROTE the record, so a record created by an automation
running as a service identity reports that identity as its owner.

## Storage `CONTAINS` is case-sensitive, and there is no ignore-case operator (2026-08-24)

A storage filter `[property: 'properties_name', filter: [operator:
'CONTAINS', value: 'OPEN']]` matched no record named "KIT TEST open board".
`CONTAINS_IGNORE_CASE` is not a valid operator - the run dies with
`Cannot invoke "..._UIFilter$SimpleOps.getOp()" because the return value of
"..._UIFilter$FilterBlock.getOperator()" is null`, which is the same error
shape a wrong-dialect filter produces, so do not read it as "wrong dialect".
Case-insensitive search means fetching the bounded set and matching in a code
node (and then `totalCount` must be the code-filtered size, not the store's
total).

## update_records writes at most `page.limit` records, and defaults to 20 (2026-08-23)

Found independently from both ends on the same day - the mechanism from the
source, the numbers from a probe. Both are here because each answers a
question the other does not.

**The mechanism.** Storage `update_records` (MULTIPLE) only updates the rows
its query's PAGE returns: the runtime searches first
(`BaseStorageAction.getPageDetailsOrDefault` - `page` comes from the node's
inputs, and the DEFAULT LIMIT IS 20 when absent), then updates each hit one by
one (`EntityServiceImpl.updateManyWithResponse`). So a bulk update node with no
explicit page silently caps at 20 records, and `failedCount` stays 0.

**Measured**, against a filter matching 24 records (writing a value they
already held, so nothing moved):

```
page {offset:0, limit:20}   -> {"failedCount":0,"count":20}    4 rows dropped
page omitted entirely       -> {"failedCount":0,"count":20}    same - default 20
page {offset:0, limit:500}  -> {"failedCount":0,"count":24}
page {offset:20, limit:20}  -> {"failedCount":0,"count":4}     offset works
```

**Proven live** the same day: deployed Delete Issue v19 archived only 20 of a
25-issue subtree and still answered TRASHED; with `page.limit 5000` the draft
archived all 25.

So `count` is the only signal that a bulk write was short, and it has to be
compared against the number the flow intended to write. `failedCount` will not
tell you.

Two rules follow:

- Every bulk update node needs an explicit `page.limit` sized to its worst
  case (5000 across the restore pipeline), plus a landed-vs-planned count
  check in the flow.
- Audit any update node written before this date. `Delete Issue` was fixed and
  redeployed as v20; check `Delete Project` and `Delete Team`, whose
  saved-view, custom-status and custom-field writes had the same shape.

## Grouped-pagination ground truth (from ~/Desktop/uacode + ~/Desktop/www4.0, 2026-08-23)

Backend source paths are under /Users/vinaykhatri/Desktop/uacode (CLAUDE.md's
~/uacode / ~/frontend/www3 are stale; real repos are ../uacode and ../www4.0).

- **Nested AND/OR filters ARE supported.** `ResolvedUIFilter` (infra/filter
  .../_UIFilter.java) is recursive: a node is a compound `{operator, filters:[...]}`
  (children recursed) OR a leaf `{property, filter:{operator,value}}`. Group ops:
  AND, OR only. So AND-of-ORs (keyset tiebreaker, `combine=or`) is expressible.
  Leaf ops include IN/NOT_IN/GT/GTE/LT/LTE/BETWEEN/EQUAL/NOT_EQUAL/EXISTS/MISSING/
  CONTAINS/ICONTAINS/STARTS_WITH/MIN_LENGTH/MAX_LENGTH/REGEX/WITHIN/CONTEXTUAL.
- **Native keyset cursor.** `CursorUtils` builds the correct multi-field tuple
  `OR(f1>v1, (f1=v1 AND f2>v2), ...)`, base64 `{filter,reverse}`, returned as
  `{next,previous}`; pass back in `page.cursor`. REQUIRES a sort. This is why the
  observed token decoded to `{field:id, op:LT, values:[lastId]}` (default sort id
  DESC). Deep OFFSET is `size=offset+limit` in OpenSearch — use keyset.
- **Sort** = `sortBy:[{field,order}]`, default `id DESC`. Field name goes to the
  store verbatim; **system logical names (createdTime/modifiedTime) silently
  no-op** unless declared aggregation columns (stored as aliases cTm/mTm) — this
  is why created/updated sort did nothing on orbit. Always append `id` as the
  keyset tiebreaker.
- **rank has NO platform LexoRank and NO uniqueness guarantee.** Keyset on rank
  alone is unsafe → use `sortBy:[{rank},{id}]` + the native tuple cursor. (Spike
  proved correctness with ~33 ties per rank value: 0 dup / 0 skip.)
- **Aggregation is real and workflow-callable.** `group` is the STRING
  `"ENTITY_REPORTING"` (not an object — that's why every object shape 500'd).
  GROUP BY + COUNT go in `projections`. In-workflow action
  `StorageAggregateRecordsAction`: `{object_type, projections:[{name,aggregationFunction:"GROUP",alias},{name:"id",aggregationFunction:"COUNT",alias}], triggerInputCondition, page}`
  → `{objects,hasMore,totalHits}`. One call gives per-group counts at any
  cardinality. AggregationFunction enum: GROUP/COUNT/DISTINCT/DISTINCT_COUNT/SUM/
  AVG/MIN/MAX/HISTOGRAM/BUCKET/... (>1 GROUP = multi-terms, sorts ignored).
- **Atomic increment exists.** storage update-records `updateFields:[{actionType:
  "INCREMENT"|"DECREMENT", fieldName, value}]` → Mongo `$inc` (fieldName auto-
  prefixed `properties.`). Value parsed via Double.parseDouble → **guard against
  blank/null** (throws). Safe for concurrent counter maintenance.
- **Frontend (www4.0): no grouped-paginated board exists.** The generic Kanban
  block (packages/blocks/src/Kanban) consumes PRE-GROUPED `[{category, items[]}]`
  (grouping delegated to the data source = our automation), has ZERO per-column
  pagination (columns CSS-scroll one materialized array), header count =
  `items.length`, and no multi-membership fan-out (data source must emit an item
  under multiple category rows). Single-list infinite scroll exists
  (`addOns.page.type==='INFINITE'`, react-query hasNextPage/fetchNextPage) for
  Table/Repeatable but is NOT wired per-column. Per-column paging needs frontend
  work; the automation is the grouping+paging data source.

## Aggregation + LOOP facts (v2 grouped build, 2026-08-24)

- **Aggregation REST shape fully cracked** (probes + uacode reporting/lib):
  `POST /api/aggregation` body `{entityType:"ENTITY_<type>", group:"ENTITY_REPORTING",
  projections:[{name:"ENTITY_<type>=::=<field>", aggregationFunction:"GROUP"|"COUNT",
  alias}], page}` - separator is `=::=` (EntityReportGroup.SEPARATOR), the query
  entityType is the REPORTING type (`EntityType.getReportingType`), NOT the raw id
  ("Invalid Reference Key" otherwise), and bare field names throw
  "Invalid Projection". Shape-valid queries then hit the analytics warehouse -
  which on orbit currently dies with "HikariPool ... Connection is not available"
  (infra, not shape).
- **The workflow aggregate action (`storage_by_unifyapps_aggregate_records`)
  silently DEGRADES**: with projections named `properties.statusId` or bare
  `statusId`, GROUP is ignored and the output is per-row
  `{columns:{<alias>: <field value>}}` - it looks like data but is a plain
  select, NOT buckets. Never trust its output without checking a real GROUP
  actually bucketed. v2 grouped counts therefore use a projected single-column
  fetch (limit 10000, `fields:[group column]`) counted in Groovy, with a
  truncation flag - swap to the aggregate node once the warehouse is healthy
  and the action proves a real GROUP.
- **LOOP node mechanics** (from Fetch Users / Add Team Members snapshots):
  inputs `{repeatMode:'SINGLE', listSource:'{{ pill }}', captureIterations}`;
  `loop`-type edge -> first body node; body nodes carry groupId
  `<loopId>@<parentGroup>@l`; last body node edges back `next name="loopback"`;
  the loop's own `next` edge is the continuation. Body reads the current item
  as `{{ <loopId>.outputs.item.<path> }}`. The SHAPE of `captureIterations`
  OUTPUT is UNPROVEN in the corpus (no snapshot consumes it) - do not design
  on it blind.

- **Builder strips undeclared Groovy parameters (proven v25, 2026-08-24).**
  A Groovy node's `inputs.input` SCHEMA is the builder's source of truth for
  its parameters: opening + saving the automation in the builder UI drops any
  `parameters` entry not declared in that schema (the grouped assemble lost
  its `colRows` mappedArray -> every count silently 0; suites were green
  because they ran before the builder touched it). RULE for direct edits:
  whenever you add/rename a Groovy parameter, update `inputs.input.properties`
  to match EXACTLY - schema == parameters, always. The builder also injects
  harmless default keys into fetch nodes (shouldSearchInAnalyticsStore etc.) -
  expect version bumps from a mere open+save.

- **Minted cursors work (2026-08-24, v2.1 grouped first-pages).** The keyset
  token is standard Base64 (CursorUtils uses Base64.getEncoder/getDecoder) of
  `{"reverse":false,"filter":{"op":"OR","values":[{field,op:"GT",values:[v]},
  {"op":"AND","values":[{field,op:"EQUAL",values:[v]},{"field":"id","op":"GT",
  "values":[id]}]}]}}` with DOT-form field names. A Groovy node can mint one
  (JsonOutput + bytes.encodeBase64) and the platform accepts it as
  `page.cursor` - proven end-to-end: grouped response minted a group's cursor,
  a flat fetch continued that exact column with no dup/skip.

## Filters: a nested OR group inside an AND works (probed 2026-08-24)

A filter node's static config cannot express "A AND (B OR C OR D)", but the
runtime accepts it when the whole filter object is BUILT in a Groovy node and
passed to the fetch as one pill - the shape Fetch Projects already used for
its team filter (`n_TFLT` -> `n_PRJ`):

```groovy
def filters = [[property: 'applicationId', filter: [operator: 'EQUAL', value: app]]]
if (term) {
  filters << [operator: 'OR', filters: [
    [property: 'name',     filter: [operator: 'ICONTAINS', value: term]],
    [property: 'email',    filter: [operator: 'ICONTAINS', value: term]],
    [property: 'username', filter: [operator: 'ICONTAINS', value: term]]]]
}
return [filter: [operator: 'AND', filters: filters]]
```

Proven on `Axis | Fetch Users` (standard_entities, entityType User) 2026-08-24:
`search: "krish"` returned total 1, `"john"` 1, `"unifyapps.com"` 5, `""` 10 -
i.e. the OR group narrows SERVER-SIDE, so `total` and paging stay correct
rather than being trimmed after the fetch. `ICONTAINS` is case-insensitive
("KRISH" matches). Before this, multi-field search in this kit meant fetching
wide and filtering in code, which breaks paging and scale.
## Storage write primitives, read from uacode source (2026-08-24, for Create Issue)

Probed by reading `workflow/rt/.../storage/*.java` + `entity/.../EntityServiceImpl.java`
+ `MongoEntityStore.java` + `infra/mongo/.../MongoRepositoryService.java`:

- `update_records` with `numberOfRecordsToUpdate: "SINGLE"` is a usable
  COMPARE-AND-SET: it searches with the node's filter (limit 1), then updates
  by (id, version) via Mongo `findAndModify` on `{id, version, notDeleted}`.
  A concurrent writer bumps the version between search and write -> the
  findAndModify matches nothing -> node output `{result: false}` and the
  record is untouched. Output shape SINGLE mode: `{result: bool}`; multi
  mode: `{count, failedCount, errors}` (count = records actually updated).
  This is the counter-reservation primitive (Create Issue spec).
- `bulk_create_records` returns `{inserted, insertedIds, errors}` and Mongo
  `insertMany` assigns ids onto the SAME list it was given -> insertedIds
  come back IN INPUT ORDER. A duplicate-key inside the batch THROWS (no
  per-record catch) and kills the whole node.
- `bulk_upsert_records_by_id` (StorageBulkUpsertAction) accepts records
  WITH caller-supplied `id` (`updates: [{id, updateFields...}]`, empty id ->
  server generates "e_<24hex>"). It loops server-side (one node call, no
  HTTP per item), catches PER-RECORD exceptions into `errors` keyed by id,
  returns `{success, successCount, failedCount, errors}`. So a flow can
  PRE-MINT ids in Groovy ("e_" + 24 hex chars, ObjectId-style) and write a
  whole parent+children tree in ONE node with FKs already resolved.
  Caveats: `skipSchemaValidation` defaults TRUE on this node (required-field
  mistakes land in Mongo, not in a validation error), and upsert-as-create
  must be verified once in a test run for envelope fields (createdTime,
  version, ownerUserId) before trusting it in a contract.
- standard_entities_fetch_entities rows wrap their projected fields under a
  `columns` key (`{columns: {id, name, email, ...}}`), NOT at the top level
  like storage fetch rows - joins must read `row.columns.id` (bit the Create
  Issue build 2026-08-24; USER_NOT_FOUND for a user that existed).
- `bulk_upsert_records_by_id` row shape is `{id, updateFields: [{fieldName:
  'properties.x', actionType: 'SET', setValue: v}]}` (probed 2026-08-25 on the
  Set Project Members build, matching Create Issue's n_PLN/n_CRT). A row with
  the fields FLAT (`{id, projectId, userId}`) answers `{success: true,
  successCount: 0, failedCount: 0, errors: {}}` and writes NOTHING. Success
  true with successCount 0 is the signature of a malformed row - never read
  `success` alone as proof a write landed. This is the ACTION's contract, not
  one object's: it holds for every storage object, so any flow using this node
  builds `updateFields`, and any flow that read `success` to decide a write
  landed is reporting a result it did not check.
- `bulk_upsert_records_by_id` with an EMPTY `updates` array is a harmless
  NO-OP (probed 2026-08-25, run 6a8ce344e1c98b11d469dc5d): it answers
  `{object: "", errors: {}, successCount: 0, success: false, failedCount: 0}`
  and the run continues. So a whole-list setter can run its write node
  unconditionally instead of guarding it behind an IF_ELSE. Note `success` is
  FALSE here, which is another reason a write node's own flag is never the
  answer - read the store back.
- `delete_records` MULTIPLE whose filter's `IN` list matches nothing is
  likewise a harmless no-op: `{count: 0}`, no error. Probed 2026-08-25 two
  ways - with the `['__none__']` sentinel (Set Project Members, add-only
  case) and with a genuinely EMPTY array (Set Project Teams). The empty `IN`
  matches nothing; it is NOT ignored, so the rows matching the OTHER filters
  in the same AND survive. Both are safe, and the sentinel stays the house
  pattern because it also keeps count filters honest.
- bulk_upsert_records_by_id under a mid-batch Mongo unique-key violation
  (probed 2026-08-24, planted identifier collision): the colliding record
  errors with the E11000 detail AND the platform then fails the REST of the
  batch ("Service EntityService remote call failure") - failedCount == all,
  successCount 0, nothing lands. Effectively all-or-nothing; per-record
  partial landings remain possible in principle, so keep the landed-ids
  rollback lane.
- Builder rendering resolves a node's panel by context appName+resourceName
  and the APPNAME IS NOT the resourceName for condition nodes: IF_ELSE nodes
  need `{appName: "if_else", resourceName: "if_else_condition"}`. A node with
  appName "if_else_condition" RUNS fine but the builder shows "no actions
  found" and an empty parameters panel (Saumya hit it on the Create Issue
  build 2026-08-24). Direct-built nodes must copy context from a healthy
  snapshot node of the same type, never guess it; lint now checks the
  appName<->resourceName pairing against the corpus.
- User 99293 exists as a platform user but is NOT in the axis-no-code app
  directory (probed 2026-08-24 via Fetch Users). App membership and platform
  existence are different sets - validating callers' userIds needs the
  applicationId EQUAL axis-no-code filter alongside id IN, and that filter
  combination works on standard_entities_fetch_entities.

## Sub-issues cross team AND project boundaries (probed 2026-08-25)

`axisNoCodeIssue.parentIssueId` is a self-FK and nothing constrains it to the
parent's container. Measured on orbit: of 232 live issues, 4 carry a parent,
and of those four **1 sits in a different team from its parent** and **2 sit in
a different project**. Zero dangling parent references.

Consequence for any tree walk: the obvious optimisation - scope the
parent/child search to the parent's `teamId` so the fetch is bounded by one
team instead of the workspace - **silently drops real children**. It looks
correct in review and in a single-team fixture, and loses data in production.

`Axis | Fetch SubIssues` therefore fetches the edge list workspace-wide
(`parentIssueId EXISTS`, cap 10000, `truncated` flag when the cap is hit) and
walks it in one code node, the same shape `Axis | Delete Issue` (`n_EDGE`)
uses. Its suite pins a cross-team child explicitly, so a future re-introduction
of team scoping fails the suite instead of losing rows.

The edge list is small in practice because sub-issues are rare (4 of 232 =
1.7%) and the filter selects only issues that HAVE a parent, not all issues.
The upgrade path when that stops holding is a frontier walk
(`parentIssueId IN [level]`, one fetch per tree level), which is bounded by
DEPTH rather than by workspace size.

## standard_entities User lookups: filter dialect and applicationId (2026-08-25)

Two things learned wiring assignee-name hydration into `Axis | Fetch Issues`:

- **`standard_entities_fetch_entities` takes the STORAGE-shaped filter**
  (`{operator, filters:[{property, filter:{operator,value}}]}`), not the
  platform `{op, values:[{field,op,values}]}` shape. Proven twice: the
  storage shape narrowed `id IN [103931,106753]` to exactly those two users,
  while the platform shape was silently IGNORED and returned the whole
  directory. A silently-ignored filter is worse than an error - it looks like
  a working node returning "all the data".
- **Do NOT add `applicationId EQUAL axis-no-code` when resolving DISPLAY
  NAMES.** With it the same query returned zero users. App membership and
  platform existence are different sets (already noted for Fetch Users): a
  user can be assigned to an issue without being an app member, and for name
  resolution we want whoever is assigned, not whoever is a member. The
  applicationId clause still belongs on membership VALIDATION, which is a
  different question.
- Rows come back under `columns` (`row.columns.name`), not `properties`, and
  the node's output array is `outputs.objects` - not `outputs.entities`.

**`/api/workflow/execute/node` is not a valid oracle for standard_entities.**
Probing it directly returned zero rows even with NO filter at all, which sent
this investigation down a wrong path twice. Test standard_entities nodes
inside a real workflow run (`testrun.mjs`), never through the node-execute
endpoint.

**UNRESOLVED (flagged during the 2026-08-25 merge, not yet probed).** The
section above and "`id IN [...]` on a standard-entities User fetch silently
returns nothing" below record CONTRADICTORY probes of the same node
(`standard_entities_fetch_entities`, storage-shaped filter):

- This session: `id IN [103931,106753]` ALONE narrowed to exactly those two
  users; adding `applicationId EQUAL axis-no-code` returned ZERO.
- The other session: `id IN ['106736']` ALONE returned `[]`; pairing it with
  `applicationId EQUAL` is what made the lookup work.

Both were observed, so one of the two is conditioned on something neither
probe isolated. The candidate difference is the id TYPE - numeric `103931`
vs quoted `'106736'` - and a secondary candidate is whether the users in
question are app members at all (a non-member assignee would vanish under an
applicationId clause but survive without it, which would make BOTH probes
correct for their own data). Until this is settled: copy the filter from a
sibling node that demonstrably resolves live, and verify the row COUNT of any
new user fetch in a `testrun.mjs` run - a silently-empty result looks
identical to a working node here.

- System fields ARE returned at row top level by BOTH
  storage_by_unifyapps_get_record_by_id and fetch_records (probed 2026-08-24
  on axisNoCodeSavedView KITAV2: rows carry `ownerUserId`, `createdTime`,
  `modifiedTime`, `version`, `lastModifiedBy` alongside `properties`). The
  older "fetch_records strips system fields" fact is about PROJECTING,
  SORTING and FILTERING on them - a projected system field comes back empty
  and a sortBy on one no-ops - the row itself always carries them. So code
  nodes may READ `row.ownerUserId` / `row.createdTime` freely; queries may
  not use them.
- System fields are NOT filterable through storage nodes OR the ad hoc
  /api/entity/{type} search (probed 2026-08-24: `version EQUAL 0`,
  `ownerUserId EQUAL 99293` and the string form all matched 0 rows on an
  entity where both values demonstrably exist). Any "my records" or
  version-pinned (CAS-by-caller-version) design needs a DECLARED property;
  a filter on a system field fails silently as zero matches, not an error.
- /api/entity-type/update REFUSES retyping an existing property when the
  entity has ANY records (error 5008 "Please delete data before updating
  entity schema, conflicting fields [...]") - even when no record carries
  that property (probed 2026-08-24, axisNoCodeSavedView.groupBy with a
  3-row census, none holding groupBy). Retype = add a NEW field and leave
  the old one dead.
- metadata.filterableFields is COMPUTED on entity-type update from
  property-level `filterable` flags; editing the metadata list directly is
  ignored, and a property without a flag defaults to filterable TRUE (a
  newly added plain field appeared in the list unasked). The lever is
  `filterable: false` on the property itself - probed 2026-08-24, worked.
- Stored object-typed properties do NOT preserve JSON key order (a written
  {combine, conditions} came back {conditions, combine}). Any suite check
  on an object field must deep-compare, never compare JSON strings.
- storage fetch_records OUTPUT names its count `total`, not `totalCount`
  (probed 2026-08-24 on the Restore Saved View build: {"total":0,
  "objects":[],"hasMore":false}); `includeTotalCount` is only the INPUT
  flag. A pill reading `outputs.totalCount` resolves empty SILENTLY - the
  symptom was every branch-join verdict failing. Also from the same build
  day (Update Saved View): passing a whole updateFields array as ONE pill
  from a Groovy node into update_records SINGLE runs correctly AND renders
  builder-clean (validate + lint).
- A node's TYPE must match its resource class or the run dies while the
  builder, validate AND lint (pre-R14) all stay green: a
  callables_call_automation node needs type CALL_WORKFLOW (with ACTION the
  exact run error is "No config found for resource
  callables_call_automation in app callables" - proven Create Saved View
  build 2026-08-24), just as respond nodes need STOP. Lint R14 now checks
  both pairings.
- A CallWorkflow node exposes the callee's respond fields DIRECTLY at
  outputs.<key> (n_EMIT.outputs.emitted, n_CALL.outputs.status) - there is
  no outputs.result wrapper on CALL_WORKFLOW nodes.
- The platform validator is NONDETERMINISTIC and has a Groovy token
  blacklist: the same workflow content validated clean, then dirty with
  "Blacklisted commands found in code: owner =" - the trigger was a plain
  Groovy variable named `owner` being assigned (renamed to ownerVal ->
  clean twice). Two consequences (probed 2026-08-24, Fetch Saved Views v2
  build): avoid `owner` (and suspect other loaded words) as assigned
  Groovy variable names, and treat a single clean validate as weaker
  evidence than assumed - validate twice on anything that matters.

## While loops + mutable variables (proven live 2026-08-25, Update Issues ancestor walk)

- `loop_while` (appName `loop`, type LOOP) + `variable_by_unifyapps_create_variables`
  / `variable_by_unifyapps_update_variables` work together as the mutable-state
  loop primitive: create the variables BEFORE the loop, mutate them inside with
  update_variables (`variables: [{source: "{{ node.outputs.x }}", value: ...}]`),
  and every pill read of `{{ node.outputs.x }}` — including the while condition —
  sees the LATEST value. Uacode reference: workflow/rt test
  `workflow_with_while_test.json`, configs/workflow-nodes/loop/loop_while.json.
- Edge vocabulary: while → first inner node uses edge type `loop`; last inner
  node → while node is `type next, name loopback`; while → after is `next`.
  Inner nodes' group = `<whileId>@<parentGroup>@l`.
- BUILDER TRAP: the while condition is a FilterConditionsField; a filter whose
  `value` is the EMPTY STRING fails builder validation ("Please select this
  required field"). Compare against a sentinel (`__done__`) instead, and make
  the loop body emit the sentinel to terminate.
- Numeric comparisons on string variables are untrustworthy (lexicographic
  risk) — keep counters/caps INSIDE a Groovy step and let the while condition
  be a plain string equality/inequality.
- TESTRUN ARTIFACT: the TEST_WORKFLOW_VARIABLE lookup records NOTHING for
  variable_by_unifyapps and loop_while nodes (testrun.mjs prints "not reached"
  for them even when they ran). Prove a walk/loop executed by its EFFECT
  (e.g. the cycle probe returning PARENT_CYCLE), not by node outputs.
- lint R7 now carries UACODE_VERIFIED_RESOURCES for resources proven in uacode
  but absent from the snapshot corpus (loop_while, create/update_variables).
## `id IN [...]` on a standard-entities User fetch silently returns nothing (re-confirmed 2026-08-25)

First probed 2026-08-23 while building Fetch Team Member Records; hit again
building Fetch Issue Details, which is why it is repeated here rather than
left in one spec.

```
filter: {operator: AND, filters: [{property: 'id',
         filter: {operator: 'IN', value: ['106736']}}]}   -> objects: []
```

The fetch does NOT error - it returns an empty list, so every joined row
comes back with a real id and blank identity fields. Nothing in the run looks
wrong; the UI just shows nameless avatars.

The working shape is the one Fetch Team Member Records and Fetch Teams
Directory use: fetch the app directory once
(`applicationId EQUAL 'axis-no-code'`, limit 1000) and join by id in Groovy.
Cost is one bounded fetch per call regardless of how many users are
referenced.
- axisNoCodeTeam's primaryKeyField is `matrixTeamId` (NOT id or a publicId):
  a team create without it fails "Primary key field is required" (probed
  2026-08-25 rebuilding fixtures). Projects use `publicId`, teams use
  `matrixTeamId` - check metadata.primaryKeyField per object before any
  create.
- Fixture team names are a SHARED namespace across sessions: a team called
  "kitreadteam" was claimed by another session's fixture family and its
  reset wiped the issues this kit had placed there (2026-08-25). Fixture
  families must own a distinctly-named team (ours: kitanchorteam), and
  link-style fixtures should be rebuilt from scratch rather than topped up,
  so a renamed team cannot leave a stale row behind and break an exact-count
  assertion.
- Read from ~/uacode 2026-08-25 (perf triage, notes/perf-triage-2026-08-25.md):
  loop_for_each has NO concurrency option - only repeatMode SINGLE|BATCH with
  batchSize (SourceListForEachLoopBuilder.java), so every loop is SEQUENTIAL
  and BATCH is the only lever (unused in our corpus). BRANCH arms DO get their
  own child ExecutionInstance with setConcurrentToken(true) and run
  sequentially only in debug mode (BranchNodeRuntime.java:356,178) - the
  parallel-arms guidance is confirmed, and the splitType probe can be closed.
  A CallWorkflow child runs in the IN_MEMORY runtime by default and everything
  nested below stays IN_MEMORY (CallWorkflowNodeRuntime.java:257-265,291-297);
  IN_MEMORY holds instances AND all variables in unbounded ConcurrentHashMaps
  with no TTL or eviction, so a deep call chain holds every level's variables
  in heap at once (docs/workflow/resource-guardrails.md). Platform limits
  today: 50k loop-iteration cap, execution timeout checked every 1000 steps,
  15MB/10MB truncation on the REPORTING copy only (the authoritative store has
  no size cap yet), and a ~20-permit semaphore per Kafka consumer - so a long
  sequential loop blocks other workflows, not just its own run.
- MEASUREMENT TRAP (found 2026-08-25, invalidated a triage headline):
  scripts/testrun.mjs sleeps 5000ms BEFORE its first poll and then polls the
  LAST node in the node array on a 5s tick. So (a) every run it reports costs
  >= 5s regardless of the automation, and (b) if that last node never fires on
  the taken branch it burns every attempt (~120s) on a run that finished in
  ~0.5s. NEVER quote testrun.mjs wall-clock as automation latency - poll a
  known terminal STOP node every ~250-400ms instead. The real Fetch Users
  latency is ~600ms, not the 10s first reported.
- Parallel BRANCH arms are NOT free: each arm mints an ExecutionInstance,
  persists it, starts it through the Kafka lifecycle publisher, then joins
  variables back and resumes the parent - measured ~185ms PER FORK, stable
  across two fan-outs (2026-08-25). They pay off only when each arm's work
  exceeds roughly 200ms. For cheap server-side counts (10-50ms) they are a
  PESSIMISATION: a BRANCH-per-iteration rebuild of Fetch Team Overview Stats
  was correct, validator- and lint-clean, and 2x SLOWER (median 2190ms ->
  4435ms on a 12-project team).
- BRANCH inside LOOP is fully supported (proven 2026-08-25 at every layer):
  BranchNodeRuntime propagates loop context into arm child tokens
  (`child.setLoopContext(...)`), ExecutionInstance reports parentLoopContext,
  and LoopNodeRuntime's withinLoopNodes matching (groupId contains
  "<loopId>@") correctly clears arm outputs between iterations. No example
  existed in our corpus; it now has an empirical one.
- The ad hoc `POST /api/entity/{type}` endpoint IGNORES includeTotalCount
  (`total` comes back undefined) - it cannot be used to read or measure a
  count. Use a storage fetch node.
- `includeTotalCount: true` costs effectively NOTHING on a storage fetch:
  A/B/A/B interleaved, 8 runs per block, medians 772/757/777/779ms - under 1%
  and inside noise (measured 2026-08-25 on small data: 243 issues, 61 members,
  37 projects; not proven at lakhs scale).
- standard_entities User fetches SILENTLY IGNORE unsupported projections:
  adding createdTime/state to a fetch_entities projection list produced no
  error and no columns - the fields simply vanished from the response. Absence
  of an error is not evidence a projection worked.
- Aggregation API (probed 2026-08-25): projection names must use the
  UNDERSCORE spelling (`properties_projectId`); the dot form returns rows with
  EMPTY columns - which is what defeated the 2026-08-23 probe. Even spelled
  correctly, GROUP/BUCKET/DISTINCT still return one object per record rather
  than buckets, so server-side grouping remains unavailable. A bulk endpoint
  `/api/aggregation/bulk` (N named queries in ONE call) exists in
  AggregationRestAPI but NO automation node exposes it - the highest-leverage
  platform ask for this family.
- Bulk user APIs exist and are unused by our corpus (configs/workflow-nodes/
  standard_entities/): `standard_entities_fetch_role_mappings` (bulk role
  lookup by principalId IN [...]) and `standard_entities_fetch_users_by_criteria`
  (returns id, username, name, state, createdTime, lastLoginAt, email, phone
  AND roleIds in ONE call). The latter could collapse Fetch Users' entire
  per-user loop to zero platform calls.

- **System fields FILTER via their storage ALIASES (2026-08-25, creator build).**
  `ownerUserId`/`createdTime`/`modifiedTime` etc. are stored under short
  aliases (AliasAndStandardEntityMapping: oUId, cTm, mTm, lMBy, d, v) - a
  filter on the LOGICAL name silently matches nothing (0 hits vs 232 truth),
  the ALIAS matches exactly (string or numeric values both coerce). Same
  root cause as the sort no-op. Filter property is the bare alias at TOP
  level (no properties_ prefix). Proven end-to-end in Fetch Issues: the
  `creator` filter field maps to `oUId` and returned total 232 == the live
  REST truth. Projection of system fields is still stripped - you can filter
  by creator but rows cannot carry it (display needs a product field).

## A MISSING property is not a blank one for `EQUAL ""` filters (proven 2026-08-25)

Storage fetches that group by an optional string (`properties_teamId EQUAL ""`)
match a record whose property is the EMPTY STRING and do NOT match a record
where the key is absent. Both read as "blank" in Groovy, so the difference is
invisible until a sibling lookup comes back short.

Seen on `Axis | Delete Status`: its "last status in this category" guard could
not see workspace-global project statuses written by `fixtures.mjs`, because
`bulk_upsert_records_by_id` DROPS a `""` value (even with `skipIfBlank: false`)
and never writes the key, while a status created through `Axis | Create Status`
carries `teamId: ""` explicitly. Result: deleting any global project status
answered `LAST_IN_CATEGORY` although two siblings existed. Recreating the
fixture through `/api/entity/create-update-or-delete/hierarchical` WITH
`teamId: ""` in properties fixed it and turned the Create Status suite green.

Two rules follow:
- Fixtures that stand in for product-created records must write the blank
  explicitly, through the hierarchical entity API - the bulk upsert cannot.
- Any automation that groups on an optional field should match MISSING as well
  as `""` (an `OR` of `EQUAL ""` and the missing check), the same way
  `archived` is already handled.

## The two standard_entities fetches take DIFFERENT filter shapes (verified 2026-08-25)

Both read platform entities, and the dialect is per ACTION, not per app:

- `standard_entities_fetch_entities` — input `filter`, STORAGE-style:
  `{operator: 'AND', filters: [{property: 'applicationId',
    filter: {operator: 'EQUAL', value: 'axis-no-code'}}]}`.
  Proven by the deployed `Axis | Fetch Users` (`n_BETBM` user fetch and
  `n_RDef` role-definition fetch) and by `Axis | Set Project Members`
  (`n_FtUsr`).
- `standard_entities_fetch_users_by_criteria` — input `criteria`, PLATFORM
  shape: `{op: 'AND', values: [{field: 'id', op: 'IN', values: [...]}]}`.
  Proven by `Axis | Fetch Projects` (`n_FT_LD`), whose lead join resolves
  live.

So "standard_entities actions use the platform shape" is too coarse a rule -
read the sibling that already works before writing a filter. Related trap,
already recorded above: on `fetch_entities`, an `id IN [...]` filter ALONE
silently returns `[]`; pairing it with `applicationId EQUAL` in the same AND
is what makes an id lookup work. (See the UNRESOLVED note above - a probe from
the same day recorded the opposite behaviour, so confirm against a working
sibling before relying on either rule.)

## A negative test's stand-in value can quietly become valid (2026-08-25)

Found merging two sessions' `Axis | Fetch Issues` suites. Three cases pinned
"an unknown filter field is rejected, not silently dropped" and expressed
"unknown" as the literal field `assignee` - the obvious throwaway at the time,
because the filter grammar had no such field. The v2.1 bridge lane then ADDED
`assignee` to `FIELDS`, so the payload became a perfectly valid filter, the
automation answered `SUCCESS` with an empty page, and all three cases failed.

Nothing was broken - the cases had rotted. But the failure reads exactly like
a regression in input validation, which is the expensive kind of red: it
invites "fixing" a correct automation. The same rot can be silent instead of
loud: had those cases asserted `SUCCESS`, a grammar that grew a field would
have made a negative test pass for the wrong reason forever.

Rules that follow:

- A negative case must name a value the grammar can never adopt. Use an
  obviously synthetic token (`notAField`) rather than a plausible domain word
  that a future lane might implement.
- The same applies to FIXTURES that encode invalid data - `kitrdview5` stored
  its "off-grammar" saved-view filter as `assignee` too, so the fixture and
  the case rotted together and the view case failed for the same reason.
- When a suite goes red right after someone else EXTENDS a contract, check
  whether the case's notion of "invalid" is what moved, before touching the
  automation.

## Fixture families are shared state ACROSS suites, not just within one (2026-08-25)

`Axis | Add Project to Team` and `Axis | Remove Project from Team` both run on
the kitpm* family and both act on the pair KITPM + kitpmteam3: Add links it,
Remove asserts it is NOT linked. Each suite is green in isolation and green
when Remove runs first. Add-then-Remove without a reset fails Remove's
not-linked case with `SUCCESS` / `removedCount 1`.

`regress.mjs --all` does not reset fixtures between suites, so suite ORDER is
part of the contract whenever two callables write the same family. Either give
each suite its own records, or reset the family between them
(`fixtures.mjs reset-projmem`). Recorded in both suites' notes.
