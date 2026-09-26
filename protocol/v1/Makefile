.PHONY: check fixtures test independent

check: test fixtures

independent:
	python3 python-conformance.py

test:
	node --test tests/conformance.test.mjs

fixtures:
	node conformance-runner.mjs
