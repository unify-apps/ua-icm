// ICM | Credit Pass — name-driven
//
// Transactions in, Credit rows out. PURE: every lookup arrives already fetched and
// already indexed, so this holds no opinion about how records are read and can be
// proved against a case table.
//
// It differs from engine/CreditPass.groovy in the Sales-Commission-Management repo
// in ONE deliberate way, and the difference is the reason this file exists: that one
// enters at `transaction.positionId`, this one enters at a PAYEE NAME. The source
// export carries "Team Member: Full Name" and no position id, so a pass that demands
// a resolved seat cannot read the data the product actually receives.
//
// Two more decisions, both from the same source data:
//
//  - The SPLIT is a fact on the transaction, not only a number on the rule. The export
//    carries `Percent (%)` per row. A rule's `splitBps` OVERRIDES it; absent, the
//    source split stands; absent from both, 100%.
//  - Splits are NOT normalised to 100%. Order 00388125 credits one row at 100% and
//    another at 70%. Summing to more than 100% is overlay crediting, not corruption.
//
// Runs AFTER ConditionMatcher in the same node — it calls ConditionMatcher.match.

import java.math.BigDecimal
import java.math.RoundingMode

class CreditPass {

    static final BigDecimal BPS = new BigDecimal('10000')

    /** Effective-dated row live at an instant. Absent bound = open in that direction. */
    static boolean live(row, long asOf) {
        def s = row?.effectiveStart ?: row?.startDate ?: row?.activeStart
        def e = row?.effectiveEnd   ?: row?.endDate   ?: row?.activeEnd
        if (s != null && asOf < ((Number) s).longValue()) return false
        if (e != null && asOf > ((Number) e).longValue()) return false
        return true
    }

    /** Every dated row live at asOf. Two is not one — the caller decides if that is ambiguity. */
    static List liveRows(List rows, long asOf) {
        if (rows == null) return []
        return rows.findAll { live(it, asOf) }
    }

    static BigDecimal dec(v) { return ConditionMatcher.dec(v) }

    /** A name as a lookup key: trimmed, collapsed whitespace, lower case. */
    static String key(String s) {
        if (s == null) return null
        String t = s.trim().replaceAll(/\s+/, ' ').toLowerCase()
        return t.isEmpty() ? null : t
    }

    /**
     * Walk up the reporting line, collecting the seats to roll a credit into.
     *
     * Ends quietly on no parent, an unknown seat, or the level budget. None of those
     * is an error: a deal closed by someone reporting to nobody is a normal
     * top-of-tree deal, and failing it would fail every VP's own bookings.
     *
     * `seen` breaks a cycle rather than trusting the data not to have one.
     */
    static List ancestors(String positionId, Map parentByPosition, long asOf, int levels) {
        List out = []
        Set seen = [positionId] as Set
        String cur = positionId
        for (int i = 0; i < levels; i++) {
            List up = liveRows((List) parentByPosition[cur], asOf)
            if (up.isEmpty()) break
            String parent = up[0].parentPositionId
            if (parent == null || seen.contains(parent)) break
            out << parent
            seen << parent
            cur = parent
        }
        return out
    }

    /** `rollupLevels` as authored: '1'..'3', or 'All ancestors'. */
    static int levelsFrom(String raw) {
        if (raw == null) return 0
        String t = raw.trim()
        if (t.equalsIgnoreCase('All ancestors')) return 100
        try { return Integer.parseInt(t) } catch (Exception e) { return 0 }
    }

    /** An ObjectId-shaped record id, minted here so a parent and its children can be
     *  written in ONE batch with the FK between them already resolved. */
    static String mintId(Random rnd) {
        StringBuilder sb = new StringBuilder('e_')
        for (int i = 0; i < 24; i++) sb.append(Integer.toHexString(rnd.nextInt(16)))
        return sb.toString()
    }

    /**
     * The facts a credit rule is evaluated against. Keys are the subject paths in
     * condition-namespace.ts — this map IS the credit half of that namespace, and a
     * subject the matcher knows but this never supplies becomes a RULE_REFUSED rather
     * than a silent false.
     *
     * `position.title` carries the CODE, because that is what a rule stores.
     */
    static Map facts(Map txn, String titleCode, String territoryCode, Map payee) {
        Map f = [
            'txn.amount'         : txn.amount,
            'txn.product'        : txn.product,
            'txn.customer'       : txn.customer,
            'txn.close_date'     : txn.closeDate,
            'position.title'     : titleCode,
            'position.territory' : territoryCode,
            'payee.currency'     : payee?.currencyCode,
            'payee.hire_date'    : payee?.hireDate,
        ]
        def attrs = txn.attrs
        if (attrs instanceof Map) attrs.each { k, v -> f['txn.attrs.' + k] = v }
        return f
    }

    /** Does this plan assignment name this seat? The data carries BOTH record ids and
     *  business codes in `targetId`/`positionId`, so both are accepted — see the spec. */
    static boolean namesPosition(Map a, String posId, String posCode) {
        for (v in [a.targetId, a.positionId]) {
            if (v == null) continue
            String s = String.valueOf(v)
            if (s == posId || (posCode != null && s == posCode)) return true
        }
        return false
    }

    static boolean namesTitle(Map a, String titleId, String titleCode) {
        for (v in [a.targetId, a.titleId]) {
            if (v == null) continue
            String s = String.valueOf(v)
            if (s == titleId || (titleCode != null && s == titleCode)) return true
        }
        return false
    }

    /**
     * The pass. Never throws: an undecidable transaction lands in `exceptions` and the
     * fold continues, because one unresolvable seat must not stop a quarter.
     */
    static Map run(List transactions, Map ctx) {
        List credits = []
        List exceptions = []
        int matched = 0, rolled = 0, unmatched = 0

        Map payeeIdsByName     = ctx.payeeIdsByName     ?: [:]
        Map payeeById          = ctx.payeeById          ?: [:]
        Map seatsByPayee       = ctx.seatsByPayee       ?: [:]
        Map attrByPosition     = ctx.attrByPosition     ?: [:]
        Map parentByPosition   = ctx.parentByPosition   ?: [:]
        Map occupantByPosition = ctx.occupantByPosition ?: [:]
        Map titleCodeById      = ctx.titleCodeById      ?: [:]
        Map territoryCodeById  = ctx.territoryCodeById  ?: [:]
        Map positionCodeById   = ctx.positionCodeById   ?: [:]
        Map creditTypeIdByCode = ctx.creditTypeIdByCode ?: [:]
        Map plansById          = ctx.plansById          ?: [:]
        Map rulesByRuleId      = ctx.rulesByRuleId      ?: [:]
        List assignments       = (List) (ctx.assignments ?: [])
        Random rnd             = new Random(((Number) (ctx.seed ?: 42L)).longValue())

        def refuse = { Map t, String code, String detail ->
            exceptions << [transactionId: t.transactionId, payeeName: t.payeeName,
                           positionId: t.positionId, code: code, detail: detail]
        }

        // A plan reaches a deal only if it is Active AND in force on the date.
        def planUsable = { String planKey, long asOf ->
            Map p = (Map) plansById[planKey]
            if (p == null) return false
            if (p.status != 'Active') return false
            return live(p, asOf)
        }

        for (Map t : transactions) {
            def when = t.incentiveDate ?: t.closeDate
            if (when == null) { refuse(t, 'NO_DATE', 'neither incentiveDate nor closeDate is set'); continue }
            long asOf = ((Number) when).longValue()

            // --- name -> payee -------------------------------------------------
            String nameKey = key((String) t.payeeName)
            if (nameKey == null) { refuse(t, 'NO_PAYEE_NAME', 'the row names nobody to pay'); continue }
            List hits = (List) (payeeIdsByName[nameKey] ?: [])
            if (hits.isEmpty()) { refuse(t, 'UNRESOLVED_PAYEE', "no Payee is named '${t.payeeName}'"); continue }
            if (hits.size() > 1) { refuse(t, 'AMBIGUOUS_PAYEE', "${hits.size()} payees are named '${t.payeeName}'"); continue }
            String payeeId = (String) hits[0]
            Map payee = (Map) (payeeById[payeeId] ?: [:])

            // --- payee -> seat, as of the date ---------------------------------
            List seats = liveRows((List) seatsByPayee[payeeId], asOf)
            if (seats.isEmpty()) { refuse(t, 'NO_POSITION', "${t.payeeName} held no position on ${asOf}"); continue }
            if (seats.size() > 1) { refuse(t, 'AMBIGUOUS_POSITION', "${t.payeeName} held ${seats.size()} positions on ${asOf}"); continue }
            String pos = (String) seats[0].positionId
            String posCode = (String) positionCodeById[pos]
            t.positionId = pos

            // --- seat -> title, as of the date ---------------------------------
            List attrs = liveRows((List) attrByPosition[pos], asOf)
            String titleId   = attrs.isEmpty() ? null : (String) attrs[0].titleId
            String titleCode = titleId == null ? null : (String) titleCodeById[titleId]
            String terrCode  = attrs.isEmpty() ? null : (String) territoryCodeById[attrs[0].territoryId]

            // --- plan: the SEAT is asked first, then the TITLE ------------------
            // The seat is the more specific statement about this deal, so a plan
            // assigned to it beats one assigned to everyone carrying its title.
            // Only an ACTIVE, in-force plan wins the seat lane; an expired seat plan
            // must not shadow a title plan that is live.
            Map hit = assignments.find { a ->
                live(a, asOf) && a.targetType == 'Position' && namesPosition(a, pos, posCode) && planUsable(a.planKey, asOf)
            }
            String lane = 'Position'
            if (hit == null) {
                if (titleId == null) { refuse(t, 'NO_TITLE', "seat ${posCode ?: pos} had no title on ${asOf}"); continue }
                lane = 'Title'
                hit = assignments.find { a ->
                    live(a, asOf) && a.targetType == 'Title' && namesTitle(a, titleId, titleCode) && planUsable(a.planKey, asOf)
                }
            }
            if (hit == null) {
                refuse(t, 'NO_PLAN', "no active plan covers seat ${posCode ?: pos} or title ${titleCode ?: '(none)'} on ${asOf}")
                continue
            }

            Map plan = (Map) plansById[hit.planKey]
            Map f = facts(t, titleCode, terrCode, payee)
            boolean anyMatched = false

            for (Object rk : (List) (plan.creditRules ?: [])) {
                String ruleKey = String.valueOf(rk)
                Map rule = (Map) rulesByRuleId[ruleKey]
                if (rule == null) { refuse(t, 'RULE_MISSING', "plan ${plan.planId} points at rule ${ruleKey}, which does not exist"); continue }
                if (!live(rule, asOf)) continue          // out of force, not a failure

                Map m = ConditionMatcher.match((Map) rule.conditions, f)
                if (m.error != null) { refuse(t, 'RULE_REFUSED', "rule ${ruleKey}: ${m.error}"); continue }
                if (!m.matched) continue                  // did not apply — the normal case

                Map values = (Map) ((Map) rule.result)?.values ?: [:]

                // The rule OVERRIDES the source split; absent, the row's own split
                // stands; absent from both, the whole deal. Never a guess at 0.
                def rawSplit = values.splitBps != null ? values.splitBps : t.sourceSplitBps
                BigDecimal split = rawSplit == null ? BPS : dec(rawSplit)
                if (split == null) { refuse(t, 'BAD_SPLIT', "rule ${ruleKey} / row split is '${rawSplit}'"); continue }

                String ctCode = values.creditType == null ? null : String.valueOf(values.creditType)
                String ctId = ctCode == null ? null : (String) creditTypeIdByCode[ctCode]
                if (ctCode != null && ctId == null) {
                    refuse(t, 'UNKNOWN_CREDIT_TYPE', "rule ${ruleKey} files credits under '${ctCode}', which is not a CreditType")
                    continue
                }

                anyMatched = true
                matched++
                String creditId = mintId(rnd)
                credits << [
                    id: creditId, transactionId: t.recordId, employeeId: payeeId, positionId: pos,
                    creditRuleId: rule.recordId, creditTypeId: ctId, creditTypeCode: ctCode,
                    amount: money(dec(t.amount), split), splitBps: split.toPlainString(),
                    isRollup: false, sourceCreditId: null, hierarchyLevel: 0,
                    planId: plan.planId, ruleId: ruleKey, lane: lane,
                    payeeName: t.payeeName, orderNumber: t.orderNumber, trace: m.trace,
                ]

                if (String.valueOf(values.rollup) != 'true') continue

                def rawRoll = values.rollupSplitBps
                BigDecimal rollSplit = rawRoll == null ? split : dec(rawRoll)
                if (rollSplit == null) { refuse(t, 'BAD_SPLIT', "rule ${ruleKey} has rollupSplitBps '${rawRoll}'"); continue }
                String rollCode = values.rollupCreditType == null ? ctCode : String.valueOf(values.rollupCreditType)
                String rollId = rollCode == null ? null : (String) creditTypeIdByCode[rollCode]
                if (rollCode != null && rollId == null) {
                    refuse(t, 'UNKNOWN_CREDIT_TYPE', "rule ${ruleKey} rolls up under '${rollCode}', which is not a CreditType")
                    continue
                }

                int level = 0
                for (String up : ancestors(pos, parentByPosition, asOf, levelsFrom((String) values.rollupLevels))) {
                    level++
                    // Eligibility is NOT checked here, on purpose. A rep on leave or
                    // just terminated still generates the manager's rolled credit;
                    // whether THEY are paid is a payout-stage question.
                    List upOcc = liveRows((List) occupantByPosition[up], asOf)
                    if (upOcc.size() != 1) continue       // vacant or contested manager seat: skip quietly
                    rolled++
                    credits << [
                        id: mintId(rnd), transactionId: t.recordId, employeeId: upOcc[0].payeeId, positionId: up,
                        creditRuleId: rule.recordId, creditTypeId: rollId, creditTypeCode: rollCode,
                        amount: money(dec(t.amount), rollSplit), splitBps: rollSplit.toPlainString(),
                        isRollup: true, sourceCreditId: creditId, hierarchyLevel: level,
                        planId: plan.planId, ruleId: ruleKey, lane: lane,
                        payeeName: t.payeeName, orderNumber: t.orderNumber, trace: m.trace,
                    ]
                }
            }
            if (!anyMatched) unmatched++
        }

        return [
            credits: credits, exceptions: exceptions,
            stats: [transactions: transactions.size(), matched: matched, rolledUp: rolled,
                    unmatched: unmatched, refused: exceptions.size(), credits: credits.size()],
        ]
    }

    /**
     * amount x split, in MINOR UNITS.
     *
     * `Credit.amount` is an `integer` column, so a fraction of a paisa cannot be
     * stored and this is a rounding point. credit-pass.md says the credit pass must
     * not round — the single rounding point belongs at payout. The column is why it
     * does anyway; HALF_UP matches money-and-time.md, and the divergence is recorded
     * in the spec rather than hidden here.
     */
    static Long money(BigDecimal amount, BigDecimal splitBps) {
        if (amount == null) return null
        return amount.multiply(splitBps).divide(BPS).setScale(0, RoundingMode.HALF_UP).longValue()
    }
}
