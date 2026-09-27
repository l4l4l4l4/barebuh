.PHONY: help configure build test check metadata-check release release-check publish

PYTHON ?= python3
CMAKE ?= cmake
BUILD_DIR ?= build
RELEASE_DIR ?= build/release

help:
	@printf '%s\n' \
	  'configure      Configure a RelWithDebInfo build with warnings as errors' \
	  'build          Build Barebuh' \
	  'test           Build and run the offline test suite' \
	  'check          Run protocol and release-hygiene checks' \
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

check:
	$(MAKE) -C protocol/v1 check
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
