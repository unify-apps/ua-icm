// The payout rules those plans list. `Plan.payoutRules` holds BUSINESS keys, so the Rule
// fetch filters on properties.ruleId. A key no Rule carries is reported by the fold as
// RULE_MISSING against the credits it would have paid.

def rows(v) { return (v instanceof List) ? v : [] }
def p(row, String k) { return ((Map) row?.properties)?.get(k) }

Set keys = new LinkedHashSet()
for (r in rows(planRows)) {
    def list = p(r, 'payoutRules')
    Collection parts = list instanceof Collection ? (Collection) list : (list == null ? [] : String.valueOf(list).split(',') as List)
    for (k in parts) if (k != null && !String.valueOf(k).trim().isEmpty()) keys << String.valueOf(k).trim()
}
return [ruleIds: keys.isEmpty() ? ['__none__'] : new ArrayList(keys), count: keys.size()]
