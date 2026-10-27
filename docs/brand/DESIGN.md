---
version: alpha
name: DevBox
description: Navy, one cursor-green accent, Figtree and JetBrains Mono. Dark first, with a light theme for READMEs and docs.
colors:
  primary: "#86CFA8"
  primary-on-light: "#1F6F47"
  primary-soft: "#122530"
  neutral: "#020E20"
  surface: "#0C1D33"
  surface-sunken: "#020A16"
  outline: "#122136"
  on-surface: "#F0EFF5"
  on-surface-muted: "#9AA1AD"
  on-surface-dim: "#4C5566"
  glow: "#0C2E5A"
  error: "#F29B94"
  neutral-light: "#F6F7F9"
  surface-light: "#FFFFFF"
  surface-sunken-light: "#ECEEF2"
  outline-light: "#E3E4E8"
  on-surface-light: "#020E20"
  on-surface-muted-light: "#5B616B"
  on-surface-dim-light: "#A9AFB9"
  error-light: "#A8261F"
typography:
  headline-display:
    fontFamily: Figtree
    fontSize: 64px
    fontWeight: 500
    lineHeight: 1.05
    letterSpacing: -0.03em
  headline-lg:
    fontFamily: Figtree
    fontSize: 44px
    fontWeight: 500
    lineHeight: 1.15
    letterSpacing: -0.025em
  headline-md:
    fontFamily: Figtree
    fontSize: 30px
    fontWeight: 500
    lineHeight: 1.2
    letterSpacing: -0.02em
  body-lg:
    fontFamily: Figtree
    fontSize: 21px
    fontWeight: 500
    lineHeight: 1.3
    letterSpacing: -0.01em
  body-md:
    fontFamily: Figtree
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
  label-caps:
    fontFamily: JetBrains Mono
    fontSize: 14px
    fontWeight: 500
    lineHeight: 1
    letterSpacing: 0.12em
  code:
    fontFamily: JetBrains Mono
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.5
rounded:
  sm: 14px
  md: 20px
  lg: 24px
spacing:
  dot-grid: 24px
  tile: 84px
  frame-inset: 2px
components:
  icon-tile:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.on-surface}"
    rounded: "{rounded.md}"
    size: 84px
  icon-tile-accent:
    backgroundColor: "{colors.primary-soft}"
    textColor: "{colors.primary}"
    rounded: "{rounded.md}"
    size: 84px
  card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.on-surface}"
    rounded: "{rounded.sm}"
  image-frame:
    backgroundColor: "{colors.neutral}"
    rounded: "{rounded.lg}"
  node-label:
    textColor: "{colors.on-surface}"
    typography: "{typography.body-lg}"
  node-sublabel:
    textColor: "{colors.on-surface-muted}"
    typography: "{typography.body-md}"
  meta-label:
    textColor: "{colors.on-surface-muted}"
    typography: "{typography.label-caps}"
---

# DevBox design

How DevBox looks everywhere: the repo, docs, videos, posts and the site page. The tokens above are the source of truth; `logo/` has the logos and `export/` the ready-made PNGs.

## Overview

A cursor block on navy. The mark is the blinking block of a terminal waiting for work: simple, technical, and nothing like the RudderStack logo.

The look comes from RudderStack (the navy, the dot grid, a wordmark in Degular) because DevBox comes from the RudderStack engineering team. It is set apart on purpose. DevBox is an open source project we share in good faith, not the commercial product, so it has its own mark, its own accent and open fonts, and skips RudderStack's sales styling.

It should feel calm and technical: few words, icons that carry the meaning, one thing in green.

## Colors

One accent. Everything else is navy and greys. Dark is the default; tokens ending in `-light` are the light theme.

- **Cursor green (`primary`, #86CFA8; `primary-on-light`, #1F6F47):** the mark, the one thing to look at, "done", "open source".
- **RudderStack navy (`neutral`, #020E20; light #F6F7F9):** page and image background.
- **Raised navy (`surface`, #0C1D33; light #FFFFFF):** tiles and cards, with an `outline` border (#122136; light #E3E4E8).
- **Text (`on-surface`, #F0EFF5; light #020E20):** primary text. `on-surface-muted` (#9AA1AD) for captions, `on-surface-dim` (#4C5566) for connectors and quiet lines.
- **Red (`error`, #F29B94; light #A8261F):** errors and risk only.
- **Glow (`glow`, #0C2E5A):** the faint navy glow behind hero shots. The only blue allowed.

## Typography

**Figtree** for headlines, body and labels. **JetBrains Mono** for commands, stage names and small meta lines. Both are open source (SIL Open Font License 1.1) and free on [Google Fonts](https://fonts.google.com/specimen/Figtree).

- **Headlines:** Figtree Medium, -0.025em to -0.03em, line height 1.05 to 1.15.
- **Body and labels:** Figtree Regular or Medium, 0 to -0.01em.
- **Mono:** JetBrains Mono. Uppercase meta labels at +0.12em; commands at normal tracking. Mono is the DevBox voice: commands, stage names, the "from the RudderStack engineering team" line.
- **Wordmark only:** Degular Medium at -0.045em, outlined into the logo SVGs. Degular is RudderStack's licensed font, so it is never used as live text and its files are never committed. See [Logo](#logo).

## Layout

Images are built at fixed sizes (see [Assets](#assets)) and rendered at 2x. Content sits inside a frame inset 2px from the edge.

- The background is navy with a 24px dot grid; hero shots add a soft navy glow.
- Diagrams read left to right: inputs, DevBox, outputs. Nodes are 84px icon tiles with a label under them.
- Generous space between nodes. If a label needs two lines, the diagram has too many words.

## Elevation & Depth

Flat. Depth comes from tonal layers, not shadows: `surface` tiles on the `neutral` background, separated by a 1.5px `outline` border. The tile that matters gets a green border and `primary-soft` fill (green at 12% over navy; `--dbx-green-soft` in CSS). The mark may glow in video and on dark hero shots (`box-shadow: 0 0 60px rgba(134,207,168,.6)`); static logo files never glow.

## Shapes

Soft rectangles. 14px corners for cards, 20px for icon tiles, 24px for image frames. The mark's corners are 29% of its width. Connectors are 2px lines in `on-surface-dim` with small arrowheads; the path that carries the point is green. Icons are [Tabler](https://tabler.io/icons) outline at 1.6 stroke. Use only that set.

## Components

- **Icon tile:** 84px, `surface` fill, `outline` border, icon in `on-surface`. The accent variant uses `primary-soft` fill and a green border and icon.
- **Node:** an icon tile with a `body-lg` label under it and, only where it changes the meaning, a `body-md` sub-label in `on-surface-muted` ("no LLM calls", "dummy keys").
- **Zone:** a dashed `outline` rectangle with 22px corners and a small icon label, for "Your cloud".
- **Image frame:** `neutral` fill with the dot grid, 24px corners, `outline` border.
- **Meta label:** `label-caps` in `on-surface-muted`, at the bottom of hero images.

## Do's and Don'ts

- Do use the green once or twice per frame. If everything is green, nothing is.
- Do use an icon and one or two words per node.
- Do use the tagline exactly: "Open source autonomous engineering harness in your cloud." Highlight "Open source".
- Do credit "from the RudderStack engineering team", in mono, small, at the bottom.
- Don't use RudderStack's blues (#A4CBFF, #1063E2, #2B8BFF) as accents.
- Don't use pastels, purples or rainbow category colors.
- Don't use RudderStack's corner-bracket buttons, gradient text, blue glows, "Request a demo" styling or sales CTAs. DevBox has no pricing and no tiers.
- Don't call DevBox an "agent", or put made-up numbers or customer names on screen.
- Don't set live text in Degular or commit its font files.

## Logo

| File | Use |
| --- | --- |
| `logo/devbox-logo-on-dark.svg` / `-on-light.svg` | Default. Mark plus wordmark |
| `logo/devbox-wordmark-on-dark.svg` / `-on-light.svg` | Where the mark is already shown nearby |
| `logo/devbox-mark-on-dark.svg` / `-on-light.svg` | The block alone, at small sizes or as a bullet |
| `logo/devbox-icon.svg`, `export/devbox-icon.png` | App icon: the block on a rounded navy tile |
| `logo/devbox-avatar.svg`, `export/devbox-avatar.png` | Square avatar for GitHub, X and the GitHub App (platforms round it) |
| `export/favicon-32.png`, `export/apple-touch-icon.png` | Browser icons |
| `export/logo-on-dark.png` / `-on-light.png` | PNG logo for tools that can't take SVG |

The SVGs are outlined, so they look the same without any font installed.

**Construction** (from the video end card): the wordmark is "DevBox" in Degular Medium with -0.045em tracking. The block is 0.295em wide and 0.533em tall with corners at 29% of its width, centred on the cap height. The gap between block and word is 0.21em.

- Write the name "DevBox" in prose. Use `devbox` only for commands and paths.
- On dark backgrounds the block is `primary` and the word is `on-surface`. On light backgrounds the block is `primary-on-light` and the word is navy.
- Clear space around the logo is at least the block's width.
- Don't recolor the block, stretch it, outline it, add a gradient, or put the RudderStack logo inside it.
- The `>_` terminal-square mark from the early social preview drafts is retired.

## Assets

| Asset | File | Size |
| --- | --- | --- |
| README banner | `../images/banner-dark.png`, `-light.png` | 1600x400 @2x |
| GitHub social preview | `export/social-preview.png` | 1280x640 (set in the repo's Settings, under 1 MB) |
| X / LinkedIn header | `export/x-header.png` | 1500x500 |
| Avatar | `export/devbox-avatar.png` | 512x512 |
| README diagrams | `../images/` | 1600 wide @2x, dark and light |
