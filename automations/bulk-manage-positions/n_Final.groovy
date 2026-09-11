// The answer, whether or not the loop body ran.
//
// A file with a header and no rows never enters the loop, so n_Plan and n_Done never run
// and every pill that points at them resolves to nothing - an unbound variable here, not a
// null (notes/runtime-facts.md, 2026-09-10). Measured on tool 2026-09-11: without this
// node that file answered `{batchId}` and no status at all.
def arg = { String k -> binding.hasVariable(k) ? binding.getVariable(k) : null }
def txt = { v -> (v == null) ? '' : String.valueOf(v) }
def n = { v -> txt(v).trim().isEmpty() ? 0 : new BigDecimal(txt(v).trim()).intValue() }

boolean ran = !txt(arg('status')).isEmpty()
def rows = arg('rows')

return [status: ran ? txt(arg('status')) : 'INVALID_INPUT',
        message: ran ? txt(arg('message')) : 'The file has no positions in it.',
        applied: ran ? n(arg('applied')) : 0,
        written: ran ? n(arg('written')) : 0,
        rows: (ran && rows instanceof List) ? rows : []]
