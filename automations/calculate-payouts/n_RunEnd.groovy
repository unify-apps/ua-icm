// Close the payout run, and supersede the period's previous payout runs only if this one
// fully landed.
//
// `bulk_upsert_records_by_id` answers `success:false, successCount:0` for an EMPTY batch
// (uacode StorageBulkUpsertAction) - a flat-only period has no measure results - so the
// counts, not the success flag, decide. A run that lands short is Failed and supersedes
// nothing, so readers keep the last good run.

def opt = { String n -> binding.hasVariable(n) ? binding.getVariable(n) : null }
def num = { v -> v instanceof Number ? ((Number) v).longValue() : 0L }
def rows(v) { return (v instanceof List) ? v : [] }

String run = String.valueOf(runRecordId)
long mrLand = num(opt('mrLanded')), mrMeant = num(opt('mrExpected'))
long erLand = num(opt('earnLanded')), erMeant = num(opt('earnExpected'))
boolean ok = mrLand == mrMeant && erLand == erMeant

List updates = [[id: run, updateFields: [
    [fieldName: 'properties.status', actionType: 'SET', setValue: ok ? 'Succeeded' : 'Failed'],
]]]
if (ok) {
    for (id in rows(opt('supersede'))) {
        String s = String.valueOf(id)
        if (s == '__none__' || s == run) continue
        updates << [id: s, updateFields: [
            [fieldName: 'properties.status', actionType: 'SET', setValue: 'Superseded'],
            [fieldName: 'properties.supersededBy', actionType: 'SET', setValue: run],
        ]]
    }
}

return [
    ok     : ok,
    landed : erLand,
    updates: updates,
    message: ok ? '' : "meant to write ${mrMeant} measure results and ${erMeant} earnings; ${mrLand} and ${erLand} landed".toString(),
]
