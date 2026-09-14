.PHONY: install build test typecheck lint-dashes dev-install web worker

install:
	bun install

build:
	bun run build

test:
	bun test

typecheck:
	bun run typecheck

# Fail if an em dash or en dash shows up in a tracked text file. See
# tests/plugin-manifest.test.ts for the narrower plugin-facing-text check in CI.
lint-dashes:
	bun run lint:dashes

dev-install:
	claude --plugin-dir $(CURDIR)

web:
	scripts/sil web

worker:
	scripts/sil worker --once
