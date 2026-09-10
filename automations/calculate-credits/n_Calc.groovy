// --- wiring: platform rows in, CreditPass out -------------------------------
//
// Everything above this line is PURE. Everything below it is the adapter: it turns
// what the fetch nodes returned into the indexed maps CreditPass expects, and turns
// what CreditPass returned into something that survives the response boundary.

def rows(v) { return (v instanceof List) ? v : [] }
def p(row, String k) { return ((Map) row?.properties)?.get(k) }
def truthy(v) { return v instanceof Boolean ? v : String.valueOf(v) == 'true' }

def group(List src, String byField, Closure shape) {
    Map out = [:]
    for (r in src) {
        def k = p(r, byField)
        if (k == null) continue
        out.computeIfAbsent(String.valueOf(k), { [] }) << shape(r)
    }
    return out
}

// --- a fetch that hit its page limit is a WRONG ANSWER, not a slow one -------
// `hasMore` is the platform's own signal that the page did not hold everything. A
// bulk fetch that silently caps is the failure mode notes/runtime-facts.md names
// first, and the only defence that scales is to refuse rather than to compute on a
// prefix. Pagination is the fix; this is what makes its absence loud meanwhile.
List truncated = []
def bound = { String label, v -> if (truthy(v)) truncated << label }
bound('Transaction', txnMore); bound('PositionAttribute', attrMore)
bound('PayeePositionAssignment', occMore); bound('PositionHierarchy', hierMore)
bound('PlanAssignment', asgMore); bound('Plan', planMore); bound('Rule', ruleMore)
bound('Payee', payeeMore); bound('Title', titleMore); bound('Territory', terrMore)
bound('Currency', ccyMore); bound('Position', posMore); bound('CreditType', ctMore)

if (!truncated.isEmpty()) {
    return [status: 'FETCH_TRUNCATED',
            message: ("these objects returned more rows than one page held, so any answer would be "
                      + "computed on a prefix: " + truncated.join(', ')
                      + ". Raise pageLimit or narrow the period.").toString(),
            runId: runId, dryRun: truthy(dryRun), periodName: periodName,
            windowStart: 0, windowEnd: 0, credits: [], exceptions: [], stats: [:], expected: 0]
}

// --- reference codes ---------------------------------------------------------
Map currencyCodeById = [:]
for (c in rows(ccyRows)) currencyCodeById[c.id] = p(c, 'code')

Map titleCodeById = [:]
for (t in rows(titleRows)) titleCodeById[t.id] = p(t, 'titleCode')

Map territoryCodeById = [:]
for (t in rows(terrRows)) territoryCodeById[t.id] = p(t, 'territoryCode')

Map positionCodeById = [:]
for (t in rows(posRows)) positionCodeById[t.id] = p(t, 'positionCode')

// creditType is authored as a CODE and stored as a record id. Resolving one to the
// other here is what keeps a rule readable and the column a real foreign key.
Map creditTypeIdByCode = [:]
for (t in rows(ctRows)) { def c = p(t, 'creditTypeCode'); if (c != null) creditTypeIdByCode[String.valueOf(c)] = t.id }

// --- people ------------------------------------------------------------------
Map payeeById = [:]
Map payeeIdsByName = [:]
for (pay in rows(payeeRows)) {
    payeeById[pay.id] = [currencyCode: currencyCodeById[p(pay, 'currencyId')],
                         hireDate: p(pay, 'hireDate'), name: p(pay, 'name'), status: p(pay, 'status')]
    String k = CreditPass.key((String) p(pay, 'name'))
    if (k != null) payeeIdsByName.computeIfAbsent(k, { [] }) << pay.id
}

// --- plans and rules ---------------------------------------------------------
// A plan is reachable by its RECORD id (what PlanAssignment.planId holds) and by its
// business key (what a human reads). Indexing both costs nothing and removes a class
// of "matches nothing, says nothing" bug.
Map plansById = [:]
for (pl in rows(planRows)) {
    Map v = [planId: p(pl, 'planId'), status: p(pl, 'status'),
             startDate: p(pl, 'startDate'), endDate: p(pl, 'endDate'),
             creditRules: p(pl, 'creditRules') ?: []]
    plansById[pl.id] = v
    if (v.planId != null) plansById[String.valueOf(v.planId)] = v
}

Map rulesByRuleId = [:]
for (r in rows(ruleRows)) {
    def rk = p(r, 'ruleId')
    if (rk == null) continue                      // a half-written Rule row indexes as nothing
    if (p(r, 'stage') != 'credit') continue       // the payout pass reads the others
    rulesByRuleId[String.valueOf(rk)] = [recordId: r.id, ruleId: rk, conditions: p(r, 'conditions'),
                                         result: p(r, 'result'), activeStart: p(r, 'activeStart'),
                                         activeEnd: p(r, 'activeEnd')]
}

List assignments = rows(asgRows).collect {
    [planKey: p(it, 'planId'), targetType: p(it, 'targetType'), targetId: p(it, 'targetId'),
     titleId: p(it, 'titleId'), positionId: p(it, 'positionId'),
     startDate: p(it, 'startDate'), endDate: p(it, 'endDate')]
}

Map ctx = [
    seed              : ((Number) startedAt).longValue(),
    payeeIdsByName    : payeeIdsByName,
    payeeById         : payeeById,
    seatsByPayee      : group(rows(occRows), 'payeeId', { [positionId: p(it, 'positionId'),
                                                          effectiveStart: p(it, 'effectiveStart'), effectiveEnd: p(it, 'effectiveEnd')] }),
    occupantByPosition: group(rows(occRows), 'positionId', { [payeeId: p(it, 'payeeId'),
                                                          effectiveStart: p(it, 'effectiveStart'), effectiveEnd: p(it, 'effectiveEnd')] }),
    attrByPosition    : group(rows(attrRows), 'positionId', { [titleId: p(it, 'titleId'), territoryId: p(it, 'territoryId'),
                                                          effectiveStart: p(it, 'effectiveStart'), effectiveEnd: p(it, 'effectiveEnd')] }),
    parentByPosition  : group(rows(hierRows), 'positionId', { [parentPositionId: p(it, 'parentPositionId'),
                                                          effectiveStart: p(it, 'effectiveStart'), effectiveEnd: p(it, 'effectiveEnd')] }),
    titleCodeById     : titleCodeById,
    territoryCodeById : territoryCodeById,
    positionCodeById  : positionCodeById,
    creditTypeIdByCode: creditTypeIdByCode,
    plansById         : plansById,
    rulesByRuleId     : rulesByRuleId,
    assignments       : assignments,
]

// --- the deals in scope ------------------------------------------------------
// The fetch already filtered on the window server-side; this re-check is what makes
// a transaction with NO incentiveDate visible as a refusal instead of invisible.
long winStart = ((Number) windowStart).longValue()
long winEnd   = ((Number) windowEnd).longValue()

List txns = []
List outOfWindow = []
for (t in rows(txnRows)) {
    Map attrs = (p(t, 'attrs') instanceof Map) ? (Map) p(t, 'attrs') : [:]
    def inc = p(t, 'incentiveDate') ?: p(t, 'closeDate')
    Map row = [
        recordId      : t.id,
        transactionId : p(t, 'transactionId'),
        orderNumber   : attrs.orderNumber ?: p(t, 'sourceId'),
        payeeName     : attrs.payeeName ?: attrs.teamMemberName,
        sourceSplitBps: attrs.splitBps,
        closeDate     : p(t, 'closeDate'),
        incentiveDate : p(t, 'incentiveDate'),
        amount        : p(t, 'amount'),
        product       : p(t, 'product'),
        customer      : p(t, 'customer'),
        attrs         : attrs,
    ]
    if (inc == null) { txns << row; continue }   // NO_DATE, reported by the pass
    long i = ((Number) inc).longValue()
    if (i < winStart || i > winEnd) { outOfWindow << p(t, 'transactionId'); continue }
    txns << row
}

Map out = CreditPass.run(txns, ctx)

// SORTED, and not for cosmetics. Runs are insert-only and the way "my number changed
// on Tuesday, why" gets answered is by diffing two of them - which only works if the
// same inputs produce the same ORDER. Fetch order is not promised by anything, so the
// fold imposes one: the deal, then the person, then the direct credit before the rolled
// copies that hang off it.
List ordered = new ArrayList(out.credits)
ordered.sort { a, b ->
    int c = String.valueOf(a.orderNumber).compareTo(String.valueOf(b.orderNumber)); if (c != 0) return c
    c = String.valueOf(a.payeeName).compareTo(String.valueOf(b.payeeName)); if (c != 0) return c
    c = Boolean.valueOf(a.isRollup) <=> Boolean.valueOf(b.isRollup); if (c != 0) return c
    c = ((Number) a.hierarchyLevel).intValue() <=> ((Number) b.hierarchyLevel).intValue(); if (c != 0) return c
    return String.valueOf(a.creditTypeCode).compareTo(String.valueOf(b.creditTypeCode))
}

// A BigDecimal does not survive the response boundary intact; amounts are already
// Long minor units, and the split goes back as a string so nothing reformats it.
List credits = ordered.collect {
    [creditId: it.id, transactionId: it.transactionId, orderNumber: it.orderNumber,
     payeeName: it.payeeName, employeeId: it.employeeId, positionId: it.positionId,
     creditRuleId: it.creditRuleId, ruleId: it.ruleId, planId: it.planId, lane: it.lane,
     creditTypeId: it.creditTypeId, creditType: it.creditTypeCode,
     amount: it.amount, splitBps: it.splitBps,
     isRollup: it.isRollup, sourceCreditId: it.sourceCreditId, hierarchyLevel: it.hierarchyLevel,
     trace: it.trace]
}

Map stats = new LinkedHashMap((Map) out.stats)
stats.put('outOfWindow', outOfWindow.size())
stats.put('scanned', rows(txnRows).size())

return [status: 'OK', message: '', runId: runId, dryRun: truthy(dryRun),
        periodName: periodName, windowStart: winStart, windowEnd: winEnd,
        credits: credits, exceptions: out.exceptions, stats: stats, expected: credits.size()]
