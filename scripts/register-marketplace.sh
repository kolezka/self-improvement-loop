#!/usr/bin/env bash
# Add self-improvement-loop to the kolezka marketplace. Clones the marketplace
# repo into a scratch dir, adds the plugin entry if missing, commits on a
# branch, and PRINTS the push/PR commands instead of running them. Nothing
# here reaches a remote; the operator runs the printed commands by hand.
set -euo pipefail

MARKETPLACE_REPO="git@github.com:kolezka/marketplace.git"
BRANCH="feat/add-self-improvement-loop"
PLUGIN_NAME="self-improvement-loop"
PLUGIN_DESCRIPTION="Background reflection, lesson promotion and usage feedback for Claude Code sessions"

scratch="$(mktemp -d)"
# No cleanup-on-exit trap: a successful commit must survive past this script so
# the operator can push it. Failure paths below remove the scratch dir explicitly.

echo "Cloning $MARKETPLACE_REPO into $scratch ..."
if ! git clone --quiet "$MARKETPLACE_REPO" "$scratch/marketplace"; then
  rm -rf "$scratch"
  exit 1
fi
cd "$scratch/marketplace"

manifest=".claude-plugin/marketplace.json"
if [ ! -f "$manifest" ]; then
  echo "error: $manifest not found in $MARKETPLACE_REPO" >&2
  rm -rf "$scratch"
  exit 1
fi

changed="$(PLUGIN_NAME="$PLUGIN_NAME" PLUGIN_DESCRIPTION="$PLUGIN_DESCRIPTION" python3 - "$manifest" <<'PYEOF'
import json
import os
import sys

path = sys.argv[1]
with open(path, encoding="utf-8") as fh:
    data = json.load(fh)

name = os.environ["PLUGIN_NAME"]
entry = {
    "name": name,
    "description": os.environ["PLUGIN_DESCRIPTION"],
    "source": {
        "source": "github",
        "repo": "kolezka/self-improvement-loop",
        "ref": "main",
    },
    "category": "productivity",
}

plugins = data.setdefault("plugins", [])
existing = next((p for p in plugins if p.get("name") == name), None)
if existing == entry:
    print("false")
else:
    if existing is not None:
        plugins.remove(existing)
    plugins.append(entry)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=2)
        fh.write("\n")
    print("true")
PYEOF
)"

if [ "$changed" = "false" ]; then
  echo "Entry for $PLUGIN_NAME already present and unchanged. Nothing to commit."
  rm -rf "$scratch"
  exit 0
fi

git checkout --quiet -b "$BRANCH"
git add "$manifest"
git commit --quiet -m "feat: add $PLUGIN_NAME plugin"

echo
echo "Committed on branch $BRANCH in $scratch/marketplace (left on disk, not cleaned up)."
echo "This script does not push or open a PR. Run these yourself:"
echo
echo "  cd $scratch/marketplace"
echo "  git push -u origin $BRANCH"
echo "  gh pr create --title \"feat: add $PLUGIN_NAME plugin\" --body \"Adds $PLUGIN_NAME to the marketplace.\""
echo
echo "Manual install once the PR is merged:"
echo
echo "  claude plugin marketplace add kolezka/marketplace"
echo "  claude plugin install $PLUGIN_NAME@kolezka"
