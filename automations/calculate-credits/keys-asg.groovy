// Stage 5 -> 6: every key a PlanAssignment might name this seat or title by.
//
// The live data names targets FOUR ways: a record id in `targetId`, a record id in
// `positionId`/`titleId`, and a business CODE in either. PLAN-1789032727380-3055 stores
// the string "POS-UK-AE-02" in a column typed as a foreign key to Position. So the key
// set is ids AND codes, and the fold accepts both.
//
// ONE FETCH, NOT THREE. The read is a STRUCTURED top-level OR -
// `targetId IN all OR positionId IN seats OR titleId IN titles` - which the builder draws
// and the index analyser reads, unlike a Groovy-built pill. The `startDate <= windowEnd`
// trim is dropped to keep it one flat OR: a seat has a handful of assignments over its
// life, and the fold judges every one of them by date anyway.

def rows(v) { return (v instanceof List) ? v : [] }
def p(row, String k) { return ((Map) row?.properties)?.get(k) }

Set posKeys = new LinkedHashSet()
for (v in rows(positionIds)) if (v != null && v != '__none__') posKeys << String.valueOf(v)
for (r in rows(posRows)) { def c = p(r, 'positionCode'); if (c != null) posKeys << String.valueOf(c) }

Set titleKeys = new LinkedHashSet()
for (v in rows(titleIds)) if (v != null && v != '__none__') titleKeys << String.valueOf(v)
for (r in rows(titleRows)) { def c = p(r, 'titleCode'); if (c != null) titleKeys << String.valueOf(c) }

Set all = new LinkedHashSet(); all.addAll(posKeys); all.addAll(titleKeys)
def nn = { Set s -> s.isEmpty() ? ['__none__'] : new ArrayList(s) }
return [positionKeys: nn(posKeys), titleKeys: nn(titleKeys), allKeys: nn(all), count: all.size()]
