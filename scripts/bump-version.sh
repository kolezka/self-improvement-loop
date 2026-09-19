#!/usr/bin/env bash
# Bump the plugin version everywhere it is hardcoded, then rebuild dist/.
#
# Usage: scripts/bump-version.sh <new-version> [--no-build]
#
# Touches: root package.json, every workspace package.json under packages/ and
# apps/, .claude-plugin/plugin.json, and SIL_VERSION in the health handler.
# dist/ ships in git and embeds SIL_VERSION, so a rebuild is part of the bump.
# Nothing is committed; the script prints the commit command at the end.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

NEW="${1:-}"
BUILD=1
for arg in "${@:2}"; do
  case "$arg" in
    --no-build) BUILD=0 ;;
    *) echo "error: unknown argument $arg" >&2; exit 2 ;;
  esac
done

if [ -z "$NEW" ]; then
  echo "usage: $0 <new-version> [--no-build]" >&2
  exit 2
fi
if ! [[ "$NEW" =~ ^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$ ]]; then
  echo "error: '$NEW' is not a semver version (expected e.g. 0.2.4)" >&2
  exit 2
fi

CURRENT="$(jq -r .version package.json)"
if [ "$CURRENT" = "$NEW" ]; then
  echo "package.json is already at $NEW, nothing to do."
  exit 0
fi

HEALTH="packages/ops/src/handlers/health.ts"
PLUGIN=".claude-plugin/plugin.json"

# JSON manifests, edited via jq so formatting stays stable.
manifests=(package.json "$PLUGIN")
while IFS= read -r f; do manifests+=("$f"); done < <(ls packages/*/package.json apps/*/package.json)

for f in "${manifests[@]}"; do
  have="$(jq -r .version "$f")"
  if [ "$have" != "$CURRENT" ]; then
    echo "warning: $f is at $have, not $CURRENT; setting it to $NEW anyway" >&2
  fi
  tmp="$(mktemp)"
  jq --indent 2 --arg v "$NEW" '.version = $v' "$f" > "$tmp"
  mv "$tmp" "$f"
  echo "  $f: $have -> $NEW"
done

# Hardcoded constant baked into the dist bundles. Matched by shape, not by the
# current value: a hand bump once left it behind (0.2.2 while manifests said
# 0.2.3), and the script must repair that rather than stop on it.
have="$(sed -n 's/^const SIL_VERSION = "\([^"]*\)";$/\1/p' "$HEALTH")"
if [ -z "$have" ]; then
  echo "error: no 'const SIL_VERSION = \"...\";' line in $HEALTH" >&2
  exit 1
fi
if [ "$have" != "$CURRENT" ]; then
  echo "warning: $HEALTH is at $have, not $CURRENT; setting it to $NEW anyway" >&2
fi
# temp + mv rather than `sed -i`: GNU and BSD sed disagree on the -i suffix
# argument, and this matches the jq blocks above.
tmp="$(mktemp)"
sed "s/^const SIL_VERSION = \"$have\";$/const SIL_VERSION = \"$NEW\";/" "$HEALTH" > "$tmp"
mv "$tmp" "$HEALTH"
echo "  $HEALTH: $have -> $NEW"

# The lockfile records every workspace version, so leaving it behind means the
# next plain `bun install` rewrites it. bun.lock is a sourceHash() input, so that
# rewrite fails tests/dist.test.ts on an otherwise untouched checkout.
echo "Refreshing bun.lock ..."
bun install --lockfile-only

# Nothing outside dist/ may still carry the old version.
stale="$(grep -rlF "\"$CURRENT\"" --include='*.json' --include='*.ts' \
  --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=.claude \
  --exclude-dir=.svelte-kit . || true)"
if [ -n "$stale" ]; then
  echo "error: '$CURRENT' still present in:" >&2
  echo "$stale" >&2
  exit 1
fi

if [ "$BUILD" = 1 ]; then
  echo "Rebuilding dist/ ..."
  bun run build
else
  echo "Skipped the dist/ rebuild (--no-build); run 'bun run build' before committing."
fi

echo
echo "Bumped $CURRENT -> $NEW. Review with 'git diff --stat', then:"
echo "  git add -A && git commit -m \"chore: bump version to $NEW\""
