# Tandem website

The public landing page: plain HTML, CSS and a few lines of JavaScript, no
build step and no third-party requests (no web fonts, analytics or trackers),
so no cookie banner is needed.

* Preview: open `index.html` in a browser.
* Deploy: serve the folder as static files from the EU (for example S3 and
  CloudFront with an EU origin) on `[domain]`. The app is on `app.[domain]`:
  point the "Sign in" and "Get started" links (`/app`, `/app/signup`) there.
  `/legal/*` are the documents in `docs/legal/` once reviewed.
* Before launch: fill in `[privacy email]`, and add the canonical URL
  (`<link rel="canonical">`, `og:url`) once the domain is chosen.
