// Judge every row of the file against what is stored, and plan the writes.
//
// No I/O. The reads before this were keyed on the file's own codes and employee ids, so
// the work grows with the FILE, not with the org. Every row is judged before anything is
// written, and a refused row contributes nothing - its other cells are not half-applied.
//
// What an upload may do to a position that ALREADY exists is deliberately narrow: rename
// it, and give it a title or a holder on a date where it has none. A DIFFERENT title or
// holder is refused and pointed at the drawer, because that is a dated change (close the
// row in force, open a new one) and ICM | Update Position is where that rule lives.

def txt = { v -> (v == null) ? '' : String.valueOf(v).trim() }
def rowsOf = { v -> (v instanceof List) ? v : [] }
def B = { v -> String.valueOf(v) == 'true' }
// Storage numbers come back as Integer, Long or Double depending on the VALUE
// (notes/runtime-facts.md, 2026-09-03), so every epoch goes through one door.
def num = { v -> txt(v).isEmpty() ? null : new BigDecimal(txt(v)).longValue() }
def md5hex = { String s -> java.security.MessageDigest.getInstance('MD5').digest(s.getBytes('UTF-8')).encodeHex().toString() }
// Minted from the business key, so the same file uploaded twice targets the same records
// instead of creating a second copy of every position. Bulk Manage People does the same.
def mint = { String seed -> 'e_' + md5hex(seed).substring(0, 24) }
// `bulk_upsert_records_by_id` stores NOTHING from a flat row - it answers success with a
// zero count (notes/runtime-facts.md, 2026-08-25). SET is per field, so an existing record
// keeps every property this does not name.
def upsert = { String id, Map fields ->
    [id: id, updateFields: fields.findAll { k, v -> v != null }.collect { k, v ->
        [fieldName: 'properties.' + k, actionType: 'SET', setValue: v] }]
}
def dayOf = { long ms -> java.time.Instant.ofEpochMilli(ms).atZone(java.time.ZoneOffset.UTC).toLocalDate().toString() }
def parseDay = { String s ->
    if (!(s ==~ /^\d{4}-\d{2}-\d{2}$/)) return -1L
    try { return java.time.LocalDate.parse(s).atStartOfDay(java.time.ZoneOffset.UTC).toInstant().toEpochMilli() }
    catch (Exception e) { return -1L }
}
// The as-of rule every position read uses: inclusive at both ends, no end means in force.
def inForce = { p, long asOf ->
    Long st = num(p?.effectiveStart)
    Long en = num(p?.effectiveEnd)
    return (st == null || st <= asOf) && (en == null || en >= asOf)
}
// A row opened where none is in force must stop short of the next one, or the upload
// would manufacture the overlap List Positions reports as CONFLICT.
def nextStartAfter = { List rs, long asOf ->
    rs.collect { num(it.properties?.effectiveStart) }.findAll { it != null && it > asOf }.min()
}
def byPosition = { List rs ->
    Map m = [:]
    rs.each { r ->
        String k = txt(r.properties?.positionId)
        if (!m.containsKey(k)) m[k] = []
        m[k] << r
    }
    return m
}

int maxRowsAllowed = Integer.valueOf(txt(maxRows) ?: '2000')
boolean isDry = txt(dryRun) == 'true'
long today = java.time.LocalDate.now(java.time.ZoneOffset.UTC).atStartOfDay(java.time.ZoneOffset.UTC).toInstant().toEpochMilli()
List clean = rowsOf(rows)
List missing = rowsOf(missingColumns)

Map titleByCode = [:]
rowsOf(titleRows).each { t -> String c = txt(t.properties?.titleCode).toLowerCase(); if (c) titleByCode[c] = txt(t.id) }
Map posByCode = [:]
rowsOf(posRows).each { p -> String c = txt(p.properties?.positionCode); if (c) posByCode[c] = [id: txt(p.id), props: (p.properties ?: [:])] }
Map payeeByEmployeeId = [:]
rowsOf(payeeRows).each { p -> String e = txt(p.properties?.employeeId); if (e) payeeByEmployeeId[e] = txt(p.id) }
Map attrsByPos = byPosition(rowsOf(attrRows))
Map asgsByPos = byPosition(rowsOf(asgRows))

// ---- the file as a whole
String fileStatus = ''
String fileMessage = ''
if (!missing.isEmpty()) {
    fileStatus = 'INVALID_INPUT'
    fileMessage = 'The file is missing the ' + missing.join(', ') + ' column' + (missing.size() == 1 ? '' : 's') + '. Start from the template.'
} else if (clean.isEmpty()) {
    fileStatus = 'INVALID_INPUT'
    fileMessage = 'The file has no positions in it.'
} else if (clean.size() > maxRowsAllowed) {
    fileStatus = 'REFUSED'
    fileMessage = 'The file has ' + clean.size() + ' positions. Upload at most ' + maxRowsAllowed + ' at a time.'
} else if ([titleMore, posMore, payMore, attrMore, asgMore].any { B(it) }) {
    // A plan made from a truncated read would create duplicates and overlaps it cannot see.
    fileStatus = 'REFUSED'
    fileMessage = 'More stored records than one pass can check this file against. Nothing was written - split the file and upload it in parts.'
}

def verdict = { Map r, String outcome, String error ->
    [line: r.line, outcome: outcome, error: error,
     position_code: txt(r.position_code), name: txt(r.name), title_code: txt(r.title_code),
     employee_id: txt(r.employee_id), effective_start: txt(r.effective_start)]
}

List out = []
List posUpdates = []
List attrUpdates = []
List asgUpdates = []
Map firstLineByCode = [:]

clean.each { Map r ->
    if (!fileStatus.isEmpty()) { out << verdict(r, 'error', fileMessage); return }

    String code = txt(r.position_code)
    String nm = txt(r.name)
    String titleCode = txt(r.title_code)
    String employeeId = txt(r.employee_id)
    String eff = txt(r.effective_start)
    List problems = []

    if (code.isEmpty()) {
        problems << 'position_code is required'
    } else if (firstLineByCode.containsKey(code)) {
        problems << ('position_code ' + code + ' is already on line ' + firstLineByCode[code] + ' of this file')
    } else {
        firstLineByCode[code] = r.line
    }

    long asOf = today
    if (!eff.isEmpty()) {
        long parsed = parseDay(eff)
        if (parsed < 0L) { problems << ('effective_start must be yyyy-MM-dd: ' + eff) } else { asOf = parsed }
    }
    String day = dayOf(asOf)

    String titleId = titleCode.isEmpty() ? '' : (titleByCode[titleCode.toLowerCase()] ?: '')
    if (!titleCode.isEmpty() && titleId.isEmpty()) problems << ('title_code is not a known title: ' + titleCode)
    String payeeId = employeeId.isEmpty() ? '' : (payeeByEmployeeId[employeeId] ?: '')
    if (!employeeId.isEmpty() && payeeId.isEmpty()) problems << ('employee_id is not a known person: ' + employeeId)

    def hit = code.isEmpty() ? null : posByCode[code]
    if (hit == null && !code.isEmpty()) {
        if (nm.isEmpty()) problems << 'name is required for a new position'
        if (titleCode.isEmpty()) problems << 'title_code is required for a new position'
    }

    List rowPos = []
    List rowAttr = []
    List rowAsg = []
    String outcome = 'unchanged'

    if (problems.isEmpty() && hit == null) {
        String pid = mint('Position|' + code)
        rowPos << upsert(pid, [positionCode: code, name: nm, active: true])
        // named after the seat, as ICM | Create Position names them
        rowAttr << upsert(mint('PositionAttribute|' + code + '|' + asOf),
            [name: nm + ' attributes', positionId: pid, titleId: titleId, effectiveStart: asOf])
        if (!payeeId.isEmpty()) {
            rowAsg << upsert(mint('PayeePositionAssignment|' + code + '|' + asOf),
                [name: nm + ' assignment', payeeId: payeeId, positionId: pid, effectiveStart: asOf, allocationPct: 100])
        }
        outcome = 'created'
    } else if (problems.isEmpty()) {
        String pid = hit.id
        String seatName = nm.isEmpty() ? txt(hit.props.name) : nm
        if (!nm.isEmpty() && nm != txt(hit.props.name)) rowPos << upsert(pid, [name: nm])

        if (!titleId.isEmpty()) {
            List all = attrsByPos[pid] ?: []
            List cur = all.findAll { inForce(it.properties, asOf) }
            if (cur.isEmpty()) {
                Long next = nextStartAfter(all, asOf)
                rowAttr << upsert(mint('PositionAttribute|' + code + '|' + asOf),
                    [name: seatName + ' attributes', positionId: pid, titleId: titleId,
                     effectiveStart: asOf, effectiveEnd: (next == null ? null : next - 1L)])
            } else if (cur.size() > 1 || txt(cur[0].properties?.titleId) != titleId) {
                problems << ('position ' + code + ' already has a different title on ' + day + ' - change it from the Positions drawer, where the change is dated')
            }
        }

        if (!payeeId.isEmpty()) {
            List all = asgsByPos[pid] ?: []
            List cur = all.findAll { inForce(it.properties, asOf) }
            if (cur.isEmpty()) {
                Long next = nextStartAfter(all, asOf)
                rowAsg << upsert(mint('PayeePositionAssignment|' + code + '|' + asOf),
                    [name: seatName + ' assignment', payeeId: payeeId, positionId: pid,
                     effectiveStart: asOf, effectiveEnd: (next == null ? null : next - 1L), allocationPct: 100])
            } else if (cur.size() > 1 || txt(cur[0].properties?.payeeId) != payeeId) {
                problems << ('position ' + code + ' is already held by someone else on ' + day + ' - change who holds it from the Positions drawer, where the change is dated')
            }
        }

        if (!rowPos.isEmpty() || !rowAttr.isEmpty() || !rowAsg.isEmpty()) outcome = 'updated'
    }

    if (!problems.isEmpty()) { out << verdict(r, 'error', problems.join('; ')); return }
    posUpdates.addAll(rowPos)
    attrUpdates.addAll(rowAttr)
    asgUpdates.addAll(rowAsg)
    out << verdict(r, outcome, '')
}

int errors = out.count { it.outcome == 'error' }
int applied = out.count { it.outcome == 'created' || it.outcome == 'updated' }
String status = fileStatus
if (status.isEmpty()) status = (errors == out.size()) ? 'REFUSED' : ((errors > 0) ? 'PARTIAL' : 'APPLIED')

if (isDry) {
    posUpdates = []
    attrUpdates = []
    asgUpdates = []
}

return [status: status,
        message: !fileMessage.isEmpty() ? fileMessage : (isDry ? 'Preview only - nothing was written.' : ''),
        rows: out, applied: applied, writtenRows: isDry ? 0 : applied,
        posUpdates: posUpdates, attrUpdates: attrUpdates, asgUpdates: asgUpdates,
        posExpected: posUpdates.size(), attrExpected: attrUpdates.size(), asgExpected: asgUpdates.size()]
