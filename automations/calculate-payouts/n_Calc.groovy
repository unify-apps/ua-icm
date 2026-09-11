// --- wiring: platform rows in, PayoutPass out ------------------------------------
//
// Everything above this line is PURE. Below is the adapter: it indexes what the fetch
// nodes returned into the maps PayoutPass expects, and shapes what it returns into
// something that survives the response boundary (Longs and Strings, no BigDecimal).

def rows(v) { return (v instanceof List) ? v : [] }
def p(row, String k) { return ((Map) row?.properties)?.get(k) }
def truthy(v) { return v instanceof Boolean ? v : String.valueOf(v) == 'true' }

// The tiered reads sit behind a branch lane that stays closed when no tiered rule applies.
// A pill to a node that never ran leaves the binding MISSING, so every fetch input is read
// through here.
def opt = { String n -> binding.hasVariable(n) ? binding.getVariable(n) : null }
def R = { String n -> rows(opt(n + 'Rows')) }

def group(List src, String byField, Closure shape) {
    Map out = [:]
    for (r in src) {
        def k = p(r, byField)
        if (k == null) continue
        out.computeIfAbsent(String.valueOf(k), { [] }) << shape(r)
    }
    return out
}

// --- a page that did not hold everything is a WRONG answer, not a slow one --------
List truncated = []
def bound = { String label, String param -> if (truthy(opt(param + 'More'))) truncated << label }
bound('Credit', 'credit'); bound('Transaction', 'txn'); bound('CreditType', 'ct')
bound('PositionAttribute', 'attr'); bound('Position', 'pos'); bound('Title', 'title')
bound('PlanAssignment', 'asg'); bound('Plan', 'plan'); bound('Rule', 'rule')
bound('AttainmentMeasure', 'measure'); bound('RateTable', 'rt'); bound('RateTableBand', 'band')
bound('Quota', 'quota'); bound('Period (cover)', 'cover')

String creditRunKeyOut = opt('creditRunKey') == null ? '' : String.valueOf(opt('creditRunKey'))
def refuseRun = { String status, String message ->
    return [status: status, message: message, runId: runId, dryRun: truthy(dryRun), periodName: periodName,
            creditRunId: creditRunKeyOut, written: 0, earnings: [], measureResults: [], exceptions: [],
            stats: [:], expectedEarnings: 0, expectedResults: 0]
}
if (!truncated.isEmpty()) {
    return refuseRun('FETCH_TRUNCATED',
        ("these objects returned more rows than one page held, so any answer would be computed on a prefix: "
         + truncated.join(', ') + ". Raise pageLimit.").toString())
}
if (truthy(opt('creditOverflow'))) {
    return refuseRun('KEY_SET_TOO_LARGE',
        "this credit run touches more distinct transactions or seats than keyCap allows; calculate it in chunks".toString())
}

// --- reference codes -------------------------------------------------------------
Map creditTypeCodeById = [:]
for (t in R('ct')) { def c = p(t, 'creditTypeCode'); if (c != null) creditTypeCodeById[t.id] = String.valueOf(c) }
Map titleCodeById = [:]
for (t in R('title')) titleCodeById[t.id] = p(t, 'titleCode')
Map positionCodeById = [:]
for (t in R('pos')) positionCodeById[t.id] = p(t, 'positionCode')
Map txnById = [:]
for (t in R('txn')) txnById[t.id] = t

// --- plans and payout rules --------------------------------------------------------
Map plansById = [:]
for (pl in R('plan')) {
    Map v = [planId: p(pl, 'planId'), status: p(pl, 'status'), startDate: p(pl, 'startDate'),
             endDate: p(pl, 'endDate'), payoutRules: p(pl, 'payoutRules') ?: []]
    plansById[pl.id] = v
    if (v.planId != null) plansById[String.valueOf(v.planId)] = v
}
Map rulesByRuleId = [:]
for (r in R('rule')) {
    def rk = p(r, 'ruleId')
    if (rk == null || p(r, 'stage') != 'payout') continue
    rulesByRuleId[String.valueOf(rk)] = [recordId: r.id, ruleId: rk, conditions: p(r, 'conditions'),
                                         result: p(r, 'result'), activeStart: p(r, 'activeStart'), activeEnd: p(r, 'activeEnd')]
}
List assignments = R('asg').collect {
    [planKey: p(it, 'planId'), targetType: p(it, 'targetType'), targetId: p(it, 'targetId'),
     titleId: p(it, 'titleId'), positionId: p(it, 'positionId'), startDate: p(it, 'startDate'), endDate: p(it, 'endDate')]
}

// --- tiered config -------------------------------------------------------------------
Map measuresByKey = [:]
for (m in R('measure')) {
    def k = p(m, 'measureId'); if (k == null) continue
    measuresByKey[String.valueOf(k)] = [recordId: m.id, measureId: String.valueOf(k), creditTypes: p(m, 'creditTypes'),
                                        periodType: p(m, 'periodType')]
}
Map bandsByTable = group(R('band'), 'rateTableId', {
    [bandId: p(it, 'bandId'), fromPct: p(it, 'fromPct'), toPct: p(it, 'toPct'), value: p(it, 'value'), label: p(it, 'label')]
})
Map rateTablesByKey = [:]
for (t in R('rt')) {
    def k = p(t, 'rateTableId'); if (k == null) continue
    List bands = new ArrayList((List) (bandsByTable[t.id] ?: []))
    bands.sort { a, b ->
        BigDecimal x = CreditPass.dec(a.fromPct), y = CreditPass.dec(b.fromPct)
        if (x == null) return 1
        if (y == null) return -1
        return x <=> y
    }
    rateTablesByKey[String.valueOf(k)] = [recordId: t.id, rateTableId: String.valueOf(k), bands: bands,
                                          effectiveStart: p(t, 'effectiveStart'), effectiveEnd: p(t, 'effectiveEnd')]
}
List quotas = R('quota').collect {
    [recordId: it.id, quotaId: p(it, 'quotaId'), positionId: p(it, 'positionId'), measureId: p(it, 'measureId'),
     periodId: p(it, 'periodId'), amount: p(it, 'amount'), effectiveStart: p(it, 'effectiveStart'), effectiveEnd: p(it, 'effectiveEnd')]
}
// This period first, then the periods that contain it, narrowest first: a quota on the month
// beats one on the quarter, which beats one on the year.
String thisPeriod = String.valueOf(periodId)
List coverRows = R('cover').findAll { String.valueOf(it.id) != thisPeriod }
coverRows.sort { a, b ->
    long sa = ((Number) (p(a, 'endDate') ?: 0)).longValue() - ((Number) (p(a, 'startDate') ?: 0)).longValue()
    long sb = ((Number) (p(b, 'endDate') ?: 0)).longValue() - ((Number) (p(b, 'startDate') ?: 0)).longValue()
    return sa <=> sb
}
List coverPeriodIds = [thisPeriod] + coverRows.collect { String.valueOf(it.id) }

// --- the credits -------------------------------------------------------------------
List credits = []
for (cr in R('credit')) {
    def txn = txnById[p(cr, 'transactionId')]
    Map attrs = (p(txn, 'attrs') instanceof Map) ? (Map) p(txn, 'attrs') : [:]
    def when = p(txn, 'incentiveDate') ?: p(txn, 'closeDate')
    credits << [
        recordId      : cr.id,
        creditId      : p(cr, 'creditId') ?: cr.id,
        employeeId    : p(cr, 'employeeId'),
        positionId    : p(cr, 'positionId'),
        transactionId : p(cr, 'transactionId'),
        creditTypeCode: creditTypeCodeById[p(cr, 'creditTypeId')],
        amount        : CreditPass.dec(p(cr, 'amount')),
        isRollup      : p(cr, 'sourceCreditId') != null,
        asOf          : when instanceof Number ? ((Number) when).longValue() : null,
        closeDate     : p(txn, 'closeDate'),
        product       : p(txn, 'product'),
        customer      : p(txn, 'customer'),
        orderNumber   : attrs.orderNumber ?: p(txn, 'sourceId'),
    ]
}

Map ctx = [
    seed: ((Number) startedAt).longValue(), periodId: thisPeriod, periodName: periodName,
    periodEnd: ((Number) windowEnd).longValue(),
    attrByPosition: group(R('attr'), 'positionId', { [titleId: p(it, 'titleId'),
                                                     effectiveStart: p(it, 'effectiveStart'), effectiveEnd: p(it, 'effectiveEnd')] }),
    titleCodeById: titleCodeById, positionCodeById: positionCodeById, creditTypeCodeById: creditTypeCodeById,
    plansById: plansById, rulesByRuleId: rulesByRuleId, assignments: assignments,
    measuresByKey: measuresByKey, rateTablesByKey: rateTablesByKey, quotas: quotas, coverPeriodIds: coverPeriodIds,
]

Map out = PayoutPass.run(credits, ctx)

// SORTED so two runs of the same period diff cleanly and suite indexes mean something.
List earnings = new ArrayList((List) out.earnings)
earnings.sort { a, b ->
    int c = String.valueOf(a.componentKey) <=> String.valueOf(b.componentKey); if (c != 0) return c
    c = String.valueOf(a.employeeId) <=> String.valueOf(b.employeeId); if (c != 0) return c
    return String.valueOf(a.creditId) <=> String.valueOf(b.creditId)
}
List measureResults = new ArrayList((List) out.measureResults)
measureResults.sort { a, b ->
    int c = String.valueOf(a.componentKey) <=> String.valueOf(b.componentKey); if (c != 0) return c
    return String.valueOf(a.employeeId) <=> String.valueOf(b.employeeId)
}
List exceptions = new ArrayList((List) out.exceptions)
exceptions.sort { a, b ->
    int c = String.valueOf(a.code) <=> String.valueOf(b.code); if (c != 0) return c
    c = String.valueOf(a.ruleId) <=> String.valueOf(b.ruleId); if (c != 0) return c
    c = String.valueOf(a.employeeId) <=> String.valueOf(b.employeeId); if (c != 0) return c
    return String.valueOf(a.creditId) <=> String.valueOf(b.creditId)
}

Map stats = new LinkedHashMap((Map) out.stats)
stats.put('rowsRead', [credits: R('credit').size(), transactions: R('txn').size(), attributes: R('attr').size(),
                       positions: R('pos').size(), planAssignments: assignments.size(), plans: R('plan').size(),
                       rules: R('rule').size(), measures: R('measure').size(), rateTables: R('rt').size(),
                       tiers: R('band').size(), quotas: quotas.size()])

return [status: 'OK', message: '', runId: runId, dryRun: truthy(dryRun), periodName: periodName,
        creditRunId: creditRunKeyOut, written: 0, earnings: earnings, measureResults: measureResults,
        exceptions: exceptions, stats: stats, expectedEarnings: earnings.size(), expectedResults: measureResults.size()]
