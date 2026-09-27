.PHONY: check protocol-check test-registry migration-test registry-config registry-migrate registry-check-db registry-backup registry-restore-check nix-check

REGISTRY_DB ?= $(CURDIR)/var/registry.sqlite3

check: protocol-check test-registry

protocol-check:
	$(MAKE) -C protocol/v1 check

test-registry:
	cd registry-node && node --test

migration-test:
	cd registry-node && node --test test/db.test.mjs

registry-config:
	node registry-node/src/cli.mjs effective-config

registry-migrate:
	BAREBUH_DATABASE_PATH="$(REGISTRY_DB)" node registry-node/src/cli.mjs migrate

registry-check-db:
	BAREBUH_DATABASE_PATH="$(REGISTRY_DB)" node registry-node/src/cli.mjs check-db

registry-backup:
	@test -n "$(BACKUP)" || { echo "BACKUP=/path/to/backup.sqlite3 is required" >&2; exit 2; }
	BAREBUH_DATABASE_PATH="$(REGISTRY_DB)" node registry-node/src/cli.mjs backup "$(BACKUP)"

registry-restore-check:
	@test -n "$(RESTORE)" || { echo "RESTORE=/path/to/backup.sqlite3 is required" >&2; exit 2; }
	node registry-node/src/cli.mjs restore-check "$(RESTORE)"

nix-check:
	nix flake check --offline
