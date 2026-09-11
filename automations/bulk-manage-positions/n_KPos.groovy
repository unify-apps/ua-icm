// The record ids of the positions this file names that already exist. The title-row and
// assignment reads are filtered by these, so they read this file's seats and nothing else.
List ids = []
((posRows instanceof List) ? posRows : []).each { p -> if (p?.id != null) ids << String.valueOf(p.id) }
return [positionIds: ids.isEmpty() ? ['__none__'] : ids]
