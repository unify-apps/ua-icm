// One hop up the reporting line, and whether the rules need another.
//
// ONE FILE, FOUR NODES. Each hop binds one more `hier<N>` set and reads whatever is
// there through `binding.hasVariable` - an unbound parameter is not null on this
// platform, it does not exist, so `?:` cannot be used to make a parameter list optional.
//
// WHY HOPS AND NOT ONE FETCH. Rollup climbs an unknown number of levels, and the seats
// above a rep are not knowable from the rep's own row - each level has to be asked for.
// Reading the WHOLE PositionHierarchy table instead would put org size back into the
// cost, which is the thing the staged design removes.
//
// WHY `next`. The walk only climbs as far as the rules' largest rollupLevels. A plan that
// rolls up one level reads ONE hop; the branch in front of each later hop is closed by
// this flag, so those fetches never execute. Four hops is still the ceiling, and a rule
// asking for more than the tree the four hops read is REPORTED, never truncated.

def opt = { String n -> binding.hasVariable(n) ? binding.getVariable(n) : null }
def rows(v) { return (v instanceof List) ? v : [] }
def p(row, String k) { return ((Map) row?.properties)?.get(k) }

int hopNo = ((Number) hop).intValue()
int want = ((Number) levels).intValue()

Set seen = new LinkedHashSet()
for (v in rows(opt('seatIds'))) if (v != null) seen << String.valueOf(v)
// seatIds arrives as the sentinel list when there are no seats; it must not become a key.
seen.remove('__none__')

Set ancestors = new LinkedHashSet()
Set frontier = new LinkedHashSet()
for (name in ['hier1', 'hier2', 'hier3', 'hier4']) {
    def bound = opt(name)
    if (bound == null) continue
    frontier = new LinkedHashSet()          // only the LAST bound hop defines the frontier
    for (h in rows(bound)) {
        def parent = p(h, 'parentPositionId')
        if (parent == null) continue
        String s = String.valueOf(parent)
        ancestors << s
        if (!seen.contains(s)) frontier << s
    }
    seen.addAll(ancestors)
}

// The parents this hop found are level-`hopNo` ancestors; their parents are level hopNo+1.
boolean moreWanted = !frontier.isEmpty() && want > hopNo
List front = frontier.isEmpty() ? ['__none__'] : new ArrayList(frontier)
return [
    frontier   : front,
    next       : moreWanted && hopNo < 4,
    // A rule wants a level beyond the fourth and the tree still climbs: the walk did not
    // finish. Reported by the fold as HIERARCHY_TOO_DEEP rather than dropping the top.
    deeper     : moreWanted && hopNo >= 4,
    ancestors  : ancestors.isEmpty() ? ['__none__'] : new ArrayList(ancestors),
    count      : seen.size(),
]
