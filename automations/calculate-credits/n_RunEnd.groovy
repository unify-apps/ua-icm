// Close the run out, and decide whether the write actually landed.
//
// `bulk_upsert_records_by_id` answers `success: true` with `successCount: 0` when every
// row was malformed, and a bulk create can insert NOTHING and still leave its node
// `ok`. The COUNT is the only honest signal, so it is compared against what the fold
// meant to write and the run is stamped with the answer.
//
// The run row was created as `Running` BEFORE the credits, so a crash between the two
// leaves a run that plainly says it never finished — which is the state somebody can
// act on, rather than a `Succeeded` run with no credits under it.

long landed = successCount == null ? 0L : ((Number) successCount).longValue()
long meant  = expected == null ? 0L : ((Number) expected).longValue()
boolean ok  = landed == meant

return [
    ok     : ok,
    landed : landed,
    updates: [[id: String.valueOf(runRecordId), updateFields: [
        [fieldName: 'properties.status', actionType: 'SET', setValue: ok ? 'Succeeded' : 'Failed'],
    ]]],
    message: ok ? '' : "meant to write ${meant} credits, ${landed} landed".toString(),
]
