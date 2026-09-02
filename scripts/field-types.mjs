// The ONE definition of how a kit field spec becomes a platform property.
//
// Shared by ua-object.mjs (which CREATES a type) and ua-schema.mjs (which ADDS
// fields to one), because two copies of this would drift and the drift would
// show up as a lookup that renders as a plain text box - working, saveable, and
// wrong.
//
// Every shape here was read off a snapshot of a type that exists on orbit, not
// guessed. Adding a new type means creating one, reading it back, and copying
// what the platform stored.

/** Human title from a camelCase field name: positionCode -> "Position Code". */
export const titleOf = (n) =>
  n.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase()).trim();

/**
 * Expand one field spec into everything the platform needs for it.
 * Returns { prop, reference, lookup, isDate } - `reference` feeds
 * metadata.referenceKeys, `lookup` feeds the layout's LookupWidget.
 */
export function expandField(name, spec, die) {
  const t = spec.type;

  // A LOOKUP. On the platform this is a single-select whose options come from
  // another object, so it needs three things in agreement: the property's
  // foreignKey, a LookupWidget in the layout, and an entry in
  // metadata.referenceKeys. Miss the layout and the builder shows a free-text
  // box that happily stores a string that resolves to nothing.
  if (t.startsWith("fk:")) {
    const ref = t.slice(3);
    const isUser = ref === "USER";
    return {
      prop: {
        type: "string",
        format: spec.multiple ? "multi-select" : "single-select",
        title: spec.title || titleOf(name),
        filterable: spec.filterable !== false,
        foreignKey: { reference: isUser ? "USER" : `ENTITY_ID:${ref}` },
        foreignKeyConstraintEnforced: false,
      },
      reference: isUser ? null : ref,
      lookup: {
        "ui:widget": "LookupWidget",
        "ui:options": {
          "ua:payload": { lookupType: isUser ? "USER" : `ENTITY_ID:${ref}`, type: "ByQuery" },
          multiple: !!spec.multiple,
        },
      },
    };
  }

  const base = {
    title: spec.title || titleOf(name),
    filterable: spec.filterable !== false,
    sortable: spec.sortable !== false,
  };
  if (spec.searchable) base.searchable = true;
  if (spec.uniqueKey) base.uniqueKey = true;

  switch (t) {
    case "string":  return { prop: { type: "string", ...base } };
    case "number":  return { prop: { type: "number", ...base } };
    case "integer": return { prop: { type: "integer", ...base } };
    case "boolean": return { prop: { type: "boolean", ...base } };
    // Dates are epoch integers on this platform - copied from the live `Period`
    // type, whose startDate/endDate are exactly this shape.
    case "date":    return { prop: { type: "integer", format: "date", dateFormat: "epoch", ...base }, isDate: true };
    default:
      die(`property "${name}": unknown type "${t}" (string|number|integer|boolean|date|fk:<Type>|fk:USER)`);
  }
}
