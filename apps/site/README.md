# Tandem website

The public landing page: plain HTML, CSS and a little JavaScript, no build step and no
third-party requests (no external fonts, analytics or trackers), so no cookie banner is needed.

* **Preview:** serve the folder (`python3 -m http.server -d apps/site 8000`) and open it, or open
  `index.html` directly.
* **Files:** `index.html`, `site.css`, `site.js`; `fonts/inter-var.woff2` (Inter, SIL OFL, see
  `fonts/OFL.txt`); `favicon.svg` and `social.png` from `docs/brand`; `llms.txt`, a plain summary
  for AI agents.
* **What's on it:** a product preview that plays one task from request to pull request (each
  stage can be clicked; it pauses off screen and stands still for reduced motion), the two-lane
  "How it works", feature deep dives with real-looking artifacts, guardrails, company runners,
  security, FAQ. Light and dark follow the system, with a switch in the header.
* **Brand:** the mark, wordmark and colours follow `docs/brand/BRAND.md`; service logos are the
  app's (`apps/web/src/ui/brand-data.ts`), inlined.
* **Claims:** every statement on the page describes what Tandem does today. Change the page when
  the product changes; there are no customer logos or quotes until there are real ones.
* **Deploy:** serve the folder as static files from the EU (for example S3 and CloudFront with an
  EU origin) on `[domain]`. The app is on `app.[domain]`: point the "Sign in" and "Start with
  GitHub" links (`/app`) there. `/legal/*` are the documents in `docs/legal/` once reviewed.
* **Before launch:** replace `[domain]` and `[privacy email]`, and add the canonical URL
  (`<link rel="canonical">`, `og:url`) and an absolute `og:image` once the domain is chosen.
