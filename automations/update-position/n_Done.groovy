// Did every planned write land?
//
// A bulk upsert answers `success: false` for an EMPTY batch and `success: true` with a
// zero count for a malformed one (notes/runtime-facts.md, 2026-08-25), so its flag says
// nothing. The count against what n_Plan meant to write is the only honest signal.
def arg = { String k -> binding.hasVariable(k) ? binding.getVariable(k) : null }
def n = { v -> (v == null || String.valueOf(v).trim().isEmpty()) ? 0 : new BigDecimal(String.valueOf(v).trim()).intValue() }

List gaps = []
[['position', 'posCount', 'posExpected'],
 ['title row', 'attrCount', 'attrExpected'],
 ['assignment', 'asgCount', 'asgExpected']].each { t ->
    int got = n(arg(t[1]))
    int meant = n(arg(t[2]))
    if (got != meant) gaps << (t[0] + ' ' + got + ' of ' + meant)
}
// `count` is what delete_records reports. Compared only when the node answered one, so a
// response without the key never turns a clean run into a false alarm.
if (arg('delCount') != null && n(arg('delCount')) != n(arg('delExpected'))) {
    gaps << ('removed assignment ' + n(arg('delCount')) + ' of ' + n(arg('delExpected')))
}

return [ok: gaps.isEmpty(),
        message: gaps.isEmpty() ? '' : ('Some changes did not land (' + gaps.join('; ') + '). Reopen the position to see what is stored - a retry plans again from that.')]
