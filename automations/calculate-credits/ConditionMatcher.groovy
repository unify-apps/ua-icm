// ICM | Condition Matcher
//
// The calculation engine's rule-resolution core. Decides whether one Rule's
// `conditions` apply to one row of facts. PURE: no I/O, no platform calls, no
// clock, no randomness — which is what lets it be proved against a case table
// in a single code node instead of only against a seeded environment.
//
// Spec, and the reasoning behind every edge: engine/condition-grammar.md
// Authoring dual:  app/src/components/plan/condition-namespace.ts
// The two are bound by engine/condition-namespace.test.ts — edit one and that test fails.
//
// This file is the SOURCE OF TRUTH. The platform copy lives in a code node; when
// they disagree, this is right and the node is stale.

import java.math.BigDecimal

class ConditionMatcher {

    /** The complete operator set. Anything else is reported, never evaluated. */
    static final List OPERATORS = ['==', '!=', '>', '>=', '<', '<=', 'in']

    /**
     * Subject -> kind, mirrored from condition-namespace.ts. A subject that is not
     * here cannot be evaluated: it would read as nothing and match nothing, which
     * is the silent failure this map exists to turn into a reported one.
     *
     * `txn.attrs.<key>` is the one open-ended subject (the form types the key
     * beside the picker), so it is matched by prefix rather than listed.
     */
    static final Map KINDS = [
        // credit stage — reads the incoming deal, the seat, the person
        'txn.amount'         : 'number',
        'txn.product'        : 'string',
        'txn.customer'       : 'string',
        'txn.close_date'     : 'date',
        // payout stage — reads what the credit stage produced
        'credit.amount'      : 'number',
        'credit.credit_type' : 'string',
        'credit.close_date'  : 'date',
        'credit.is_rollup'   : 'boolean',
        'credit.product'     : 'string',
        'credit.customer'    : 'string',
        'attainment.pct'     : 'number',
        'attainment.measure' : 'string',
        'period.type'        : 'enum',
        // both stages
        'position.title'     : 'string',
        'position.territory' : 'string',
        'payee.currency'     : 'string',
        'payee.hire_date'    : 'date',
    ]

    static String kindOf(String subject) {
        if (subject == null) return null
        if (KINDS.containsKey(subject)) return KINDS[subject]
        if (subject.startsWith('txn.attrs.') && subject.length() > 'txn.attrs.'.length()) return 'string'
        return null
    }

    /** Which operators are meaningful on a kind. `>` on a boolean is not a filter anyone meant. */
    static List operatorsFor(String kind) {
        if (kind == 'number' || kind == 'date') return ['==', '!=', '>', '>=', '<', '<=']
        if (kind == 'boolean') return ['==', '!=']
        return ['==', '!=', 'in']
    }

    /**
     * Money and any other number. Never Double: a storage `number` comes back as
     * BigDecimal below 10^7 and Double at or above it, and Groovy promotes
     * BigDecimal + Double to Double — so one large row silently poisons the rest.
     * See ua-icm docs/model/money-and-time.md.
     */
    static BigDecimal dec(v) {
        if (v == null) return null
        if (v instanceof BigDecimal) return v
        try { return new BigDecimal(String.valueOf(v).trim()) } catch (Exception e) { return null }
    }

    /** Epoch millis from a number, a numeric string, or a bare YYYY-MM-DD (midnight UTC). */
    static Long epoch(v) {
        if (v == null) return null
        if (v instanceof Number) return ((Number) v).longValue()
        String s = String.valueOf(v).trim()
        if (s ==~ /^-?\d+$/) return Long.parseLong(s)
        if (s ==~ /^\d{4}-\d{2}-\d{2}$/) {
            return java.time.LocalDate.parse(s).atStartOfDay(java.time.ZoneOffset.UTC).toInstant().toEpochMilli()
        }
        return null
    }

    /**
     * Compare one actual against one authored string, in the subject's kind.
     * Returns an Integer (-1/0/1), or null when either side will not coerce —
     * null is "cannot answer", and the caller turns it into a reported error
     * rather than a false.
     */
    static Integer compareIn(String kind, actual, String expected) {
        if (kind == 'number') {
            BigDecimal a = dec(actual), b = dec(expected)
            return (a == null || b == null) ? null : Integer.valueOf(a.compareTo(b))
        }
        if (kind == 'date') {
            Long a = epoch(actual), b = epoch(expected)
            return (a == null || b == null) ? null : Integer.valueOf(a.compareTo(b))
        }
        if (kind == 'boolean') {
            String a = String.valueOf(actual).trim().toLowerCase()
            String b = expected.trim().toLowerCase()
            if (!(a in ['true', 'false']) || !(b in ['true', 'false'])) return null
            return Integer.valueOf(a == b ? 0 : 1)   // only == / != reach here
        }
        // string and enum: exact, case-sensitive, on purpose (see the spec)
        return Integer.valueOf(String.valueOf(actual).compareTo(expected))
    }

    /** `in` splits on commas; on a number subject the parts compare numerically. */
    static Boolean isIn(String kind, actual, String expected) {
        for (String part : expected.split(',', -1)) {
            Integer c = compareIn(kind, actual, part.trim())
            if (c == null) return null
            if (c == 0) return Boolean.TRUE
        }
        return Boolean.FALSE
    }

    /**
     * Evaluate every row and fold left. No precedence: `A Or B And C` is
     * `(A Or B) And C`, because the authoring UI has no brackets and inventing
     * precedence here would make the stored rule mean something the author never saw.
     *
     * Never throws. `error != null` means a row could not be evaluated — the
     * caller records an exception and skips the rule, and MUST NOT read the
     * false as a clean no-match.
     */
    static Map match(Map conditions, Map facts) {
        List trace = []
        List items = (conditions == null) ? null : (List) conditions.get('items')
        if (items == null || items.isEmpty()) {
            trace << 'no conditions — applies to everything'
            return [matched: true, error: null, trace: trace]
        }

        Map bag = (facts == null) ? [:] : facts
        Boolean acc = null

        for (int i = 0; i < items.size(); i++) {
            Map row = (Map) items[i]
            String subject   = row?.get('subject')
            String operator  = row?.get('operator')
            String expected  = row?.get('value') == null ? null : String.valueOf(row.get('value'))
            String connector = row?.get('connector') ?: (i == 0 ? 'If' : 'And')
            String where     = "condition ${i + 1}"

            String kind = kindOf(subject)
            if (kind == null)
                return fail(trace, "${where}: '${subject}' is not a field any rule can read")
            if (!OPERATORS.contains(operator))
                return fail(trace, "${where}: '${operator}' is not a supported operator")
            if (!operatorsFor(kind).contains(operator))
                return fail(trace, "${where}: ${operator} cannot be used on ${subject} (${kind})")
            if (expected == null || expected.trim().isEmpty())
                return fail(trace, "${where}: ${subject} ${operator} has no value to compare against")

            // A fact that is absent or null is UNKNOWN, not false. Returning false
            // here would read as "this rule does not apply", which nobody
            // investigates — and the person is quietly underpaid.
            if (!bag.containsKey(subject) || bag.get(subject) == null)
                return fail(trace, "${where}: no value supplied for '${subject}'")

            def actual = bag.get(subject)
            Boolean r

            if (operator == 'in') {
                r = isIn(kind, actual, expected)
            } else {
                Integer c = compareIn(kind, actual, expected)
                if (c == null) r = null
                else if (operator == '==') r = (c == 0)
                else if (operator == '!=') r = (c != 0)
                else if (operator == '>')  r = (c > 0)
                else if (operator == '>=') r = (c >= 0)
                else if (operator == '<')  r = (c < 0)
                else r = (c <= 0)
            }

            if (r == null)
                return fail(trace, "${where}: cannot compare ${subject} (${kind}) against '${expected}' — actual was '${actual}'")

            trace << "${connector} ${subject} ${operator} '${expected}' -> ${r} (actual '${actual}')".toString()

            if (acc == null) acc = (connector == 'Not') ? !r : r
            else if (connector == 'Or')  acc = acc || r
            else if (connector == 'Not') acc = acc && !r
            else acc = acc && r
        }

        return [matched: acc.booleanValue(), error: null, trace: trace]
    }

    private static Map fail(List trace, String message) {
        trace << ("REFUSED: " + message).toString()
        return [matched: false, error: message, trace: trace]
    }
}
