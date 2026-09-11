// Does any rule need the tiered reads, and which rows exactly.
//
// A period whose plans only pay flat rates never reads a measure, a quota or a rate table:
// the branch lane in front of those reads stays closed.

def rows(v) { return (v instanceof List) ? v : [] }
def p(row, String k) { return ((Map) row?.properties)?.get(k) }
def nn = { Set s -> s.isEmpty() ? ['__none__'] : new ArrayList(s) }

Set measures = new LinkedHashSet(), tables = new LinkedHashSet(), quotas = new LinkedHashSet()
for (r in rows(ruleRows)) {
    if (p(r, 'stage') != 'payout') continue
    Map values = (Map) (((Map) p(r, 'result'))?.values ?: [:])
    if (String.valueOf(values.rateType).trim() != 'Tiered') continue
    def m = values.measureId;   if (m != null && !String.valueOf(m).trim().isEmpty()) measures << String.valueOf(m).trim()
    def t = values.rateTableId; if (t != null && !String.valueOf(t).trim().isEmpty()) tables << String.valueOf(t).trim()
    def q = values.quotaId;     if (q != null && !String.valueOf(q).trim().isEmpty()) quotas << String.valueOf(q).trim()
}
return [measureIds: nn(measures), rateTableIds: nn(tables), quotaIds: nn(quotas),
        readTiered: !measures.isEmpty() || !tables.isEmpty()]
