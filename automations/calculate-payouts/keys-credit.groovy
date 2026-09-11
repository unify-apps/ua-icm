// The keys every later read is filtered by: the credits' transactions, seats and types.

def rows(v) { return (v instanceof List) ? v : [] }
def p(row, String k) { return ((Map) row?.properties)?.get(k) }
def nn = { Set s -> s.isEmpty() ? ['__none__'] : new ArrayList(s) }

int cap = ((Number) keyCap).intValue()
Set txns = new LinkedHashSet(), seats = new LinkedHashSet(), types = new LinkedHashSet()
for (r in rows(creditRows)) {
    def t = p(r, 'transactionId'); if (t != null) txns << String.valueOf(t)
    def s = p(r, 'positionId');    if (s != null) seats << String.valueOf(s)
    def c = p(r, 'creditTypeId');  if (c != null) types << String.valueOf(c)
}
return [transactionIds: nn(txns), positionIds: nn(seats), creditTypeIds: nn(types),
        count: rows(creditRows).size(),
        overflow: txns.size() > cap || seats.size() > cap]
