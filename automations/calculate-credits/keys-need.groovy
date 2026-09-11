// Stage 8 -> 9: what the RULES actually need read, and nothing else.
//
// Until the rules are known, every remaining read is a guess. Once they are, each one is
// either proven necessary or skipped entirely - a skipped read is a round trip that never
// happens, which is the only kind of fetch that costs nothing:
//
//   CreditType     only the codes the rules file credits under (creditType, rollupCreditType)
//   Territory      only if some condition asks about `position.territory`
//   Currency       only if some condition asks about `payee.currency`
//   hierarchy      only if some rule rolls up, and only as many hops as its rollupLevels
//
// The same rows are then read the same way they always were, so the fold's answer does not
// change - only the number of calls that produced its inputs.

def rows(v) { return (v instanceof List) ? v : [] }
def p(row, String k) { return ((Map) row?.properties)?.get(k) }
def nn = { Set s -> s.isEmpty() ? ['__none__'] : new ArrayList(s) }

/** Mirrors CreditPass.levelsFrom, which is what the walk will actually honour. */
int levelsFrom(def raw) {
    if (raw == null) return 0
    String t = String.valueOf(raw).trim()
    if (t.equalsIgnoreCase('All ancestors')) return 100
    try { return Integer.parseInt(t) } catch (Exception e) { return 0 }
}

Set ctCodes = new LinkedHashSet()
boolean wantsTerritory = false
boolean wantsCurrency = false
int maxLevels = 0

for (r in rows(ruleRows)) {
    // Same admission test as the fold: a Rule it would ignore must not buy a read.
    if (p(r, 'ruleId') == null || p(r, 'stage') != 'credit') continue

    def cond = p(r, 'conditions')
    String text = cond == null ? '' : groovy.json.JsonOutput.toJson(cond)
    if (text.contains('position.territory')) wantsTerritory = true
    if (text.contains('payee.currency')) wantsCurrency = true

    Map values = (Map) (((Map) p(r, 'result'))?.values ?: [:])
    if (values.creditType != null) ctCodes << String.valueOf(values.creditType)
    if (String.valueOf(values.rollup) == 'true') {
        if (values.rollupCreditType != null) ctCodes << String.valueOf(values.rollupCreditType)
        maxLevels = Math.max(maxLevels, levelsFrom(values.rollupLevels))
    }
}

Set terrIds = new LinkedHashSet()
for (a in rows(attrRows)) { def v = p(a, 'territoryId'); if (v != null) terrIds << String.valueOf(v) }
Set ccyIds = new LinkedHashSet()
for (y in rows(payeeRows)) { def v = p(y, 'currencyId'); if (v != null) ccyIds << String.valueOf(v) }

int seats = ((Number) seatCount).intValue()
return [
    creditTypeCodes: nn(ctCodes),     readCreditTypes: !ctCodes.isEmpty(),
    territoryIds   : nn(terrIds),     readTerritories: wantsTerritory && !terrIds.isEmpty(),
    currencyIds    : nn(ccyIds),      readCurrencies : wantsCurrency && !ccyIds.isEmpty(),
    maxLevels      : maxLevels,       readLine       : maxLevels > 0 && seats > 0,
]
