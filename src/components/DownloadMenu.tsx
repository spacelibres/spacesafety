/**
 * A `Download ▾` menu for a table.
 *
 * A `<details>`/`<summary>` pair rather than a React popover: the menu opens with
 * no JavaScript, works before hydration, and closes on a second click. The links
 * are ordinary anchors, so the download is whatever the browser is already
 * configured to do with `text/csv` — no blob handling, no filename guessing.
 *
 * The menu appears in the page head, where the reference UI puts it.
 */
export function DownloadMenu({
  label,
  items,
}: {
  label: string;
  items: Array<{ label: string; href: string }>;
}) {
  return (
    <details className="dl">
      <summary className="btn">{label} ▾</summary>
      <div className="dl-menu">
        {items.map((item) => (
          <a key={item.href} className="dl-item" href={item.href}>
            {item.label}
          </a>
        ))}
      </div>
    </details>
  );
}
