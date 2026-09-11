// Normalise the file once, and pull out the keys every later read is filtered by.
//
// The loop hands rows back keyed by the file's own header, and a CSV saved by Excel
// carries a BOM that mangles the first one ('position_code' arrives as
// '__position_code_'). Keys are normalised HERE, the same way Bulk Manage People does it,
// so nothing downstream cares how the header was spelled.
def txt = { v -> (v == null) ? '' : String.valueOf(v).trim() }
def norm = { k -> String.valueOf(k).toLowerCase().replaceAll(/[^a-z_]/, '').replaceAll(/^_+|_+$/, '') }
def COLUMNS = ['position_code', 'name', 'title_code', 'employee_id', 'effective_start']
def REQUIRED = ['position_code', 'name', 'title_code']

List raw = (rows instanceof List) ? rows : []
List clean = []
Set codes = new LinkedHashSet()
Set employeeIds = new LinkedHashSet()
Set headers = new HashSet()

raw.eachWithIndex { r, i ->
    Map byKey = [:]
    if (r instanceof Map) r.each { k, v -> String nk = norm(k); headers << nk; byKey[nk] = txt(v) }
    // the header is line 1, so the first data row is line 2 - the number a spreadsheet shows
    Map row = [line: i + 2]
    COLUMNS.each { c -> row[c] = byKey[c] ?: '' }
    // a fully blank line is not a row anybody meant to upload
    if (COLUMNS.every { c -> row[c] == '' }) return
    clean << row
    if (row.position_code) codes << row.position_code
    if (row.employee_id) employeeIds << row.employee_id
}

// Named once for the whole file: a wrong header otherwise reads as N identical row errors.
List missing = raw.isEmpty() ? [] : REQUIRED.findAll { !headers.contains(it) }

// '__none__' keeps an IN over nothing a clean no-match rather than an unfiltered scan.
return [clean: clean, rowCount: clean.size(), missingColumns: missing,
        codes: codes.isEmpty() ? ['__none__'] : (codes as List),
        employeeIds: employeeIds.isEmpty() ? ['__none__'] : (employeeIds as List)]
