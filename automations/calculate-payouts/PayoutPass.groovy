// ICM | Payout Pass — credits in, Earning and MeasureResult rows out.
//
// PURE: every lookup arrives already fetched and indexed. Runs AFTER ConditionMatcher and
// CreditPass in the same code node, and borrows CreditPass's effective-dating and
// assignment helpers (live, liveRows, namesPosition, namesTitle, mintId, dec).
//
// Two ways to calculate commission, chosen by Rule.result.values.rateType:
//
//   Flat rate  one Earning per (credit, rule):   credit.amount x rateBps / 10000
//   Tiered     one Earning per (payee, rule):    total of the payee's credits whose type is in
//              the attainment measure, divided by a quota, is the attainment; the rate
//              table tier it falls in gives the rate; total x rate is the commission.
//
// Deliberately NOT here yet: bonus, cliff, marginal tiering, percent of target, caps,
// YTD windows and true-up, eligibility hold. See docs/automations/calculate-payouts.md.
//
// Rounding happens exactly once per amount, HALF_UP, where a Long is produced. Everything
// before that is BigDecimal.

import java.math.BigDecimal
import java.math.RoundingMode

class PayoutPass {

    static final BigDecimal BPS = new BigDecimal('10000')

    static Long half(BigDecimal v) { return v == null ? null : v.setScale(0, RoundingMode.HALF_UP).longValue() }

    /**
     * A list of codes authored as a list, as "A, B", or as an OBJECT. `AttainmentMeasure.creditTypes`
     * is an untyped `object` column: an array written to it is silently stored as `{}` (probed
     * 2026-09-11), so a measure stores `{codes: [...]}`. `{items: [...]}` and `{CODE: true}` are
     * read too, because nothing else pins the shape yet.
     */
    static List codes(v) {
        List out = []
        if (v == null) return out
        if (v instanceof Map) {
            Map m = (Map) v
            def listed = m.codes != null ? m.codes : (m.items != null ? m.items : m.values)
            if (listed instanceof Collection || listed instanceof CharSequence) return codes(listed)
            for (Object k : m.keySet()) if (String.valueOf(m.get(k)) == 'true') out << String.valueOf(k)
            return out
        }
        Collection parts = (v instanceof Collection) ? (Collection) v : Arrays.asList(String.valueOf(v).split(','))
        for (Object part : parts) {
            if (part == null) continue
            String s = String.valueOf(part).trim()
            if (!s.isEmpty()) out << s
        }
        return out
    }

    /** The payout-stage half of the condition namespace: what a credit knows about itself. */
    static Map facts(Map c) {
        return [
            'credit.amount'     : c.amount,
            'credit.credit_type': c.creditTypeCode,
            'credit.close_date' : c.closeDate,
            'credit.is_rollup'  : c.isRollup ? 'true' : 'false',
            'credit.product'    : c.product,
            'credit.customer'   : c.customer,
        ]
    }

    /**
     * The credit's plan as of its date: the seat's own Active, in-force plan first, else
     * its title's. The same order Calculate Credits uses, COPIED rather than shared so the
     * credit automation's code never changes underneath it.
     */
    static Map planFor(Map c, long asOf, Map ctx) {
        Map plansById = (Map) (ctx.plansById ?: [:])
        List assignments = (List) (ctx.assignments ?: [])
        String pos = (String) c.positionId
        String posCode = (String) ((Map) (ctx.positionCodeById ?: [:]))[pos]
        def usable = { String key ->
            Map pl = (Map) plansById[key]
            return pl != null && pl.status == 'Active' && CreditPass.live(pl, asOf)
        }

        Map hit = (Map) assignments.find { Map a ->
            CreditPass.live(a, asOf) && a.targetType == 'Position' && CreditPass.namesPosition(a, pos, posCode) && usable((String) a.planKey)
        }
        String lane = 'Position'
        if (hit == null) {
            List attrs = CreditPass.liveRows((List) ((Map) (ctx.attrByPosition ?: [:]))[pos], asOf)
            String titleId = attrs.isEmpty() ? null : (String) attrs[0].titleId
            String titleCode = titleId == null ? null : (String) ((Map) (ctx.titleCodeById ?: [:]))[titleId]
            if (titleId == null) return [error: 'NO_PLAN', detail: "seat ${posCode ?: pos} had no title on ${asOf}".toString()]
            lane = 'Title'
            hit = (Map) assignments.find { Map a ->
                CreditPass.live(a, asOf) && a.targetType == 'Title' && CreditPass.namesTitle(a, titleId, titleCode) && usable((String) a.planKey)
            }
            if (hit == null) {
                return [error: 'NO_PLAN', detail: "no active plan covers seat ${posCode ?: pos} or title ${titleCode ?: titleId} on ${asOf}".toString()]
            }
        }
        return [plan: plansById[hit.planKey], lane: lane]
    }

    /** Bands must be sorted by fromPct already. Returns why they are unusable, or null. */
    static String invalidBands(List bands) {
        if (bands == null || bands.isEmpty()) return 'it has no tiers'
        for (int i = 0; i < bands.size(); i++) {
            Map b = (Map) bands[i]
            BigDecimal f = CreditPass.dec(b.fromPct), t = CreditPass.dec(b.toPct), v = CreditPass.dec(b.value)
            if (f == null || v == null) return "tier ${b.bandId} has no fromPct or value".toString()
            if (t == null && i != bands.size() - 1) return "tier ${b.bandId} has no toPct and is not the top tier".toString()
            if (t != null && f.compareTo(t) >= 0) return "tier ${b.bandId} runs from ${f} to ${t}".toString()
            if (i > 0) {
                Map prev = (Map) bands[i - 1]
                BigDecimal prevTo = CreditPass.dec(prev.toPct)
                int c = prevTo.compareTo(f)
                if (c < 0) return "gap between tier ${prev.bandId} (to ${prevTo}) and tier ${b.bandId} (from ${f})".toString()
                if (c > 0) return "tier ${prev.bandId} (to ${prevTo}) overlaps tier ${b.bandId} (from ${f})".toString()
            }
        }
        return null
    }

    /** fromPct inclusive, toPct exclusive; above the top tier stays in the top tier; below the lowest is null. */
    static Map tierFor(List bands, BigDecimal attainment) {
        if (attainment.compareTo(CreditPass.dec(((Map) bands[0]).fromPct)) < 0) return null
        for (Object o : bands) {
            Map b = (Map) o
            BigDecimal f = CreditPass.dec(b.fromPct), t = CreditPass.dec(b.toPct)
            if (attainment.compareTo(f) >= 0 && (t == null || attainment.compareTo(t) < 0)) return b
        }
        return (Map) bands[bands.size() - 1]
    }

    static Map run(List credits, Map ctx) {
        List earnings = []
        List measureResults = []
        List exceptions = []
        int flat = 0, tiered = 0
        Random rnd = new Random(((Number) (ctx.seed ?: 42L)).longValue())
        String periodId = (String) ctx.periodId
        long periodEnd = ((Number) ctx.periodEnd).longValue()
        Map rulesByRuleId = (Map) (ctx.rulesByRuleId ?: [:])
        Map groups = new TreeMap()

        def refuse = { Map c, String ruleKey, String code, String detail ->
            exceptions << [creditId: c?.creditId ?: '', employeeId: c?.employeeId ?: '', ruleId: ruleKey ?: '',
                           code: code, detail: detail]
        }

        List ordered = new ArrayList(credits)
        ordered.sort { a, b -> String.valueOf(a.creditId) <=> String.valueOf(b.creditId) }

        for (Map c : ordered) {
            if (c.asOf == null) { refuse(c, null, 'NO_DATE', "credit ${c.creditId}: its transaction has no incentive or close date".toString()); continue }
            if (c.amount == null) { refuse(c, null, 'NO_AMOUNT', "credit ${c.creditId} has no amount".toString()); continue }
            if (c.creditTypeCode == null) { refuse(c, null, 'UNKNOWN_CREDIT_TYPE', "credit ${c.creditId} has a credit type no CreditType row carries".toString()); continue }
            long asOf = ((Number) c.asOf).longValue()

            Map pf = planFor(c, asOf, ctx)
            if (pf.error != null) { refuse(c, null, (String) pf.error, (String) pf.detail); continue }
            Map plan = (Map) pf.plan
            Map f = facts(c)

            for (Object rk : codes(plan.payoutRules)) {
                String ruleKey = String.valueOf(rk)
                Map rule = (Map) rulesByRuleId[ruleKey]
                if (rule == null) { refuse(c, ruleKey, 'RULE_MISSING', "plan ${plan.planId} lists payout rule ${ruleKey}, which does not exist".toString()); continue }
                if (!CreditPass.live(rule, asOf)) continue      // out of force on the credit's date

                Map values = (Map) (((Map) rule.result)?.values ?: [:])
                String rateType = values.rateType == null ? '' : String.valueOf(values.rateType).trim()
                if (!(rateType in ['Flat rate', 'Tiered'])) {
                    refuse(c, ruleKey, 'UNSUPPORTED_RATE_TYPE', "rule ${ruleKey}: rateType '${rateType}' is neither Flat rate nor Tiered".toString())
                    continue
                }
                String payWhen = values.payWhen == null ? '' : String.valueOf(values.payWhen).trim()
                if (!payWhen.isEmpty() && payWhen != 'On close') {
                    refuse(c, ruleKey, 'UNSUPPORTED_PAY_WHEN', "rule ${ruleKey}: payWhen '${payWhen}' is not supported yet - only On close".toString())
                    continue
                }

                Map m = ConditionMatcher.match((Map) rule.conditions, f)
                if (m.error != null) { refuse(c, ruleKey, 'RULE_REFUSED', "rule ${ruleKey}: ${m.error}".toString()); continue }
                if (!m.matched) continue

                if (rateType == 'Flat rate') {
                    List types = codes(values.creditTypes)
                    if (!types.isEmpty() && !types.contains(c.creditTypeCode)) continue
                    BigDecimal rate = CreditPass.dec(values.rateBps)
                    if (rate == null) { refuse(c, ruleKey, 'RULE_REFUSED', "rule ${ruleKey}: rateBps '${values.rateBps}' is not a number".toString()); continue }
                    BigDecimal base = (BigDecimal) c.amount
                    Long amount = half(base.multiply(rate).divide(BPS))
                    flat++
                    earnings << [
                        earningId: CreditPass.mintId(rnd), rateType: rateType, componentKey: ruleKey, planId: plan.planId,
                        employeeId: c.employeeId, positionId: c.positionId, creditId: c.creditId, resultId: '',
                        transactionId: c.transactionId, orderNumber: c.orderNumber ?: '', creditType: c.creditTypeCode,
                        base: half(base), rateApplied: half(rate), bandHit: '', attainmentPct: 0L,
                        amount: amount, earnedToDate: amount, previouslyPaid: 0L,
                        holdStatus: 'Payable', periodId: periodId,
                        trace: [lane: pf.lane, conditions: m.trace],
                    ]
                } else {
                    String gk = c.employeeId + '|' + ruleKey
                    Map g = (Map) groups[gk]
                    if (g == null) {
                        g = [employeeId: c.employeeId, ruleKey: ruleKey, values: values, planId: plan.planId, lane: pf.lane, credits: []]
                        groups[gk] = g
                    }
                    ((List) g.credits) << c
                }
            }
        }

        // --- tiered: one decision per (payee, rule) -----------------------------------
        for (Object o : groups.values()) {
            Map g = (Map) o
            Map values = (Map) g.values
            String ruleKey = (String) g.ruleKey
            def refuseGroup = { String code, String detail ->
                exceptions << [creditId: '', employeeId: g.employeeId, ruleId: ruleKey, code: code, detail: detail]
            }

            String measureKey = values.measureId == null ? '' : String.valueOf(values.measureId).trim()
            Map measure = (Map) ((Map) (ctx.measuresByKey ?: [:]))[measureKey]
            if (measure == null) { refuseGroup('NO_MEASURE', "rule ${ruleKey}: attainment measure '${measureKey}' does not exist".toString()); continue }

            // A measure may name its credit types by code or by CreditType record id.
            Set measureTypes = new LinkedHashSet()
            for (Object t : codes(measure.creditTypes)) {
                measureTypes << String.valueOf(((Map) (ctx.creditTypeCodeById ?: [:]))[t] ?: t)
            }
            List included = ((List) g.credits).findAll { Map c -> measureTypes.contains(c.creditTypeCode) }
            BigDecimal total = BigDecimal.ZERO
            for (Object ic : included) total = total.add((BigDecimal) ((Map) ic).amount)

            List seatSource = included.isEmpty() ? (List) g.credits : included
            Map latest = (Map) seatSource.max { Map c -> ((Number) c.asOf).longValue() }
            String seat = (String) latest.positionId

            // --- quota: the rule's own, else the payee's -----------------------------------
            List quotas = (List) (ctx.quotas ?: [])
            Map quota = null
            String quotaKey = values.quotaId == null ? '' : String.valueOf(values.quotaId).trim()
            if (!quotaKey.isEmpty()) {
                List hits = quotas.findAll { Map q -> q.quotaId == quotaKey }
                if (hits.isEmpty()) { refuseGroup('NO_QUOTA', "rule ${ruleKey}: quota '${quotaKey}' does not exist".toString()); continue }
                quota = (Map) hits[0]
            } else {
                List candidates = quotas.findAll { Map q ->
                    q.positionId == seat && (q.measureId == measure.recordId || q.measureId == measure.measureId) && CreditPass.live(q, periodEnd)
                }
                List hits = []
                for (Object pid : (List) (ctx.coverPeriodIds ?: [periodId])) {
                    hits = candidates.findAll { Map q -> q.periodId == pid }
                    if (!hits.isEmpty()) break
                }
                if (hits.isEmpty()) {
                    refuseGroup('NO_QUOTA', "no quota on seat ${seat} for measure ${measure.measureId} covering ${ctx.periodName}".toString())
                    continue
                }
                if (hits.size() > 1) {
                    refuseGroup('AMBIGUOUS_QUOTA', "${hits.size()} quotas on seat ${seat} for measure ${measure.measureId} on the same period".toString())
                    continue
                }
                quota = (Map) hits[0]
            }
            BigDecimal quotaAmount = CreditPass.dec(quota.amount)
            if (quotaAmount == null || quotaAmount.signum() <= 0) {
                refuseGroup('NO_QUOTA', "quota ${quota.quotaId} has amount '${quota.amount}'".toString())
                continue
            }

            // --- rate table tier ------------------------------------------------------------
            String rtKey = values.rateTableId == null ? '' : String.valueOf(values.rateTableId).trim()
            Map rt = (Map) ((Map) (ctx.rateTablesByKey ?: [:]))[rtKey]
            if (rt == null || !CreditPass.live(rt, periodEnd)) {
                refuseGroup('NO_RATE_TABLE', "rule ${ruleKey}: rate table '${rtKey}' does not exist or is not in force".toString())
                continue
            }
            List bands = (List) rt.bands
            String bad = invalidBands(bands)
            if (bad != null) { refuseGroup('RATE_TABLE_INVALID', "rate table ${rtKey}: ${bad}".toString()); continue }

            BigDecimal attainment = total.multiply(BPS).divide(quotaAmount, 10, RoundingMode.HALF_UP)
            Map tier = tierFor(bands, attainment)
            if (tier == null) {
                refuseGroup('NO_TIER', "attainment ${attainment.setScale(2, RoundingMode.HALF_UP)} bps is below the lowest tier of ${rtKey}".toString())
                continue
            }
            BigDecimal rate = CreditPass.dec(tier.value)
            Long amount = half(total.multiply(rate).divide(BPS))

            String resultId = CreditPass.mintId(rnd)
            measureResults << [
                resultId: resultId, employeeId: g.employeeId, positionId: seat, measureId: measure.recordId,
                measureKey: measure.measureId, periodId: periodId, componentKey: ruleKey,
                creditTotal: half(total), quota: half(quotaAmount), attainmentPct: half(attainment),
            ]
            tiered++
            earnings << [
                earningId: CreditPass.mintId(rnd), rateType: 'Tiered', componentKey: ruleKey, planId: g.planId,
                employeeId: g.employeeId, positionId: seat, creditId: '', resultId: resultId,
                transactionId: '', orderNumber: '', creditType: measureTypes.join(','),
                base: half(total), rateApplied: half(rate), bandHit: String.valueOf(tier.label ?: tier.bandId),
                attainmentPct: half(attainment),
                amount: amount, earnedToDate: amount, previouslyPaid: 0L,
                holdStatus: 'Payable', periodId: periodId,
                trace: [lane: g.lane, measure: measure.measureId, quota: quota.quotaId, quotaPeriodId: quota.periodId,
                        rateTable: rtKey, tier: tier.bandId, credits: included.size()],
            ]
        }

        long sum = 0L
        for (Object e : earnings) sum += ((Number) ((Map) e).amount).longValue()
        return [
            earnings: earnings, measureResults: measureResults, exceptions: exceptions,
            stats: [credits: credits.size(), flatEarnings: flat, tieredEarnings: tiered,
                    measureResults: measureResults.size(), refused: exceptions.size(), total: sum],
        ]
    }
}
