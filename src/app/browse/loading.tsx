/**
 * The route transition state for a leaf list page.
 *
 * A skeleton rather than a spinner: it occupies the same box as the content that
 * replaces it, so nothing jumps, and it cannot push the document past the
 * viewport — the no-scrollbars rule applies to this state too.
 *
 * ## Why this is not the root `loading.tsx`
 *
 * A route-level loading boundary at the root starts streaming immediately, and
 * once headers are flushed `notFound()` can only change the body: every
 * `/objects/<unknown-uuid>` answered **200** with a 404 page inside. A correct
 * 404 status and a route-level skeleton are mutually exclusive for a segment, so
 * the boundary is placed only on leaf pages that never call `notFound()`.
 */
export default function Loading() {
  return (
    <div className="content" aria-busy="true">
      <div className="page-head">
        <div className="skeleton skeleton-title" />
      </div>
      <div className="card">
        <div className="card-body">
          <div className="skeleton skeleton-row" />
          <div className="skeleton skeleton-row" />
          <div className="skeleton skeleton-row" />
          <div className="skeleton skeleton-row" />
          <div className="skeleton skeleton-row" />
        </div>
      </div>
    </div>
  );
}
