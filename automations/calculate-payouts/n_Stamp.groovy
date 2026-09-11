// Turn the computed measure results and earnings into rows bulk_upsert_records_by_id stores.
//
// The CalculationRun RECORD id is stamped here because it does not exist until n_CrRun ran,
// and rows go out as {id, updateFields:[...]} - a flat row answers success with a zero count
// and writes nothing. Ids were minted in the fold, so an Earning already carries the id of
// the MeasureResult it came from.

def rows(v) { return (v instanceof List) ? v : [] }
def blank = { v -> v == null || String.valueOf(v).trim().isEmpty() }

String run = runId == null ? '' : String.valueOf(runId).trim()
String period = periodId == null ? '' : String.valueOf(periodId).trim()

def fieldsOf = { Map values ->
    List fields = []
    values.each { k, v -> if (!blank(v)) fields << [fieldName: 'properties.' + k, actionType: 'SET', setValue: v] }
    return fields
}

List mr = []
for (Map m : rows(measureResults)) {
    mr << [id: m.resultId, updateFields: fieldsOf([
        resultId: m.resultId, runId: run, employeeId: m.employeeId, positionId: m.positionId,
        measureId: m.measureId, periodId: period, creditTotal: m.creditTotal, quota: m.quota,
        attainmentPct: m.attainmentPct,
    ])]
}

List er = []
for (Map e : rows(earnings)) {
    er << [id: e.earningId, updateFields: fieldsOf([
        earningId: e.earningId, runId: run, employeeId: e.employeeId, componentKey: e.componentKey,
        periodId: period, creditId: e.creditId, resultId: e.resultId,
        earnedToDate: e.earnedToDate, previouslyPaid: e.previouslyPaid, amount: e.amount,
        rateApplied: e.rateApplied, bandHit: e.bandHit, holdStatus: e.holdStatus ?: 'Payable',
        payablePeriodId: period, trace: e.trace,
    ])]
}

return [mrUpdates: mr, earnUpdates: er, mrExpected: mr.size(), earnExpected: er.size()]
