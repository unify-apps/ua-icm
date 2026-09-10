// Stage 6 -> 7: the plans those assignments point at.
//
// Status is NOT filtered here. A plan that is Draft or out of force still has to come
// back, because "an assignment points at a plan that is not usable" and "no assignment
// exists at all" are different answers to the rep, and filtering by status would collapse
// them into the second one.

def rows(v) { return (v instanceof List) ? v : [] }
def p(row, String k) { return ((Map) row?.properties)?.get(k) }

Set ids = new LinkedHashSet()
for (name in ['asgT', 'asgP', 'asgL']) {
    def bound = binding.hasVariable(name) ? binding.getVariable(name) : null
    for (r in rows(bound)) { def v = p(r, 'planId'); if (v != null) ids << String.valueOf(v) }
}
return [planIds: ids.isEmpty() ? ['__none__'] : new ArrayList(ids), count: ids.size()]
