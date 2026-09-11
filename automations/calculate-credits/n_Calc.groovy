// --- wiring: platform rows in, CreditPass out -------------------------------
//
// Everything above this line is PURE. Everything below it is the adapter: it turns
// what the fetch nodes returned into the indexed maps CreditPass expects, and turns
// what CreditPass returned into something that survives the response boundary.

def rows(v) { return (v instanceof List) ? v : [] }
def p(row, String k) { return ((Map) row?.properties)?.get(k) }
def truthy(v) { return v instanceof Boolean ? v : String.valueOf(v) == 'true' }

// Most reads after the rules are CONDITIONAL: Territory, Currency, CreditType and each
// hierarchy hop run only when a rule needs them. A pill to a node that never ran leaves
// the binding MISSING rather than null, so every fetch input is read through here.
def opt = { String n -> binding.hasVariable(n) ? binding.getVariable(n) : null }
def R = { String n -> rows(opt(n + 'Rows')) }

/** Union several fetches into one list, de-duplicated by RECORD id.
 *
 *  Needed because the reads are STAGED: the reporting line arrives as up to four hops
 *  and the occupants as the crediting seats plus the ancestor seats. Overlap between
 *  them is normal - one manager is the parent of many seats - so de-duplicating by id
 *  is what stops the same row being counted twice in the fold. */
def merge(List... parts) {
    Map byId = [:]
    for (part in parts) for (r in rows(part)) if (r?.id != null) byId[r.id] = r
    return new ArrayList(byId.values())
}

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
def bound = { String label, String param -> if (truthy(opt(param + 'More'))) truncated << label }
bound('Transaction', 'txn'); bound('Payee', 'payee')
bound('PayeePositionAssignment (seats)', 'occ')
bound('PayeePositionAssignment (managers)', 'occUp')
bound('PositionAttribute', 'attr'); bound('Position', 'pos')
bound('PositionHierarchy hop 1', 'hier1'); bound('PositionHierarchy hop 2', 'hier2')
bound('PositionHierarchy hop 3', 'hier3'); bound('PositionHierarchy hop 4', 'hier4')
bound('PlanAssignment', 'asg')
bound('Plan', 'plan'); bound('Rule', 'rule'); bound('Title', 'title')
bound('Territory', 'terr'); bound('Currency', 'ccy'); bound('CreditType', 'ct')

def refuseRun = { String status, String message ->
    return [status: status, message: message, runId: runId, dryRun: truthy(dryRun),
            periodName: periodName, windowStart: 0, windowEnd: 0,
            credits: [], exceptions: [], stats: [:], expected: 0]
}

if (!truncated.isEmpty()) {
    return refuseRun('FETCH_TRUNCATED',
        ("these objects returned more rows than one page held, so any answer would be computed "
         + "on a prefix: " + truncated.join(', ') + ". Raise pageLimit or narrow the period.").toString())
}

// The staged reads are only as good as the key sets that drive them. Both guards below
// exist because the honest failure of a set-based design is a set that got too big or a
// walk that did not finish - and either one, unreported, quietly underpays somebody.
if (truthy(nameOverflow) || truthy(seatOverflow)) {
    return refuseRun('KEY_SET_TOO_LARGE',
        ("this period touches more distinct " + (truthy(nameOverflow) ? "payees" : "seats")
         + " than one filter should carry. The fix is to calculate it in chunks, not to send a "
         + "larger IN list.").toString())
}
if (truthy(opt('hierDeeper'))) {
    return refuseRun('HIERARCHY_TOO_DEEP',
        ("the reporting line is still climbing after four hops, so the top of the tree was not "
         + "read and rollup would be short. Add hops rather than accept a partial walk.").toString())
}

// --- reference codes ---------------------------------------------------------
Map currencyCodeById = [:]
for (c in R('ccy')) currencyCodeById[c.id] = p(c, 'code')

Map titleCodeById = [:]
for (t in R('title')) titleCodeById[t.id] = p(t, 'titleCode')

Map territoryCodeById = [:]
for (t in R('terr')) territoryCodeById[t.id] = p(t, 'territoryCode')

Map positionCodeById = [:]
for (t in R('pos')) positionCodeById[t.id] = p(t, 'positionCode')

// creditType is authored as a CODE and stored as a record id. Resolving one to the
// other here is what keeps a rule readable and the column a real foreign key.
Map creditTypeIdByCode = [:]
for (t in R('ct')) { def c = p(t, 'creditTypeCode'); if (c != null) creditTypeIdByCode[String.valueOf(c)] = t.id }

// --- people ------------------------------------------------------------------
Map payeeById = [:]
Map payeeIdsByName = [:]
for (pay in R('payee')) {
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
for (pl in R('plan')) {
    Map v = [planId: p(pl, 'planId'), status: p(pl, 'status'),
             startDate: p(pl, 'startDate'), endDate: p(pl, 'endDate'),
             creditRules: p(pl, 'creditRules') ?: []]
    plansById[pl.id] = v
    if (v.planId != null) plansById[String.valueOf(v.planId)] = v
}

Map rulesByRuleId = [:]
for (r in R('rule')) {
    def rk = p(r, 'ruleId')
    if (rk == null) continue                      // a half-written Rule row indexes as nothing
    if (p(r, 'stage') != 'credit') continue       // the payout pass reads the others
    rulesByRuleId[String.valueOf(rk)] = [recordId: r.id, ruleId: rk, conditions: p(r, 'conditions'),
                                         result: p(r, 'result'), activeStart: p(r, 'activeStart'),
                                         activeEnd: p(r, 'activeEnd')]
}

List assignments = R('asg').collect {
    [planKey: p(it, 'planId'), targetType: p(it, 'targetType'), targetId: p(it, 'targetId'),
     titleId: p(it, 'titleId'), positionId: p(it, 'positionId'),
     startDate: p(it, 'startDate'), endDate: p(it, 'endDate')]
}

// A rep's own seats come from the payee-keyed fetch; a MANAGER's occupant comes from the
// ancestor-keyed one. `seatsByPayee` must see only the first - a manager is not a payee
// this period unless they closed something - while `occupantByPosition` must see both, or
// the rollup finds every manager seat vacant.
List seatRows = R('occ')
List allOccupants = merge(R('occ'), R('occUp'))
List hierAll = merge(R('hier1'), R('hier2'), R('hier3'), R('hier4'))

Map ctx = [
    seed              : ((Number) startedAt).longValue(),
    payeeIdsByName    : payeeIdsByName,
    payeeById         : payeeById,
    seatsByPayee      : group(seatRows, 'payeeId', { [positionId: p(it, 'positionId'),
                                                          effectiveStart: p(it, 'effectiveStart'), effectiveEnd: p(it, 'effectiveEnd')] }),
    occupantByPosition: group(allOccupants, 'positionId', { [payeeId: p(it, 'payeeId'),
                                                          effectiveStart: p(it, 'effectiveStart'), effectiveEnd: p(it, 'effectiveEnd')] }),
    attrByPosition    : group(R('attr'), 'positionId', { [titleId: p(it, 'titleId'), territoryId: p(it, 'territoryId'),
                                                          effectiveStart: p(it, 'effectiveStart'), effectiveEnd: p(it, 'effectiveEnd')] }),
    parentByPosition  : group(hierAll, 'positionId', { [parentPositionId: p(it, 'parentPositionId'),
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
for (t in R('txn')) {
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
stats.put('scanned', R('txn').size())
// The point of the redesign, in numbers: how many rows the period actually pulled. On a
// real org these are the difference between a bounded read and a whole-table one.
stats.put('rowsRead', [transactions: R('txn').size(), payees: R('payee').size(),
                       assignments: allOccupants.size(), attributes: R('attr').size(),
                       hierarchy: hierAll.size(), positions: R('pos').size(),
                       planAssignments: assignments.size(), plans: R('plan').size(),
                       rules: R('rule').size()])

return [status: 'OK', message: '', runId: runId, dryRun: truthy(dryRun),
        periodName: periodName, windowStart: winStart, windowEnd: winEnd,
        credits: credits, exceptions: out.exceptions, stats: stats, expected: credits.size()]
