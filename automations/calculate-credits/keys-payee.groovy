// Stage 2 -> 3: the payee RECORD ids the names resolved to.
//
// Names that resolved to nothing are not reported here. A missing payee is a per-ROW
// verdict (UNRESOLVED_PAYEE, against one transaction) and the fold is where a row gets
// a verdict; a key extractor that refused here would fail the whole period over one
// unmapped name.

def rows(v) { return (v instanceof List) ? v : [] }
Set ids = new LinkedHashSet()
for (r in rows(payeeRows)) if (r.id != null) ids << r.id
return [payeeIds: ids.isEmpty() ? ['__none__'] : new ArrayList(ids), count: ids.size()]
