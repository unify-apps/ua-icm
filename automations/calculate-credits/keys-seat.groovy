// Stage 3 -> 4: the SEATS those payees held. Not every seat in the org - only the ones
// the period's deals can possibly credit.
//
// The date window is already applied server-side (effectiveStart <= windowEnd), so a
// seat somebody takes up next quarter never reaches the fold at all.

def rows(v) { return (v instanceof List) ? v : [] }
def p(row, String k) { return ((Map) row?.properties)?.get(k) }

int cap = ((Number) keyCap).intValue()
Set pos = new LinkedHashSet()
for (r in rows(occRows)) { def v = p(r, 'positionId'); if (v != null) pos << String.valueOf(v) }
return [positionIds: pos.isEmpty() ? ['__none__'] : new ArrayList(pos),
        count: pos.size(), overflow: pos.size() > cap]
