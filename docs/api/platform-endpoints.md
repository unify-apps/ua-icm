# Platform endpoints — the whole surface the kit drives

Every HTTP call this kit makes, in one place, as curl. Written 2026-09-02 by
reading `scripts/` and `notes/runtime-facts.md`, which inherited them from the
Axis kit. **Provenance is marked on every row** — `PROVEN` means a script in
this repo calls it and the Axis repo ran it against orbit; `PROBED` means
runtime-facts records a one-off probe; `UNPROVEN` means nobody has run it.

Nothing here has been run from THIS repo yet — `.env.local` does not exist.

## Auth: one cookie, every call

```bash
export UA=https://orbit.uat.unifyapps.com
export AT='<the _at cookie from Chrome dev tools, orbit tab>'

curl -s "$UA/api/entity-type/getLoggedInUser" -H "cookie: _at=$AT"     # whoami
```

Every call below carries `-H "cookie: _at=$AT"` and, when it has a body,
`-H 'content-type: application/json'`. 401/403 = the cookie went stale.
There is no API key and no refresh — the cookie is a browser session, so it
dies every few hours and gets re-pasted into `.env.local`.

`--env tool` in the scripts swaps to `UA_TOOL_URL`/`UA_TOOL_COOKIE`
(production). Production is read-only per CLAUDE.md.

---

## 1. Automations (workflow-definition)

The asset type the kit is best at. `POST` everywhere except the single fetch.

| verb | endpoint | provenance |
|---|---|---|
| read one | `GET /api/workflow-definition/{id}` | PROVEN (`ua.mjs fetch`) |
| list / search | `POST /api/workflow-definition/listPermissible` | PROVEN (`ua.mjs search`) |
| create | **clone only** — `POST /api/workflow-definition/clone/{id}` | PROBED, see note |
| update | `POST /api/workflow-definition/update/{id}` (FULL replace) | PROVEN (`ua-write.mjs`) |
| delete | `POST /api/workflow-definition/delete/{id}` | PROBED (CLAUDE.md L66) |
| validate | `POST /api/workflow-definition/validate?strict=true` | PROVEN (`ua.mjs validate`) |
| deploy | `POST /api/workflow-definition/{id}/deploy` | PROVEN (`deploy.mjs`) |
| read deployed copy | `GET /api/workflow-definition/deployed-workflow/{id}?latest=true` | PROVEN, but see warning |

### read one

```bash
curl -s "$UA/api/workflow-definition/$WF" -H "cookie: _at=$AT" | jq .
```

Returns the whole draft: `id, name, tags, version, nodes[], edges[],
deploymentState`. This object IS the unit of work — you fetch it, edit the
JSON, and post it back.

### list by tag (membership is by TAG, never by name)

```bash
curl -s "$UA/api/workflow-definition/listPermissible" \
  -H "cookie: _at=$AT" -H 'content-type: application/json' -d '{
    "filter": {"op":"AND","values":[{"field":"tags","op":"IN","values":["icm"]}]},
    "page": {"limit": 500},
    "includeTotalHits": true
  }' | jq '.totalHits, [.objects[] | {id,name,version}]'
```

Loose name search swaps the filter for
`{"field":"name","op":"ICONTAINS","values":["Payout"]}`. Response is
`{objects:[...], totalHits}` and each object is a FULL definition, so a list
call already gives you every node — that is how `drift` and `registry` work
without N fetches.

### create — there is no create endpoint worth using

The honest answer: **you clone a healthy automation and rewrite it.**

```bash
curl -s -X POST "$UA/api/workflow-definition/clone/$SOURCE_WF" \
  -H "cookie: _at=$AT" -H 'content-type: application/json' \
  -d '{"name":"ICM | Calculate Period (KIT TEST - safe to delete)","tags":["icmkit-test"]}'
```

Why (from `CLAUDE.md` "Build INCREMENTALLY"): the text-to-workflow copilot
refuses to edit a workflow that has no valid nodes, so an empty workflow made
via API is a dead end for agent editing. A clone is born valid.

**The clone request body is UNPROVEN here** — the Axis kit records the endpoint
but this repo has never called it. First real use: clone with no body, then
`update/{id}` to set name and tags, and record what actually worked.

Second path, no copilot involved: create a placeholder however you like and
seed it with a full definition via `update/{id}` (`ua-write.mjs`). The
"placeholder can't be edited" restriction is the COPILOT's, not the update
API's.

### update — full replace, no patch

```bash
curl -s -X POST "$UA/api/workflow-definition/update/$WF" \
  -H "cookie: _at=$AT" -H 'content-type: application/json' \
  --data-binary @definition.json
```

`definition.json` is a complete workflow object as returned by the fetch, with
`id` matching the URL. Because it replaces rather than patches, it is the only
way to REMOVE a key or a node — the copilot cannot. Use `ua-write.mjs update`
instead of raw curl: it fills in the edge `id`/`name` metadata the builder
canvas needs (omit it and the API round-trips fine while the canvas renders
everything past a branch as invisible).

### validate — the machine version of opening the builder

```bash
curl -s "$UA/api/workflow-definition/$WF" -H "cookie: _at=$AT" > wf.json
curl -s -X POST "$UA/api/workflow-definition/validate?strict=true" \
  -H "cookie: _at=$AT" -H 'content-type: application/json' \
  --data-binary @wf.json | jq .
```

Read-only despite the POST — it takes the definition in the body, not an id.
Returns `Violation[]` (empty = clean), each with `innerViolations`. Catches
dangling arms and incomplete nodes that pass a test run.

### deploy

```bash
curl -s -X POST "$UA/api/workflow-definition/$WF/deploy" \
  -H "cookie: _at=$AT" -H 'content-type: application/json' \
  -d '{"deploymentNotes":"what changed and who approved it"}'
```

Never call this by hand — `deploy.mjs` gates it on suite + validate + lint and
then verifies. **A 200 here is not proof.** The authority is
`deploymentState.status == "DEPLOYED"` AND
`deploymentState.workflowVersion == version` on a fresh fetch. And
`deployed-workflow/{id}?latest=true` has returned DRAFT content, so it is a
hint, not evidence.

---

## 2. Objects (entity types) — the data model

| verb | endpoint | provenance |
|---|---|---|
| list by tag | `POST /api/aggregation` (group STANDARD, entityType EntityType) | PROVEN (`ua.mjs types`) |
| read one | `GET /api/entity-type?entityType={id}` | PROVEN (`ua.mjs snap-types`) |
| create | `POST /api/entity-type` | PROBED only — no script, see gap |
| update | `POST /api/entity-type/update` (FULL definition) | PROVEN (`ua-schema.mjs`) |
| delete | — | UNKNOWN, never probed |

### list the ICM objects

```bash
curl -s "$UA/api/aggregation" -H "cookie: _at=$AT" -H 'content-type: application/json' -d '{
  "group":"STANDARD", "entityType":"EntityType",
  "projections":[{"name":"id","aggregationFunction":"GROUP"},
                 {"name":"name","aggregationFunction":"GROUP"},
                 {"name":"tags","aggregationFunction":"GROUP"}],
  "filter":{"op":"AND","values":[{"field":"tags","op":"IN","values":["icm"]}]},
  "page":{"limit":500}, "includeTotalHits":true
}' | jq '.objects[].columns'
```

**Projections are required** or the response comes back empty — no error.

### read one schema

```bash
curl -s "$UA/api/entity-type?entityType=$TYPE" -H "cookie: _at=$AT" | jq .
```

Fields live at `schema.schema.properties`. A foreign key is
`foreignKey.reference: "ENTITY_ID:<type>"` (or `"USER"`). `uniqueKeyFields` and
per-field `uniqueKey: true` are REAL Mongo unique indexes — a duplicate throws
a raw E11000 at RUN time and kills the run, so every create path needs a
pre-check and a `DUPLICATE_*` status.

### create an object type

```bash
curl -s -X POST "$UA/api/entity-type" -H "cookie: _at=$AT" \
  -H 'content-type: application/json' --data-binary @new-type.json
```

`ua-schema.mjs`'s header records this endpoint ("CREATE — errors with duplicate
key if it exists", probed 2026-08-23) but **no script here calls it and no
sample body exists in this repo.** This is the one gap that blocks
"drive everything via Claude" for objects. The way to close it cheaply: create
one throwaway object in the builder, snapshot it with `snap-types`, and POST
that JSON back with a new id — the snapshot IS the body shape.

### add fields to an existing object

```bash
# read, mutate schema.schema.properties, post the WHOLE thing back
curl -s -X POST "$UA/api/entity-type/update" -H "cookie: _at=$AT" \
  -H 'content-type: application/json' --data-binary @type.json
```

Use `ua-schema.mjs add-fields <type> <name:type>...` — it is idempotent and
never retypes. Two hard facts from runtime-facts:
- update **REFUSES to retype** a property once the entity has ANY records
  (error 5008). Retype = add a new field, leave the old one dead.
- `metadata.filterableFields` is COMPUTED from per-property `filterable` flags;
  editing the list directly is ignored, and a property with no flag defaults to
  filterable TRUE.

---

## 3. Records (the data itself)

Three ways in, and the FILTER DIALECT DIFFERS — the wrong one crashes at run
time, not save time.

| verb | endpoint | provenance |
|---|---|---|
| search | `POST /api/entity/{entityType}` — platform dialect | PROVEN (`regress.mjs`) |
| create / update / delete | `POST /api/entity/create-update-or-delete/hierarchical` | PROVEN (`regress.mjs`) |

### search records ad hoc

```bash
curl -s "$UA/api/entity/$TYPE" -H "cookie: _at=$AT" -H 'content-type: application/json' -d '{
  "filter":{"op":"AND","values":[
     {"field":"properties.periodId","op":"EQUAL","values":["e_abc123"]}]},
  "page":{"limit":50,"offset":0}
}' | jq '.response.objects // .objects'
```

Note the `properties.` prefix and the PLATFORM shape (`op`/`field`/`values`).
Inside automations, storage nodes take the OTHER shape
(`{operator, filters:[{property:"properties.x", filter:{operator, value}}]}`).

Two traps: this endpoint **IGNORES `includeTotalCount`** (`total` is
undefined — it cannot measure a count; use a storage fetch node for that), and
system fields are not filterable through it (a filter on `ownerUserId` silently
matches zero, it does not error).

### create a record

```bash
curl -s -X POST "$UA/api/entity/create-update-or-delete/hierarchical" \
  -H "cookie: _at=$AT" -H 'content-type: application/json' -d '{
    "entity": {"entityType":"'"$TYPE"'",
               "properties":{"name":"KIT TEST participant","teamId":""}},
    "requestType": "CREATED"
  }'
```

Returns the created record including `id`. An optional `ownerUserId` sits on
the ENTITY (not inside `properties`) and is the only way to seed a record owned
by somebody else — needed to test author-only permission paths.

This is also the ONLY writer that can store an explicit `""`; the workflow
`bulk_upsert_records_by_id` DROPS blank values even with `skipIfBlank:false`,
and a missing key does not match an `EQUAL ""` filter. Fixtures standing in for
product-created records must go through here.

### update / delete a record

```bash
# update: same call, requestType UPDATED, entity carries id + changed properties
# delete: hard delete
curl -s -X POST "$UA/api/entity/create-update-or-delete/hierarchical" \
  -H "cookie: _at=$AT" -H 'content-type: application/json' \
  -d '{"entity":{"entityType":"'"$TYPE"'","id":"'"$REC"'"},"requestType":"DELETED"}'
```

`CREATED` and `DELETED` are proven in `regress.mjs`. **`UPDATED` is the
inferred third value and has not been run from this repo** — verify it on a
loudly-named fixture before trusting it.

**ICM safety rule: never point any of these at real pay data.**

---

## 4. Running and debugging

| what | endpoint | provenance |
|---|---|---|
| test-run a DRAFT | `POST /api/test-workflow/initiate-test/{id}` | PROVEN (`testrun.mjs`) |
| read a run's node data | `POST /api/lookup` | PROVEN (`testrun.mjs`, `debugrun.mjs`) |

```bash
# body: {"type":"MOCK","workflowDefinition":<the full definition>,"payload":{...}}
# -> {"runId": "..."}
curl -s -X POST "$UA/api/test-workflow/initiate-test/$WF" \
  -H "cookie: _at=$AT" -H 'content-type: application/json' \
  -d "{\"type\":\"MOCK\",\"workflowDefinition\":$(cat wf.json),\"payload\":{}}"
```

It sends the definition in the body, which is why it runs a DRAFT with no
deploy. **It executes real nodes against real data** — same care as a real run.

```bash
# per-node inputs/outputs; key is "<runId>.<runId>.<nodeId>"
curl -s "$UA/api/lookup" -H "cookie: _at=$AT" -H 'content-type: application/json' -d '{
  "type":"ByKeys", "lookupType":"TEST_WORKFLOW_VARIABLE",
  "keys":["'"$RUN.$RUN.$NODE"'"],
  "options":{"workflowId":"'"$WF"'","startTime":0,"endTime":9999999999999}
}' | jq '.response.objects'
```

`lookupType` is `TEST_WORKFLOW_VARIABLE` for test runs and `WORKFLOW_VARIABLE`
for real ones — `debugrun.mjs` probes one then the other. Entries are typed
`inputs` / `outputs`; a failure shows as `errorMessage` / `rootCauseMessage` on
the outputs payload.

Completion detection: an automation ends at ANY of its STOP nodes, so poll
every STOP node, not the last node in the definition.

---

## 5. The text-to-workflow copilot

One endpoint, SSE, and it CAUSES EDITS on whatever workflow you name.

```
POST /api/workflow/execute/node/sse        accept: text/event-stream
```

Body shape is in `scripts/agent.mjs` — it invokes a fixed platform automation
(`67bdf597ba32d908560a680f`) with `aiAgentId e_69e8f53f7b11356004965425` and
`parameters.runtimeContext = {workflowId, host}`. Omit `caseId` entirely for a
new chat (a blank one creates a case; never send the literal `"new"`), then
reuse the printed `e_...` case id for follow-ups.

Use `agent.mjs send`, never raw curl. And after every "applied" claim, re-fetch
the target and check `version`/`modifiedTime` moved — the copilot has claimed
success on saves that never happened, and failure on saves that landed.

---

## 6. Application pages — no API exists yet

**This is open question 10 and it is unanswered.** Nothing in `scripts/`, the
Axis kit, or runtime-facts reads or writes a page from outside the builder.
Until somebody finds the endpoint, pages are built by hand in the builder and
their contracts live in `docs/pages/`.

Worth probing, in this order: watch the browser's network tab while saving a
page in the builder, and look for an `application`/`page`/`ui-definition`
family alongside `/api/workflow-definition`. Whatever it is, it will take the
same `_at` cookie.

---

## 7. Aggregation — mostly a trap

`POST /api/aggregation` works for LISTING entity types (section 2). For
grouping RECORDS it does not deliver: probed 2026-08-25, projection names must
use the underscore spelling (`properties_projectId` — the dot form returns rows
with empty columns), and even spelled correctly GROUP/BUCKET/DISTINCT return
one object per record rather than buckets. The reporting path
(`group: "ENTITY_REPORTING"`, separator `=::=`) is shape-valid but hits an
analytics warehouse that was dead on orbit.

Consequence for ICM: **there is no server-side GROUP BY.** A quarter's
calculation cannot lean on aggregation; plan for projected bulk fetches
(limit 10000, `fields:[...]`) counted in one code step, with an explicit
truncation flag. `/api/aggregation/bulk` exists in the backend but no
automation node exposes it — the highest-leverage platform ask for this repo.

---

## What to do first

1. Create `.env.local` and run `node scripts/ua.mjs whoami`. Nothing else can
   be verified until this passes.
2. Settle open questions 6 and 7 — the real `applicationId` and tags. A wrong
   app id does not error, it silently matches nothing.
3. Close the two gaps above on a throwaway asset: the object-type CREATE body,
   and the automation CLONE body. Both are one probe each, and both are
   currently blocking "everything driven from Claude".
