# Tandem website

The public landing page: plain HTML, CSS and a little JavaScript, no build step and no
third-party requests (no external fonts, analytics or trackers), so no cookie banner is needed.

* **Preview:** serve the folder (`python3 -m http.server -d apps/site 8000`) and open it, or open
  `index.html` directly.
* **Files:** `index.html`, `site.css`, `site.js`; `fonts/` (Geist and Geist Mono, SIL OFL, licence
  beside them); `favicon.svg` and `social.png` from
  `docs/brand`; `llms.txt`, a plain summary for AI agents.
* **Look:** a warm ivory canvas (warm near-black in dark mode), Tandem's deep teal and mint, and
  one crisp grotesque, Geist, set tight and large for headlines, with the words that are yours in
  teal.
* **Motion:** the headline rises out of a blur; the product window stands up as you scroll and
  plays a task, with callouts on your three decisions; logos drift past; the problem cards'
  pictures play once; a pulse runs along the "How it works" seam; the feature stage stays while
  the words scroll; the guardrails log streams allowed and blocked commands; the runner's
  terminal types itself. Mostly transforms and opacity, loops paused off screen, and none of it for
  reduced motion.
* **What's on it:** a product preview that plays one task from request to pull request (each
  stage can be clicked), the two-lane "How it works", features told beside a sticky stage,
  guardrails, company runners, security, FAQ. Light and dark follow the system, with a switch in
  the header.
* **Brand:** the mark, wordmark and colours follow `docs/brand/BRAND.md`; service logos are the
  app's (`apps/web/src/ui/brand-data.ts`), inlined.
* **Claims:** every statement on the page describes what Tandem does today. Change the page when
  the product changes; there are no customer logos or quotes until there are real ones.
* **Deploy:** serve the folder as static files from the EU (for example S3 and CloudFront with an
  EU origin) on `[domain]`. The app is on `app.[domain]`: point the "Sign in" and "Start with
  GitHub" links (`/app`) there. `/legal/*` are the documents in `docs/legal/` once reviewed.
* **Before launch:** replace `[domain]` and `[privacy email]`, and add the canonical URL
  (`<link rel="canonical">`, `og:url`) and an absolute `og:image` once the domain is chosen.
