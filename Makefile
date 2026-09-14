.PHONY: test dev-install web worker lint-dashes

test:
	uv run pytest -q

dev-install:
	claude --plugin-dir $(CURDIR)

web:
	uv run --project $(CURDIR) sil web

worker:
	uv run --project $(CURDIR) sil worker --once

# Fail if an em dash or en dash shows up in plugin-facing text. See
# tests/test_plugin_manifest.py::test_no_em_or_en_dash for the same check in CI.
lint-dashes:
	@! grep -rn --include='*.md' --include='*.json' --include='*.py' \
		-e $$'—' -e $$'–' \
		commands skills docs hooks .claude-plugin sil scripts README.md \
		2>/dev/null | grep -q . \
		|| (grep -rn --include='*.md' --include='*.json' --include='*.py' \
			-e $$'—' -e $$'–' \
			commands skills docs hooks .claude-plugin sil scripts README.md; \
			echo "em dash or en dash found, see above" >&2; exit 1)
