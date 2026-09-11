// The end of the reporting-line walk: every ancestor seat the hops that RAN revealed.
//
// Between one and four hops ran, decided by the rules' rollupLevels, so any of hier2..4
// may never have executed. A pill to a node that never ran does not arrive as null - the
// binding is missing - so every one is read through `binding.hasVariable`.

def opt = { String n -> binding.hasVariable(n) ? binding.getVariable(n) : null }
def rows(v) { return (v instanceof List) ? v : [] }
def p(row, String k) { return ((Map) row?.properties)?.get(k) }

// EVERY parent, including one that is also a crediting seat. The seat-keyed occupant read
// was keyed by PAYEE, so it only returned this period's payees - another person who held
// that manager seat inside the window is only found by asking for the seat itself.
Set ancestors = new LinkedHashSet()
for (name in ['hier1', 'hier2', 'hier3', 'hier4']) {
    for (h in rows(opt(name))) {
        def parent = p(h, 'parentPositionId')
        if (parent != null) ancestors << String.valueOf(parent)
    }
}

def deeper = opt('deeper')
return [ancestors: ancestors.isEmpty() ? ['__none__'] : new ArrayList(ancestors),
        count    : ancestors.size(),
        deeper   : deeper instanceof Boolean ? deeper : String.valueOf(deeper) == 'true']
