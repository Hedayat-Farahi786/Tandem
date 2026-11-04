# Tandem website

The public landing page: plain HTML, CSS and a few lines of JavaScript, no
build step and no third-party requests (no web fonts, analytics or trackers),
so no cookie banner is needed.

* Preview: open `index.html` in a browser.
* Deploy: serve the folder as static files from the EU (for example S3 and
  CloudFront with an EU origin). `/app` is the web app, `/legal/*` the
  documents in `docs/legal/` once reviewed.
* Before launch: replace `[Operator]` and `[Privacy contact]` in the footer.
