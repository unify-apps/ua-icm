// Which credit run to pay from, and which payout runs this one will supersede.
//
// The credit run is the period's LATEST Succeeded, non-dry run whose scope is not a payout
// run. Calculate Credits writes `scope: {}`; this automation writes `scope.stage = "payout"`.
// Older credit runs are not marked Superseded by anything today, so "latest by startedAt"
// is the rule, stated in the spec.
//
// A TRUNCATED run read is refused here, before anything else. Every wet payout run adds a
// Succeeded run to the period, so a page that did not hold them all can hide the credit run
// and answer NO_CREDIT_RUN for a period that was credited (caught by the suite, 2026-09-11).

def rows(v) { return (v instanceof List) ? v : [] }
def p(row, String k) { return ((Map) row?.properties)?.get(k) }
def truthy(v) { return v instanceof Boolean ? v : String.valueOf(v) == 'true' }
def opt = { String n -> binding.hasVariable(n) ? binding.getVariable(n) : null }

if (truthy(opt('runMore'))) {
    return [found: false, status: 'FETCH_TRUNCATED',
            message: 'this period has more finished runs than one page held, so the credit run cannot be picked safely. Raise pageLimit.',
            creditRunId: '__none__', creditRunKey: '', payoutRunIds: ['__none__']]
}

String creditRun = null
String creditRunKey = ''
long best = Long.MIN_VALUE
Set payoutRuns = new LinkedHashSet()

for (r in rows(runRows)) {
    if (p(r, 'status') != 'Succeeded') continue
    if (truthy(p(r, 'dryRun'))) continue
    def scope = p(r, 'scope')
    def stage = (scope instanceof Map) ? scope.stage : null
    if (stage == 'payout') { payoutRuns << String.valueOf(r.id); continue }
    if (stage != null && stage != 'credit') continue
    def started = p(r, 'startedAt')
    long s = started instanceof Number ? ((Number) started).longValue() : 0L
    if (creditRun == null || s > best) {
        creditRun = String.valueOf(r.id)
        creditRunKey = String.valueOf(p(r, 'runId'))
        best = s
    }
}

boolean found = creditRun != null
return [
    found       : found,
    status      : found ? 'OK' : 'NO_CREDIT_RUN',
    message     : found ? '' : 'this period has no Succeeded, non-dry-run credit run; run ICM | Calculate Credits with dryRun false first',
    creditRunId : creditRun ?: '__none__',
    creditRunKey: creditRunKey,
    payoutRunIds: payoutRuns.isEmpty() ? ['__none__'] : new ArrayList(payoutRuns),
]
