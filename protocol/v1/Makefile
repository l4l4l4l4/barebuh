.PHONY: check fixtures test

check: test fixtures

test:
	node --test tests/conformance.test.mjs

fixtures:
	node conformance-runner.mjs
