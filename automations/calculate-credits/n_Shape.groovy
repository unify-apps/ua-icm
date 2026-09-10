// Decide whether this period may be calculated at all, and hand the window down.
//
// Three refusals, each with its own caller-actionable status, because "it did not run"
// is not an answer anybody can act on:
//
//   INVALID_INPUT     the caller sent no periodId
//   PERIOD_NOT_FOUND  they sent one no Period carries
//   PERIOD_NOT_OPEN   the period is CLOSED, PAID or already CALCULATING
//
// CLOSED and PAID are the audit boundary — recalculating a paid month is how a number
// somebody has already been paid against silently changes. CALCULATING means another
// run holds it.

def rows(v) { return (v instanceof List) ? v : [] }
def p(row, String k) { return ((Map) row?.properties)?.get(k) }

List periods = rows(periodRows)

if (!(inputOk instanceof Boolean ? inputOk : String.valueOf(inputOk) == 'true')) {
    return [ok: false, status: 'INVALID_INPUT', message: 'periodId is required']
}
if (periods.isEmpty()) {
    return [ok: false, status: 'PERIOD_NOT_FOUND', message: "no Period with id ${periodId}".toString()]
}

def period = periods[0]
String st = String.valueOf(p(period, 'status'))
if (st != 'OPEN') {
    return [ok: false, status: 'PERIOD_NOT_OPEN',
            message: "period ${p(period, 'name')} is ${st}; only an OPEN period may be calculated".toString()]
}

def s = p(period, 'startDate'), e = p(period, 'endDate')
if (s == null || e == null) {
    return [ok: false, status: 'PERIOD_NOT_USABLE',
            message: "period ${p(period, 'name')} has no start or end date".toString()]
}

return [
    ok         : true,
    status     : 'OK',
    message    : '',
    periodName : String.valueOf(p(period, 'name')),
    windowStart: ((Number) s).longValue(),
    windowEnd  : ((Number) e).longValue(),
]
