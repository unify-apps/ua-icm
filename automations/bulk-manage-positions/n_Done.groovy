// Did every planned write land?
//
// A bulk upsert answers `success: false` for an EMPTY batch and `success: true` with a
// zero count for a malformed one (notes/runtime-facts.md, 2026-08-25), so its flag says
// nothing. The count against what n_Plan meant to write is the only honest signal.
def arg = { String k -> binding.hasVariable(k) ? binding.getVariable(k) : null }
def n = { v -> (v == null || String.valueOf(v).trim().isEmpty()) ? 0 : new BigDecimal(String.valueOf(v).trim()).intValue() }
def txt = { v -> (v == null) ? '' : String.valueOf(v) }

List gaps = []
[['positions', 'posCount', 'posExpected'],
 ['title rows', 'attrCount', 'attrExpected'],
 ['assignments', 'asgCount', 'asgExpected']].each { t ->
    int got = n(arg(t[1]))
    int meant = n(arg(t[2]))
    if (got != meant) gaps << (t[0] + ' ' + got + ' of ' + meant)
}

boolean ok = gaps.isEmpty()
return [status: ok ? txt(arg('planStatus')) : 'WRITE_INCOMPLETE',
        message: ok ? txt(arg('planMessage'))
                    : ('Some rows did not land (' + gaps.join('; ') + '). Upload the same file again - rows already written come back unchanged.'),
        written: ok ? n(arg('writtenRows')) : 0]
