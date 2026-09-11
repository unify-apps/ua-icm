// Validate the request and settle the effective date. Every default is applied HERE.
//
// An input the caller did not send is UNBOUND, not null - reading it directly throws
// "No such property" before any validation runs (notes/runtime-facts.md, 2026-09-10).
// A drawer legitimately omits the fields nobody touched, so every read goes through arg().
def arg = { String k -> binding.hasVariable(k) ? binding.getVariable(k) : null }
def sv = { v -> (v == null) ? '' : String.valueOf(v).trim() }

String pid = sv(arg('positionId'))
String nm = sv(arg('name'))
String tid = sv(arg('titleId'))
String payee = sv(arg('payeeId'))
String clearRaw = sv(arg('clearPayee')).toLowerCase()
String activeRaw = sv(arg('active')).toLowerCase()
String effRaw = sv(arg('effectiveStart'))

boolean valid = true
String reason = ''

if (pid.isEmpty()) { valid = false; reason = 'positionId is required - there is nothing to update without it.' }
else if (!(clearRaw in ['', 'true', 'false'])) { valid = false; reason = 'clearPayee must be true or false, got: ' + clearRaw }
else if (!(activeRaw in ['', 'true', 'false'])) { valid = false; reason = 'active must be true, false, or blank to leave it alone - got: ' + activeRaw }

boolean clearPayee = clearRaw == 'true'
if (valid && clearPayee && !payee.isEmpty()) {
    valid = false
    reason = 'send payeeId or clearPayee, not both - they disagree about who should hold the position.'
}

// Dates arrive as yyyy-MM-dd and are stored as epoch millis at UTC midnight, the same
// rule Create Position applies, so a seat created and edited on one day agree on "today".
long effEpoch = 0L
if (valid) {
    if (effRaw.isEmpty()) {
        effEpoch = java.time.LocalDate.now(java.time.ZoneOffset.UTC).atStartOfDay(java.time.ZoneOffset.UTC).toInstant().toEpochMilli()
    } else if (effRaw ==~ /^\d{4}-\d{2}-\d{2}$/) {
        try {
            effEpoch = java.time.LocalDate.parse(effRaw).atStartOfDay(java.time.ZoneOffset.UTC).toInstant().toEpochMilli()
        } catch (Exception e) { valid = false; reason = 'effectiveStart is not a real calendar date: ' + effRaw }
    } else {
        valid = false; reason = 'effectiveStart must be yyyy-MM-dd, got: ' + effRaw
    }
}
String effDay = java.time.Instant.ofEpochMilli(effEpoch).atZone(java.time.ZoneOffset.UTC).toLocalDate().toString()

boolean wantName = !nm.isEmpty()
boolean wantActive = !activeRaw.isEmpty()
boolean wantTitle = !tid.isEmpty()
boolean wantPerson = !payee.isEmpty() || clearPayee

if (valid && !(wantName || wantActive || wantTitle || wantPerson)) {
    valid = false
    reason = 'nothing to update - every field was blank.'
}

// '__none__' keeps a lookup nobody asked for a clean no-match instead of an unfiltered scan.
return [valid: valid, reason: reason, positionId: pid, name: nm, titleId: tid, payeeId: payee,
        clearPayee: clearPayee, active: activeRaw == 'true',
        wantName: wantName, wantActive: wantActive, wantTitle: wantTitle, wantPerson: wantPerson,
        effEpoch: effEpoch, effDay: effDay,
        positionKey: pid.isEmpty() ? '__none__' : pid,
        titleKey: tid.isEmpty() ? '__none__' : tid,
        payeeKey: payee.isEmpty() ? '__none__' : payee]
