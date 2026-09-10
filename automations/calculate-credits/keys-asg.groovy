// Stage 5 -> 6: every key a PlanAssignment might name this seat or title by.
//
// The live data names targets FOUR ways: a record id in `targetId`, a record id in
// `positionId`/`titleId`, and a business CODE in either. PLAN-1789032727380-3055 stores
// the string "POS-UK-AE-02" in a column typed as a foreign key to Position. So the key
// set is ids AND codes, and the fold accepts both.
//
// WHY THREE FETCHES AND NOT ONE. "startDate <= end AND (targetId IN .. OR positionId IN
// .. OR titleId IN ..)" is expressible, but only by building the whole filter in Groovy
// and passing it as one pill - and a whole-value template filter does not render in the
// builder AND silently suppresses every missing-index warning for that node. These
// filters WILL need an index. Three structured fetches keep both the drawing and the
// warning; the fold unions and de-duplicates them by record id.

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
