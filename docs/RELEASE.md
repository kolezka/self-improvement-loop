# Release

`dist/` is built, never committed on `main`. A plugin install has no install
step, so the installed tree still needs a prebuilt `dist/`. The release workflow
is what produces it.

## Cutting a release

Actions > `release` > Run workflow, with `bump` set to `major`, `minor`, `patch`
or an explicit `x.y.z`. The workflow (`.github/workflows/release.yml`) then:

1. Turns the keyword into a version and runs `scripts/bump-version.sh`, which
   rewrites every manifest, `SIL_VERSION` in the health handler and `bun.lock`,
   then rebuilds `dist/`.
2. Runs `lint:dashes`, `typecheck`, `check:web` and `bun test`. The drift test
   in `tests/dist.test.ts` runs here because a build is present.
3. Commits the bump on the branch the run started from and pushes it.
4. Commits `dist/` on top (`git add --force`, since `.gitignore` hides it),
   tags it `v<version>`, and pushes the tag.
5. Force-pushes that same commit to the `release` branch. `release` is
   generated output, not a development branch: every run replaces it.
6. Zips the tag tree as `self-improvement-loop-<version>.zip` and attaches it to
   the GitHub release, with the SHA-256 in the release notes.

Nothing else is safe to merge into `release`, and no one should branch off it.

## What installs from what

| Install path | Source | What it gets |
| --- | --- | --- |
| Marketplace (default) | `github` + `"ref": "release"` | The newest release commit, `dist/` included |
| Pinned version | `github` + `"ref": "v<version>"` | That tag, unchanged forever |
| No git or npm on the box | `archive` + the release zip and its `sha256` | The same tree as the tag |

`scripts/register-marketplace.sh` writes the `release` entry into the kolezka
marketplace.

## Local builds

`make build` writes `dist/` in the checkout. It stays untracked. A dev install
(`claude --plugin-dir .`) needs it, because `hooks/hooks.json` runs
`dist/hook.js`; the `sil` shim and the kick path fall back to source when it is
missing, the hook does not.

A version bump by hand is `scripts/bump-version.sh <x.y.z>`, the same script the
workflow calls. It leaves the commit to you.

## Requirements on the repo

- The workflow pushes to the branch it ran from. If that branch is protected,
  give the `github-actions` app a push exception or run the workflow from an
  unprotected release branch.
- `permissions: contents: write` is set in the release workflow only. `ci.yml`
  stays read-only.
