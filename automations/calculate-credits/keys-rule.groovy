// Stage 7 -> 8: the credit rules those plans actually list.
//
// `Plan.creditRules` holds BUSINESS keys ("TEST-NA-CR-RENEWAL"), not record ids, so the
// Rule fetch filters on `properties.ruleId` - which already carries a unique index and
// therefore draws no index warning, unlike the `id IN` fetches upstream.
//
// A plan pointing at a ruleId no Rule record has is left to the fold to report as
// RULE_MISSING against the deals it would have credited. Dropping it here would lose
// which plan asked for it.

def rows(v) { return (v instanceof List) ? v : [] }
def p(row, String k) { return ((Map) row?.properties)?.get(k) }

Set keys = new LinkedHashSet()
for (r in rows(planRows)) {
    def list = p(r, 'creditRules')
    if (!(list instanceof List)) continue
    for (k in list) if (k != null) keys << String.valueOf(k)
}
return [ruleIds: keys.isEmpty() ? ['__none__'] : new ArrayList(keys), count: keys.size()]
