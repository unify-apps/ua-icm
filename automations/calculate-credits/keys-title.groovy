// Stage 4 -> 5: the TITLE ids those seats carried in the window.
//
// Titles are fetched by id rather than whole because the title CODE is load-bearing - a
// rule stores `position.title == "T-AE"` and the seat stores a record id - so the wrong
// or missing code produces a rule that matches nothing and says nothing.

def rows(v) { return (v instanceof List) ? v : [] }
def p(row, String k) { return ((Map) row?.properties)?.get(k) }

Set titles = new LinkedHashSet()
Set terrs = new LinkedHashSet()
for (r in rows(attrRows)) {
    def t = p(r, 'titleId'); if (t != null) titles << String.valueOf(t)
    def y = p(r, 'territoryId'); if (y != null) terrs << String.valueOf(y)
}
return [titleIds: titles.isEmpty() ? ['__none__'] : new ArrayList(titles),
        territoryIds: terrs.isEmpty() ? ['__none__'] : new ArrayList(terrs),
        count: titles.size()]
