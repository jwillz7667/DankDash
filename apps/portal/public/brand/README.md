# DankDash brand assets

Drop the final brand-team artwork into this directory. The portal's
`<Logo />` component reads files from `/brand/*` at runtime, so once
the SVGs are here, no code change is needed.

## Expected files

| File                | Purpose                                             | Recommended dimensions |
| ------------------- | --------------------------------------------------- | ---------------------- |
| `logo-mark.svg`     | Square icon — sidebar collapsed state, favicon      | 64×64 (square viewBox) |
| `logo-wordmark.svg` | Horizontal "DankDash" wordmark — sidebar header     | 180×40 (5:1 aspect)    |
| `logo-full.svg`     | Mark + wordmark composite — login screen, marketing | 240×64                 |
| `favicon.svg`       | Browser tab — typically same as `logo-mark.svg`     | 32×32                  |
| `logo-mark.png`     | Raster fallback for the mark, 2× retina             | 128×128                |
| `logo-mark@3x.png`  | Raster fallback for the mark, 3× retina             | 192×192                |

## Color requirements

- Primary green is **#3C9322** (`moss-500` in Tailwind).
- Logo-on-light backgrounds: use #3C9322 for the mark, #0F172A (slate-900)
  for the wordmark text.
- Logo-on-dark backgrounds: use #DDEFCF (`moss-100`) for the mark,
  #FFFFFF for the wordmark.
- Provide both light and dark variants if the brand has them (`logo-mark-dark.svg`,
  `logo-wordmark-dark.svg`); the `<Logo theme="dark" />` prop will pick them up.

## Replacing the placeholders

The files currently in this directory are temporary placeholders generated
during Phase 13 so the portal isn't visibly broken before the real brand
assets land. Overwrite them with the production artwork — same filenames,
same sizes — and the UI will pick them up on the next page load.
