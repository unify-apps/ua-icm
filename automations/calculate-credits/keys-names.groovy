// Stage 1 -> 2: the distinct payee NAMES this period's deals actually mention.
//
// This is the hinge of the whole redesign. Before it, the flow read every Payee,
// Position, PositionAttribute and assignment in the org whether the period touched them
// or not - so the cost grew with HEADCOUNT instead of with the work. Now each fetch is
// filtered by the keys the previous stage proved it needs.
//
// It stays SET-based, one fetch per stage, and never one fetch per row. Resolving a name
// per transaction would be ~4 round trips x 2,917 rows for one month of NA data, and
// "no API call inside a per-item loop" is the rule that exists to stop exactly that.

def rows(v) { return (v instanceof List) ? v : [] }
def p(row, String k) { return ((Map) row?.properties)?.get(k) }

int cap = ((Number) keyCap).intValue()
Set names = new LinkedHashSet()
int noName = 0
for (t in rows(txnRows)) {
    Map attrs = (p(t, 'attrs') instanceof Map) ? (Map) p(t, 'attrs') : [:]
    def n = attrs.payeeName ?: attrs.teamMemberName
    String s = n == null ? '' : String.valueOf(n).trim()
    if (s.isEmpty()) { noName++; continue }
    names << s
}

// An empty IN matches NOTHING rather than being ignored, which is the safe direction -
// but the sentinel keeps the filter drawable and the counts honest.
List out = names.isEmpty() ? ['__none__'] : new ArrayList(names)

// A period touching more than `keyCap` distinct payees needs CHUNKING, not a bigger
// filter. Refusing is the honest answer; silently sending a 50,000-element IN is not.
return [names: out, count: names.size(), noName: noName, overflow: names.size() > cap]
