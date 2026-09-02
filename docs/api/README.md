# Types for the UI

Two files, different sources of truth — keep them that way.

| file | what | how it changes |
|---|---|---|
| `icm-types.ts` | every `icm*` storage object: properties, enums, FKs, unique keys, primary keys | **GENERATED**. Re-run `node scripts/ua.mjs snap-types --tag icm && node scripts/gen-types.mjs` after the product team touches the model. Never hand-edit |
| `icm-callables.ts` | request/response contracts for the callables a page invokes | hand-written, mirrors `docs/automations/*.md`. Changes only with a deliberate spec edit |

Both should typecheck under `tsc --strict`.

`icm-types.ts` does not exist yet: it appears the first time entity snapshots
exist. The generator reads the entity prefix and the output path from
`kit.config.json`.

## Things the schemas do not say, and the generator writes down for you

- Every record carries `id`, `createdTime`, `modifiedTime`, `lastModifiedBy` on
  top of its properties. `createdTime` is what "createdAt" means in every
  contract.
- **A boolean that was never set is MISSING, not `false`.** `archived?: boolean`
  really is `boolean | undefined` — treat `undefined` as the default, never
  `!archived === false`.
- A field marked UNIQUE is a real Mongo index: a duplicate write fails at RUN
  time with E11000, not at save time.
- Junction objects (credits, hierarchy rows, approvals) have no unique key, so
  duplicate rows are possible. Read paths dedupe; do not assume the store does.

## Status handling

Every callable returns a `status` string. A transport 200 means the automation
ran, NOT that the work happened — always branch on `status`.

Statuses this product's UI must handle everywhere, not as edge cases:

- `PERIOD_LOCKED` — **not an error the user can retry.** The period is closed or
  paid. The correct UI response is to explain that and, where the user has the
  right, offer an adjustment in the next open period.
- `FORBIDDEN` — the caller may not see this person's money. Show the refusal;
  never fall back to showing partial data.
- `CALCULATION_IN_PROGRESS` — a run already holds the period. The UI waits and
  re-reads; it does not trigger a second run.
- `PARTIAL_FAILURE` — some rows changed, some did not. Walk the per-item results;
  only the per-item status says which.
