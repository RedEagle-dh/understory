# understory — design language

The app is an **engineering instrument**, not a marketing SaaS. Its world is
registries, lockfiles, `name@version` strings, semver diffs, GHSA advisories.
Every visual choice should read as "instrument panel", quiet and precise.

## Type

- **Display / headings / data**: `font-heading` (JetBrains Mono Variable).
  PageHeader titles, package names, versions, advisory IDs, counters, the
  wordmark. Data IS the aesthetic — render it in mono, always.
- **Body / UI chrome**: Inter Variable (default `font-sans`). Nav labels,
  descriptions, form labels, buttons.
- Scale: page title `text-2xl font-semibold tracking-tight`; section titles
  `text-base font-medium`; data tables `text-sm`; metadata `text-xs`.

## Color

- The brand primary (emerald) stays **quiet** — small marks, focus, primary
  buttons. In an audit tool, chroma must encode *state*, so the severity ramp
  is the app's real chromatic voice. TWO token families:
  - `--severity-*` (`bg-severity-*` / `text-severity-*`): badges, dots,
    stripes, colored text — always accompanied by a literal label.
  - `--chart-severity-*` (`bg-chart-severity-*`): **large adjacent fills**
    (trend-chart bands, SeverityBar segments). These are validated with the
    dataviz palette checker per mode (CVD separation, normal-vision floor,
    lightness band, surface contrast) — never eyeball-edit them; re-run
    `scripts/validate_palette.js` from the dataviz skill. Dark mode is its own
    validated steps, not a flip of light. Adjacent fills always get a 1.5–2px
    surface-colored gap/stroke as secondary encoding.
- Never use severity colors decoratively. A red element means critical, every
  time.
- Dark mode is the primary design target (self-hosted dev tooling); light mode
  must stay equally polished.

## Signature device

`SeveritySpectrum` (`src/components/common/severity-spectrum.tsx`): a
hairline five-color strip, critical → info. It appears on the auth screen and
(later) as the top edge of project cards. Use it sparingly — it is the one
memorable mark, not a border style.

The `Wordmark` (`src/components/common/wordmark.tsx`) is mono lowercase with
a pulsing terminal cursor (`motion-reduce` safe) — the only ambient motion in
the shell.

## Structure

- `PageHeader` on every screen; `EmptyState` is an invitation to act (verb-led
  action button); `QueryBoundary` wraps every data fetch.
- Severity ordering is always critical → high → moderate → low → info; sort
  by severity rank, never alphabetically.
- Version changes render as `4.17.15 → 4.17.21` in mono with the target
  segment colored by bump kind (major=`severity-high`, minor=`severity-moderate`,
  patch=`muted-foreground`). (Shared `VersionDelta` component arrives with the
  dependency table.)

## Copy

Sentence case, plain verbs, no filler. Buttons say what happens ("Scan now",
"Open pull request", "Add project"). Errors state what went wrong and what to
do; empty states point at the next action. The tool never apologizes and never
markets itself.
