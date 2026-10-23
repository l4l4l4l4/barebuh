.PHONY: help configure build test check metadata-check release release-check publish protocol-check test-registry migration-test registry-config registry-migrate registry-check-db registry-backup registry-restore-check registry-ingest registry-drain registry-materialize registry-rebuild registry-check-projection registry-station registry-set-policy registry-peer-add registry-peer-remove registry-peer-list registry-replicate nix-check
.DEFAULT_GOAL := help

REGISTRY_DB ?= $(CURDIR)/var/registry.sqlite3
FEDERATION_ENV ?= BAREBUH_MODE=PRIVATE_PINNED_FEDERATION BAREBUH_FEDERATION_ENABLED=true

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

# Ingest a signed envelope (use ENVELOPE=- to read it from stdin) and materialize its station,
# drain the materialize queue, or rebuild and verify the projection from the immutable records.
registry-ingest:
	@test -n "$(ENVELOPE)" || { echo "ENVELOPE=/path/to/envelope.json (or -) is required" >&2; exit 2; }
	BAREBUH_DATABASE_PATH="$(REGISTRY_DB)" node registry-node/src/cli.mjs ingest "$(ENVELOPE)" "$(SOURCE)"

registry-drain:
	BAREBUH_DATABASE_PATH="$(REGISTRY_DB)" node registry-node/src/cli.mjs drain $(LIMIT)

registry-materialize:
	@test -n "$(STATION)" || { echo "STATION=oradio:station:ed25519:... is required" >&2; exit 2; }
	BAREBUH_DATABASE_PATH="$(REGISTRY_DB)" node registry-node/src/cli.mjs materialize "$(STATION)"

registry-rebuild:
	BAREBUH_DATABASE_PATH="$(REGISTRY_DB)" node registry-node/src/cli.mjs rebuild

registry-check-projection:
	BAREBUH_DATABASE_PATH="$(REGISTRY_DB)" node registry-node/src/cli.mjs check-projection

registry-station:
	@test -n "$(STATION)" || { echo "STATION=oradio:station:ed25519:... is required" >&2; exit 2; }
	BAREBUH_DATABASE_PATH="$(REGISTRY_DB)" node registry-node/src/cli.mjs station "$(STATION)"

registry-set-policy:
	@test -n "$(RECORD)" -a -n "$(STATE)" || { echo "RECORD=sha256:... STATE=admitted|suppressed|quarantined are required" >&2; exit 2; }
	BAREBUH_DATABASE_PATH="$(REGISTRY_DB)" node registry-node/src/cli.mjs set-policy "$(RECORD)" "$(STATE)" $(REASON)

# Pinned federation (PRIVATE_PINNED_FEDERATION only). A peer exists because an operator pinned it;
# pulling is one bounded, strictly sequential worker that resumes from each peer's committed cursor.
registry-peer-add:
	@test -n "$(PEER)" -a -n "$(BASE)" || { echo "PEER=oradio:node:ed25519:... BASE=https://host/v1/ [LABEL=name] are required" >&2; exit 2; }
	$(FEDERATION_ENV) BAREBUH_DATABASE_PATH="$(REGISTRY_DB)" node registry-node/src/cli.mjs peer-add "$(PEER)" "$(BASE)" $(LABEL)

registry-peer-remove:
	@test -n "$(PEER)" || { echo "PEER=oradio:node:ed25519:... is required" >&2; exit 2; }
	$(FEDERATION_ENV) BAREBUH_DATABASE_PATH="$(REGISTRY_DB)" node registry-node/src/cli.mjs peer-remove "$(PEER)"

registry-peer-list:
	$(FEDERATION_ENV) BAREBUH_DATABASE_PATH="$(REGISTRY_DB)" node registry-node/src/cli.mjs peer-list

registry-replicate:
	$(FEDERATION_ENV) BAREBUH_DATABASE_PATH="$(REGISTRY_DB)" node registry-node/src/cli.mjs replicate $(PEER)

nix-check:
	nix flake check --offline

PYTHON ?= python3
CMAKE ?= cmake
BUILD_DIR ?= build
RELEASE_DIR ?= build/release

help:
	@printf '%s\n' \
	  'configure      Configure a RelWithDebInfo build with warnings as errors' \
	  'build          Build Barebuh' \
	  'test           Build and run the offline test suite' \
	  'check          Run protocol, registry, and release-hygiene checks' \
	  'metadata-check Validate Linux desktop and AppStream metadata' \
	  'release        Build the unsigned local source/SBOM/checksum bundle' \
	  'release-check  Rebuild twice and verify deterministic output' \
	  'publish        Refuse publication until coordinates and a publisher are reviewed'

configure:
	$(CMAKE) -S . -B $(BUILD_DIR) -DCMAKE_BUILD_TYPE=RelWithDebInfo -DBUILD_WERROR=ON

build: configure
	$(CMAKE) --build $(BUILD_DIR) --parallel

test: build
	$(CMAKE) --build $(BUILD_DIR) --target build_tests --parallel
	QT_QPA_PLATFORM=offscreen ctest --test-dir $(BUILD_DIR)/tests --output-on-failure --exclude-regex lyrics_live_tests

check: protocol-check test-registry
	$(PYTHON) -m py_compile release/build.py release/check.py release/publish.py
	$(PYTHON) release/check.py --policy-only

metadata-check:
	desktop-file-validate dist/unix/org.barebuh.Barebuh.desktop
	appstreamcli validate --no-net --override=url-homepage-missing=pedantic,developer-info-missing=pedantic dist/unix/org.barebuh.Barebuh.metainfo.xml

release:
	$(PYTHON) release/build.py --output $(RELEASE_DIR)

release-check:
	$(PYTHON) release/check.py

publish:
	$(PYTHON) release/publish.py
