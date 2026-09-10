// Turn the computed credits into rows `bulk_upsert_records_by_id` will actually store.
//
// Two things happen here and nowhere else:
//
//  1. The CalculationRun's RECORD ID is stamped onto every credit. It cannot be known
//     before n_CrRun runs, and Credit.runId is a foreign key to the record, not to the
//     business key.
//  2. The rows are reshaped into `{id, updateFields:[{fieldName, actionType, setValue}]}`.
//     A row with the fields FLAT answers `{success: true, successCount: 0}` and writes
//     NOTHING — success true with a zero count is the signature of a malformed row, so
//     the shape is not a detail (notes/runtime-facts.md, 2026-08-25).
//
// The credit ids were minted in n_Calc, which is what lets a rollup credit carry its
// parent's id in `sourceCreditId` inside the SAME batch.

def rows(v) { return (v instanceof List) ? v : [] }

String runRecordId = runId == null ? '' : String.valueOf(runId).trim()
List out = []

for (Map c : rows(credits)) {
    List fields = []
    def set = { String name, Object v -> if (v != null) fields << [fieldName: 'properties.' + name, actionType: 'SET', setValue: v] }

    set('creditId', c.creditId)
    set('runId', runRecordId.isEmpty() ? null : runRecordId)
    set('transactionId', c.transactionId)
    set('employeeId', c.employeeId)
    set('positionId', c.positionId)
    set('creditRuleId', c.creditRuleId)
    set('creditTypeId', c.creditTypeId)
    set('amount', c.amount)
    // Credit has no `isRollup` column. A rolled credit is the one carrying a parent,
    // and `sourceCreditId` is that parent — which is why the ids are minted upstream.
    set('sourceCreditId', c.sourceCreditId)
    set('triggerFired', Boolean.TRUE)

    // `creditId`, not `id`: n_Calc's response projection RENAMES the minted id on its way
    // out, and reading the old name here sent every row with an empty id. The server then
    // minted its own, `properties.creditId` was never set on any of them, and the second
    // row collided with the first on that unique index - which fails the rest of the batch
    // with it. One row landed, five did not, and nothing about the shape looked wrong.
    out << [id: c.creditId, updateFields: fields]
}

return [updates: out, expected: out.size()]
