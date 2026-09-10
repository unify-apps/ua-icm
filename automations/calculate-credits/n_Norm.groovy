// Normalise the caller's inputs, and mint the run id.
//
// AN OMITTED INPUT IS AN UNBOUND VARIABLE, NOT A NULL. When a caller leaves `dryRun`
// out entirely, the START node has no such output, the parameter's expression resolves
// to nothing, and the script does not receive the variable at all - referencing it dies
// with `No such property: dryRun for class: Script_<hash>`. `?:` cannot save a name
// that was never bound, so every optional input is read through `binding.hasVariable`.
//
// This is the second half of the shared contract's input rule. That rule says real
// callers send EMPTY STRINGS for what they did not fill; they also sometimes send
// nothing at all, and the two fail in completely different places.
//
// An unusable periodId becomes a SENTINEL rather than an empty filter. The fetch
// downstream then keeps one property and one operator whatever the caller sent, which
// is what lets the builder draw its filter and the index analyser read it - an empty
// or absent filter would silently fetch every Period instead of none.

def opt = { String name -> binding.hasVariable(name) ? binding.getVariable(name) : null }

String pid = opt('periodId') == null ? '' : String.valueOf(opt('periodId')).trim()
boolean inputOk = !pid.isEmpty()

// "" is missing, not false. A caller that omits dryRun gets the SAFE answer: compute
// and report, write nothing. Writing pay is opt-in, never the default.
String dr = opt('dryRun') == null ? '' : String.valueOf(opt('dryRun')).trim().toLowerCase()
boolean dry = dr.isEmpty() ? true : (dr == 'true')

int limit = 1000
String pl = opt('pageLimit') == null ? '' : String.valueOf(opt('pageLimit')).trim()
if (!pl.isEmpty()) {
    try { limit = Integer.parseInt(pl) } catch (Exception e) { limit = 1000 }
}
if (limit < 1) limit = 1
if (limit > 5000) limit = 5000

// How many distinct keys one staged read's IN filter may carry. The reads are keyed on
// the previous stage's output, so this is the bound on the JOIN rather than on the page:
// a period touching more distinct payees than this needs calculating in chunks, and the
// fold refuses with KEY_SET_TOO_LARGE rather than sending a filter nobody sized.
int cap = 5000
String kc = opt('keyCap') == null ? '' : String.valueOf(opt('keyCap')).trim()
if (!kc.isEmpty()) {
    try { cap = Integer.parseInt(kc) } catch (Exception e) { cap = 5000 }
}
if (cap < 1) cap = 1
if (cap > 20000) cap = 20000

// The engine mints the run id; the caller cannot supply one. That is what makes the
// UNIQUE key on CalculationRun.runId un-hittable without a pre-check fetch, and the
// reason there is no pre-check node in this flow.
long now = System.currentTimeMillis()
String runId = 'RUN-' + now + '-' + Long.toHexString(new Random(now).nextInt(0x1000000))

return [
    periodId : inputOk ? pid : '__invalid_input__',
    inputOk  : inputOk,
    dryRun   : dry,
    pageLimit: limit,
    keyCap   : cap,
    runId    : runId,
    startedAt: now,
]
