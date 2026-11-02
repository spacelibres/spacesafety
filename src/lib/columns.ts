/**
 * Which table columns a reader has chosen to see.
 *
 * ## Why a cookie
 *
 * The choice is a display preference, not data: it must survive a reload and must
 * not need a database write. The cookie is the same mechanism the theme and the
 * locale already use, so there is one place that answers "where does a preference
 * live" instead of three.
 *
 * ## Why the cookie is validated against a list
 *
 * A cookie is client-controlled input. The page reads it to decide what to render,
 * so an unknown key must be dropped rather than used as a key into a map — and a
 * cookie naming every column must not be able to resurrect a column the page no
 * longer has.
 */

/** Cookie name per table, so two tables do not share a preference. */
export function columnsCookie(table: string): string {
  return `cols.${table}`;
}

/**
 * Visible columns from a cookie value.
 *
 * @param value   raw cookie, e.g. `objectName,noradId,alive`
 * @param allowed the columns this build actually has
 * @param required columns that cannot be hidden (the one carrying the entity link)
 */
export function visibleColumns<Key extends string>(
  value: string | undefined,
  allowed: readonly Key[],
  required?: Key,
): Key[] {
  if (!value) return [...allowed];
  const wanted = value
    .split(",")
    .map((v) => v.trim())
    .filter((v): v is Key => (allowed as readonly string[]).includes(v));
  // A cookie that parsed to nothing means "hide everything", which renders a table
  // with no data columns and looks broken; treat it as "no preference".
  if (wanted.length === 0) return [...allowed];
  const unique = [...new Set(required ? [required, ...wanted] : wanted)];
  // Keep the table's own column order rather than the cookie's, so a preference
  // cannot reorder the table into something the CSS did not expect.
  return allowed.filter((key) => unique.includes(key));
}

/** Serialise a selection back into a cookie value, in table order. */
export function columnCookieValue<Key extends string>(
  allowed: readonly Key[],
  visible: readonly Key[],
): string {
  return allowed.filter((key) => visible.includes(key)).join(",");
}
