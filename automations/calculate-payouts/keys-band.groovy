// RateTableBand.rateTableId is a foreign key to the RateTable RECORD, while a rule names
// the table by its business key - so the bands are read by the record ids found here.

def rows(v) { return (v instanceof List) ? v : [] }

Set ids = new LinkedHashSet()
for (r in rows(rtRows)) if (r?.id != null) ids << String.valueOf(r.id)
return [rateTableRecordIds: ids.isEmpty() ? ['__none__'] : new ArrayList(ids), count: ids.size()]
