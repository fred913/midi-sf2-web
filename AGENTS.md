# AGENTS.md

## Project Notes

- This repository builds a Tampermonkey userscript at `dist/sf2.user.js`.
- Keep the userscript header in `rollup.config.mjs`; `@version` is read from `package.json`.
- Do not embed the SF2 in the userscript. The runtime downloads `assets/GeneralUser-GS.sf2` from GitHub raw and caches it in IndexedDB.
- Keep `dist/sf2.user.js` committed because the README install link points at the raw built file.

## Commands

- Build: `npm run build`
- Test: `npm test`
- Bump userscript patch version: `npm run version:bump-userscript`

## Versioning

- The userscript version uses numeric semver-style patches, for example `0.1.0` through `0.1.99999`.
- GitHub Actions bumps the patch version before building and commits with `[skip ci]` to avoid a build loop.
- Local development builds should not bump the version unless preparing a release/upload.

## Verification

Before committing changes that affect runtime behavior, run:

```sh
npm run build
npm test
git diff --check
```
