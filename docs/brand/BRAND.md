# Tandem brand

<p>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="wordmark/tandem-wordmark-white.svg">
    <img src="wordmark/tandem-wordmark-teal.svg" alt="Tandem" height="56">
  </picture>
</p>

## The mark: Fuse

One solid T with a seam that runs down from the top and stops two-thirds of
the way. Two halves, you and the agent, start apart and finish as one piece:
one pull request. The mark is a single shape, so it works in any one colour.
It needs no second colour, gradient or effect.

## Which file to use

| Need | File |
| --- | --- |
| Logo on light backgrounds | `wordmark/tandem-wordmark-teal.svg` (or `-black`) |
| Logo on dark backgrounds | `wordmark/tandem-wordmark-white.svg` |
| The mark alone, 32px and up | `mark/tandem-mark-{teal,black,white}.svg` |
| The mark alone, 24px and below | `mark/tandem-mark-small-{teal,black,white}.svg` |
| App icon (rounded tile) | `icon/tandem-icon.svg`, `icon/tandem-icon-1024.png` |
| One-colour app icon | `icon/tandem-icon-black.svg`, `icon/tandem-icon-black-1024.png` |
| Loader outside the app (README, docs) | `motion/tandem-loader-{teal,white}.svg` |
| Link previews, GitHub social preview | `social/tandem-social.png` (1280 × 640) |
| PNGs for slides and documents | the `*-1024.png` marks and the `wordmark/*.png` files |

The web app serves its own favicons and install icons from
`apps/web/public` (`favicon.svg`, `favicon.ico`, `apple-touch-icon.png`,
`icon-192.png`, `icon-512.png`, `icon-maskable-512.png`, `site.webmanifest`).
GitHub doesn't read the social card from the repository: upload
`social/tandem-social.png` under the repository's Settings › Social preview.

## Sizes

- **Master mark** at 32px and up.
- **Small mark** at 24px and below. It's drawn on a 16px pixel grid: every
  edge lands on a whole pixel, and the seam is a crisp 1px slot. Below 16px,
  use the app icon instead.
- **Wordmark**: no smaller than 14px cap height (about 20px tall overall).
- **Favicon tiles** at 16, 32 and 48px are drawn pixel by pixel
  (`icon/tandem-icon-16.svg`, `-32.svg`, `-48.svg`). At 16px the tile shows
  the T without its seam, which would cut the crossbar in two at that size.
  Don't scale the big icon down to these sizes.

## Clear space and placement

Keep clear space around the mark and the wordmark equal to the height of the
T's crossbar on every side. Place the logo on a plain, calm background; on a
photo or a busy surface, use the app icon instead.

## Colour

| | Hex | Use |
| --- | --- | --- |
| Deep teal | `#0E3B3B` | The mark on light backgrounds; app icon background |
| Mint | `#7CC7C0` | The mark on dark backgrounds |
| Black / white | `#000000` / `#FFFFFF` | One-colour uses: print, stamps, partner pages |

The wordmark's letters are near-black `#141414` next to a teal mark, or the
same colour as the mark in the one-colour versions.

## The wordmark

The mark stands in for the T, and "andem" follows it in Inter (the app's
typeface) at weight 650 with -0.04em tracking. The mark is sized so its
height equals Inter's cap height and it sits on the baseline. The files are
outlines, so they look the same everywhere. Don't retype the word, and don't
put a typed T next to the mark.

## Motion

Motion uses only transforms and opacity, so it stays smooth on any machine.

- **Loader** (a 1.5s loop): the halves slide together until the seam
  closes, press in to 94% and hold for a beat as one piece, then part again.
  Every leg eases in and out (`cubic-bezier(0.65, 0, 0.35, 1)`), so the loop
  never stops abruptly. In the app this is the only busy indicator.
- **Entrance** (once, 760ms): the halves glide in from either side
  (`cubic-bezier(0.16, 1, 0.3, 1)`) and meet; then the foot of the seam fills
  in over 320ms, which is the moment the two fuse. The app shows this above
  "What should we build?".
- **Splash**: the loader, centred on the canvas colour, until the app's
  first data arrives. It fades in only after 180ms, so a fast start shows no
  flash.
- **Reduced motion**: nothing slides. The loader pulses in opacity instead,
  so it still shows that something is busy.

## Don't

- Use two colours, gradients, outlines, shadows or glows on the mark.
- Stretch, rotate or redraw it, or change the length or width of the seam.
- Run the seam all the way down, or close it. In the logo it always stops
  two-thirds of the way; only the moving loader opens and closes it.
- Set the mark inside another shape, apart from the app icon tile.

## In the app

`apps/web/src/ui/brand.tsx` has `TandemMark` (with `enter` for the
entrance), `TandemLoader`, `TandemWordmark` and `TandemTile`. They draw in
`currentColor`, so they follow the theme. The motion is defined in
`apps/web/src/index.css` under `.fuse`.

## Changing the brand

Every shape comes from one file, `apps/web/src/ui/brand-geometry.ts`. After
changing it, run `pnpm brand` to rebuild everything in this folder and the
web app's icons. It needs Python 3 with `fonttools` and `brotli`, and the
Chromium that Playwright uses (set `PLAYWRIGHT_CHROMIUM_EXECUTABLE` to point
at a specific build). A test fails if the splash in `apps/web/index.html` or
the favicon falls out of step with the geometry.
