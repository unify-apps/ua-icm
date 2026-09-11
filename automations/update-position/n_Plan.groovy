// Decide every write for one position edit, from what the store holds right now.
//
// Nothing here does I/O. The five reads before it are the whole picture, and the write
// nodes after it only ever carry what this returns - so every refusal happens before the
// first write, and the same request sent twice plans nothing the second time.
//
// The as-of rule is the one List Positions and Resolve Position Occupant read with:
// boundaries inclusive at both ends, a missing effectiveEnd means still in force. A write
// that used any other rule would produce rows the read side interprets differently.

def rows = { v -> (v instanceof List) ? v : [] }
def sv = { v -> (v == null) ? '' : String.valueOf(v).trim() }
def B = { v -> String.valueOf(v) == 'true' }
// Storage numbers come back as Integer, Long or Double depending on the VALUE
// (notes/runtime-facts.md, 2026-09-03), so every epoch goes through one door.
def num = { v -> sv(v).isEmpty() ? null : new BigDecimal(sv(v)).longValue() }

long asOf = num(effEpoch) ?: 0L
String day = sv(effDay)
String pid = sv(positionId)
String want = B(clearPayee) ? '' : sv(payeeId)

def inForce = { p ->
    Long st = num(p?.effectiveStart)
    Long en = num(p?.effectiveEnd)
    return (st == null || st <= asOf) && (en == null || en >= asOf)
}
// The earliest row that starts AFTER the date - a new open-ended row must stop short of
// it, or the edit would manufacture exactly the overlap the read side reports as CONFLICT.
def nextStartAfter = { List rs ->
    rs.collect { num(it.properties?.effectiveStart) }.findAll { it != null && it > asOf }.min()
}
// Pre-minted so the response can name the row it created. Same "e_" + 24 hex shape the
// server mints.
def mint = { -> 'e_' + UUID.randomUUID().toString().replace('-', '').substring(0, 24) }
// `bulk_upsert_records_by_id` stores NOTHING from a flat row - it answers success with a
// zero count (notes/runtime-facts.md, 2026-08-25). SET is per field, so an existing row
// keeps every property this does not name.
def upsert = { String id, Map fields ->
    [id: id, updateFields: fields.findAll { k, v -> v != null }.collect { k, v ->
        [fieldName: 'properties.' + k, actionType: 'SET', setValue: v] }]
}

List pos = rows(posRows)
List attrs = rows(attrRows)
List asgs = rows(asgRows)
Map pp = pos.isEmpty() ? [:] : (pos[0].properties ?: [:])
String code = sv(pp.positionCode)
// Dated rows are named after the seat's NAME, as Create Position names them - and after
// the name this request leaves it with, so a rename and a re-title in one edit agree.
String seatName = B(wantName) ? sv(name) : sv(pp.name)

String status = 'OK'
String message = ''
List curAttr = attrs.findAll { inForce(it.properties) }
List curAsg = asgs.findAll { inForce(it.properties) }

// Ordered so the most useful refusal wins: a missing position makes every other check moot.
if (pos.isEmpty()) {
    status = 'POSITION_NOT_FOUND'
    message = 'No position with id ' + pid + ' - it may have been deleted since the form was opened.'
} else if (B(attrMore) || B(asgMore)) {
    // A truncated history is a wrong picture, and a split planned from one would overlap
    // the rows that were not read.
    status = 'HISTORY_TOO_LONG'
    message = 'Position ' + code + ' has more than ' + historyLimit + ' dated rows - too many to change safely in one request.'
} else if (B(wantTitle) && rows(titleRows).isEmpty()) {
    status = 'TITLE_NOT_FOUND'
    message = 'No title with id ' + sv(titleId)
} else if (B(wantPerson) && !want.isEmpty() && rows(payeeRows).isEmpty()) {
    status = 'PAYEE_NOT_FOUND'
    message = 'No payee with id ' + want
} else if (B(wantTitle) && curAttr.size() > 1) {
    status = 'CONFLICT'
    message = curAttr.size() + ' title rows cover ' + day + ' for ' + code + '. Fix the overlap first - replacing one would leave the other in force.'
} else if (B(wantPerson) && curAsg.size() > 1) {
    status = 'CONFLICT'
    message = curAsg.size() + ' assignments cover ' + day + ' for ' + code + '. Fix the overlap first - replacing one would leave the other in force.'
}

List posUpdates = []
List attrUpdates = []
List asgUpdates = []
List deleteIds = []
List changed = []
boolean titleChanged = false
boolean personChanged = false
String attributeId = ''
String assignmentId = ''

if (status == 'OK') {
    // ---- the seat's own fields: not dated, so a plain field update
    Map posSet = [:]
    if (B(wantName) && sv(name) != sv(pp.name)) { posSet.name = sv(name); changed << 'name' }
    // a boolean never set is MISSING, so "null" never equals the requested value and gets written
    if (B(wantActive) && String.valueOf(pp.active) != String.valueOf(B(active))) { posSet.active = B(active); changed << 'active' }
    if (!posSet.isEmpty()) posUpdates << upsert(pid, posSet)

    // ---- the title: dated. Close the row in force the day before, open a new one from it.
    if (B(wantTitle)) {
        String tid = sv(titleId)
        def cur = curAttr.isEmpty() ? null : curAttr[0]
        if (cur == null || sv(cur.properties?.titleId) != tid) {
            titleChanged = true
            changed << 'titleId'
            if (cur != null && num(cur.properties?.effectiveStart) == asOf) {
                // The row opened on this very day, so this is a correction, not history.
                // Closing it at asOf - 1 would end it before it began, and such a row is
                // invisible to every as-of read - silent damage.
                attrUpdates << upsert(sv(cur.id), [titleId: tid])
                attributeId = sv(cur.id)
            } else {
                Long end = null
                if (cur != null) {
                    // the new row inherits the old one's end, so a later dated row stays untouched
                    end = num(cur.properties?.effectiveEnd)
                    // one millisecond before, not a day: a day would overlap the two rows
                    attrUpdates << upsert(sv(cur.id), [effectiveEnd: asOf - 1L])
                } else {
                    Long next = nextStartAfter(attrs)
                    end = (next == null) ? null : next - 1L
                }
                attributeId = mint()
                attrUpdates << upsert(attributeId, [
                    name: sv(cur?.properties?.name) ?: (seatName + ' attributes'),
                    positionId: pid,
                    titleId: tid,
                    territoryId: sv(cur?.properties?.territoryId) ?: null,
                    effectiveStart: asOf,
                    effectiveEnd: end])
            }
        }
    }

    // ---- the person: dated the same way. Blank `want` is an open seat.
    if (B(wantPerson)) {
        def cur = curAsg.isEmpty() ? null : curAsg[0]
        String held = (cur == null) ? '' : sv(cur.properties?.payeeId)
        if (held != want) {
            personChanged = true
            changed << 'payeeId'
            if (cur != null && num(cur.properties?.effectiveStart) == asOf) {
                // Same-day correction. Emptying a seat the person only took today removes
                // the assignment outright - there is no day on which it was really held.
                if (want.isEmpty()) {
                    deleteIds << sv(cur.id)
                } else {
                    asgUpdates << upsert(sv(cur.id), [payeeId: want])
                    assignmentId = sv(cur.id)
                }
            } else {
                Long end = null
                if (cur != null) {
                    end = num(cur.properties?.effectiveEnd)
                    asgUpdates << upsert(sv(cur.id), [effectiveEnd: asOf - 1L])
                } else {
                    Long next = nextStartAfter(asgs)
                    end = (next == null) ? null : next - 1L
                }
                if (!want.isEmpty()) {
                    def pct = cur?.properties?.allocationPct
                    assignmentId = mint()
                    asgUpdates << upsert(assignmentId, [
                        name: seatName + ' assignment',
                        payeeId: want,
                        positionId: pid,
                        effectiveStart: asOf,
                        effectiveEnd: end,
                        allocationPct: (pct == null ? 100 : pct)])
                }
            }
        }
    }

    List said = []
    if (changed.contains('name')) said << 'renamed'
    if (changed.contains('active')) said << (B(active) ? 'activated' : 'deactivated')
    if (titleChanged) said << ('title changed from ' + day)
    if (personChanged) said << ((want.isEmpty() ? 'seat opened from ' : 'person changed from ') + day)
    message = said.isEmpty()
        ? ('Nothing changed - position ' + code + ' already matches.')
        : ('Position ' + code + ' ' + said.join(', ') + '.')
}

int delExpected = deleteIds.size()
return [ok: status == 'OK', status: status, message: message, positionCode: code,
        posUpdates: posUpdates, attrUpdates: attrUpdates, asgUpdates: asgUpdates,
        // an empty IN is a clean no-match; the sentinel keeps the filter's shape fixed
        deleteIds: deleteIds.isEmpty() ? ['__none__'] : deleteIds,
        posExpected: posUpdates.size(), attrExpected: attrUpdates.size(),
        asgExpected: asgUpdates.size(), delExpected: delExpected,
        changedFields: changed, titleChanged: titleChanged, personChanged: personChanged,
        attributeId: attributeId, assignmentId: assignmentId]
