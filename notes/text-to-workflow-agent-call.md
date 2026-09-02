# How the text-to-workflow agent is called (learned 2026-08-22)

> **Inherited from `ua-automationkit` (the Axis kit), 2026-09-02.** The copilot
> protocol: SSE endpoint, case ids, reading a conversation after the stream
> ends. Entirely platform-level; applies unchanged here.

The copilot/agent inside the automation builder is reachable by plain API.
That means we can build the fully automatic loop later (send it a message,
read its streamed reply) without touching the browser.

## The call

- Endpoint: `POST {base_url}/api/workflow/execute/node/sse`
- Reply comes back as a stream (SSE), not one JSON blob.
- Needs the normal login cookie plus `content-type: application/json`.

## Body shape (trimmed to what matters)

```json
{
  "context": {
    "appName": "callables",
    "resourceName": "callables_call_automation_streaming"
  },
  "inputs": {
    "automationId": "67bdf597ba32d908560a680f",
    "synchronous": true,
    "debugParams": { "createCase": "67bdf597ba32d908560a680f" },
    "parameters": {
      "copilotType": "AI_AGENT",
      "caseId": "e_6a88c7dbf1f6b319e2e11e82",
      "message": "hi",
      "messageContentType": "MARKDOWN",
      "aiAgentId": "e_69e8f53f7b11356004965425",
      "runtimeContext": {
        "workflowId": "6a88add4094bcc55af8db57d",
        "host": "orbit.uat.unifyapps.com"
      },
      "timezoneId": "Asia/Calcutta"
    }
  }
}
```

## What each piece means (our current understanding, to verify)

- `message` - the text you would type to the agent.
- `caseId` - the chat/conversation id (an entity id, `e_...`). Shows up in the
  builder URL as `chatId`. New conversation likely means a new case.
- `runtimeContext.workflowId` - the automation being edited. Also in the
  builder URL: `/p/0/automations/{workflowId}/builder`.
- `automationId` (top level) - the agent's own automation that powers the
  copilot, not the one being edited.
- `aiAgentId` - which agent persona answers.
- The original browser call also sent a `lookupRequests` array. It only
  enriches the reply for display (resolves names for ids). Probably optional
  for us - verify.

## Example source

Seen in the builder at:
`https://orbit.uat.unifyapps.com/p/0/automations/6a88add4094bcc55af8db57d/builder?b_9U8If-chatId=e_6a88c7dbf1f6b319e2e11e82&nav=copilot`

## Proven on 2026-08-22 (first full end-to-end run)

- `caseId: "new"` starts a fresh chat. Works.
- `scripts/agent.mjs` sends the message and prints the agent's replies; raw
  stream events land in `.agent-logs/` (git-ignored).
- The stream shows the agent's inner tool use (Get Node Details, Get Workflow
  Summary, Update Workflow) and its final summary message.
- The agent's Update Workflow edit really lands: re-fetching the workflow
  right after showed 3 new nodes wired in correctly.
- `automationId` (copilot automation) is a platform constant, it matches the
  frontend constant STORYBOOK_RESUME_SSE_AUTOMATION_ID. `aiAgentId`
  `e_69e8f53f7b11356004965425` worked for our user on orbit too.

## Multi-turn conversations: SOLVED (2026-08-22, later the same day)

The trick, found in backend code (`SessionStarter.resolveCase`, uacode
workflow/rt): a BLANK caseId creates a new chat case; any non-blank value is
used as-is. Never send the literal "new" - the backend will happily store
messages under a case called "new" and no real case ever gets created.
`scripts/agent.mjs` now omits caseId for new chats and prints the real case id
(an `e_...` service_hub_case entity) from the stream. Continue a conversation
with `--case <id>`.

Proven working end to end on the KIT TEST clone:
1. Vague request -> agent asked a clarifying question.
2. Answer sent with `--case` -> agent remembered context, proposed the edit,
   and asked to CONFIRM before applying (it does this for edits).
3. "Yes, confirmed" -> agent ran Update Workflow, edit verified by re-fetch.

Other useful facts learned:
- Chat cases are `service_hub_case` entities; chat subject = first message.
- The copilot's action automation ids live in a `co_pilot_config` entity
  (properties_type AI_AGENT), fetched via `POST /api/lookup` with
  `{"type":"ByQuery","lookupType":"ENTITY","options":{"entity_type":"co_pilot_config"},...}`.
  create_case (send message, streaming): 67bdf597ba32d908560a680f;
  fetch_conversation: 66ab98083d73300e63962287;
  fetch_case_list: 66b259e2000d497ddf8550a9.
- Reading a conversation: call fetch_conversation via
  `POST /api/workflow/execute/node` (non-SSE) with the caseId. The reply's
  `additional.responseGenerationStatus` says "pending" vs "completed" - poll it
  to know when the agent finished, since the SSE stream can end mid-work.
- The agent's edits are NOT auto-deployed; they change the draft workflow only.

## The misplaced-save trap (2026-08-22, AUT-22 rebuild)

Two chats in a row claimed a successful rebuild ("Upsert Automation returned
success:true") while the target workflow stayed untouched (same version, same
modifiedTime). The build had actually been upserted into a NEW automation
whose id was the chat's case id minus the "e_" prefix, tagged "AI Generated".
Retrying in the same chat writes to the same wrong place - only a NEW chat
fixed it (the third chat saved into the real target correctly).

Checklist this adds: after any "applied" claim, re-fetch the target workflow;
if version/modifiedTime did not move, search for a stray new automation with
the same name (fetch the case-id-without-prefix directly) and start a fresh
chat. Delete the stray one (human OK first).

## Review lesson from the first real loop

The agent added email+phone validation on request but wired the email branch
INVERTED (valid email -> INVALID_INPUT) while the phone branch was correct.
A node/edge diff against the previous snapshot caught it immediately. Moral:
always re-fetch and diff after an agent edit; never trust the summary text.

## Update Workflow MERGES - it cannot remove a key (2026-08-22)

Found while building `Axis | Update Team Details`. The copilot's Update
Workflow tool merges the object it sends into the stored node rather than
replacing it. A key present in the old version but omitted from the new
payload survives. So:

- Adding a node, adding a key, or changing a value lands first time.
- Asking the agent to REMOVE a key is silently a no-op. It reports success,
  the workflow `version` increments (20 -> 27 across seven attempts here),
  and the node content does not change at all.

The version bump without a content change is the tell. Never take a removal
as done because the version moved.

Work around it by restating the change as an addition. We wanted `updated`
gone from two response nodes; instead we added it to the third, which made
all three response shapes consistent - the actual defect. A genuine removal
probably needs a full node replacement, or a hand edit in the builder UI.

## The agent's own success/failure reports are unreliable in BOTH directions

Three times in one session on this workflow:

1. Claimed a `fallbackMode` fix was applied. It was not - node still `STOP`.
2. Claimed an edit had entirely failed on a platform error
   (`service_hub_message ... required fromCustomerUserIdentityId`). The
   workflow write had in fact LANDED; only the chat message persistence
   failed. A new node and six rewritten nodes were already in place.
3. Claimed the `updated` key had been removed from all response nodes. It
   was still present in two of them.

That error string is not a reliable signal either way. Always re-fetch and
diff. The agent is much more trustworthy when it says it is UNSURE - it
correctly refused to guess whether `ISBLANK` treats a supplied `false` as
blank, and whether `get_record_by_id` errors or returns empty on a missing
id, rather than inventing an answer.

## Branch edges need a `name` or the builder hides half the graph (2026-08-22)

Hand-written definitions posted to `/api/workflow-definition/update/{id}` must
put a `name` on every edge leaving an IF_ELSE node:

- the `if` edge needs `"name": "yes"`
- the `next` (else) edge needs `"name": "no"`
- plain sequential edges carry no `name` at all

Omit them and the API still returns 200, `ua.mjs fetch` reads the full graph
back, and every node/edge diff passes - but the BUILDER CANVAS renders only
the trunk. Everything past a branch edge is invisible. Twice this looked like
"the automation only has 2 nodes" / "only 3 nodes" while the JSON said 6.

Same class of trap: the canvas lays out a TREE. Two edges converging into one
node is storable and readable but not renderable, so give each branch its own
tail nodes instead of a join. That is why the copilot always duplicates the
nodes after a branch rather than converging - it is matching the canvas, not
being wasteful.

Moral: a JSON diff is necessary but NOT sufficient after a direct write. If a
human says nodes are missing, believe them and compare your edges against a
copilot-built snapshot before blaming their browser cache.

Edges also carry an `id` of the form `<type>@<fromNodeId>@<toNodeId>` (e.g.
`next@n_GETtm@n_IF1nf`). The builder adds it on its next save. `ua-write.mjs`
now fills in both the edge `id` and the yes/no branch `name` automatically, so
this cannot be forgotten again.

The builder also stamps its own defaults onto storage update nodes when a
human saves - `writeThroughSessionVariables`, `skipPermissionCheck`,
`unsetIfNull` and `skipSchemaValidation: true`. Seeing those appear does not
mean someone changed the logic.
