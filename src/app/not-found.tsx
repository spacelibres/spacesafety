import { NotFoundBody, NotFoundHeading } from "@/components/RouteMessages";
import { Topbar } from "@/components/Shell";

/**
 * The 404 page.
 *
 * Without this file Next renders its own page — `404 This page could not be
 * found`, English, unstyled, with no link back into the application.
 *
 * The body is a client component (see `RouteMessages`): a `notFound()` raised
 * inside a dynamic page reaches the browser as an RSC payload rather than as
 * server HTML, so anything that needs request context on the server cannot be
 * re-rendered from it.
 *
 * The heading carries both the code and the localised sentence: the code is a
 * numeral and stays `404` in every language, the sentence under it does not.
 */
export default function NotFound() {
  return (
    <>
      <Topbar section="404" />
      <div className="content">
        <div className="page-head">
          <div>
            <h1 className="page-title">404</h1>
            <NotFoundHeading />
          </div>
        </div>
        <NotFoundBody />
      </div>
    </>
  );
}
