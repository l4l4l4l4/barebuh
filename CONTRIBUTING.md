# Contributing to Barebuh

Barebuh is an independent GPL-3.0-or-later fork of Strawberry Music Player.
The destination forge and public contribution workflow are unresolved, so this
document defines the local engineering contract without inventing a remote.

## Before changing code

1. Open or reference one narrowly scoped issue or Kanban task.
2. Create a dedicated branch and linked worktree from the intended base.
3. Keep Strawberry's existing copyright, authorship, and license notices.
4. Add attribution only for work you actually authored.
5. Never commit credentials, signing material, generated release artifacts, or
   build directories.

“Barebuh” is the canonical product name. “Dingleberry” may appear only when
explaining the historical alias; do not use it in package names, identifiers,
new UI strings, or release artifacts.

## Code and commits

Use the existing C++17/Qt style and `.clang-format`. Keep each change atomic and
avoid unrelated formatting. Commit subjects follow the inherited convention:
`ClassName: short explanation`, or a concise subject without a class name when
several components change. Do not add a trailing period.

For protocol changes, update schemas, fixtures, both conformance
implementations, and normative documentation together. Provisional namespaces
must remain visibly provisional until their ownership is approved.

## Verification

Run the checks relevant to the change. Release-affecting changes must run the
full local gate:

```sh
make check
```

C++ changes also require feature-enabled and feature-disabled builds:

```sh
cmake -S . -B build-on -DBUILD_WERROR=ON -DENABLE_BAREBUH=ON
cmake --build build-on --parallel
cmake --build build-on --target build_tests
ctest --test-dir build-on/tests --output-on-failure

cmake -S . -B build-off -DBUILD_WERROR=ON -DENABLE_BAREBUH=OFF
cmake --build build-off --parallel
```

Format only changed C++ files and inspect the complete diff before committing.

## Upstream relationship

Generic fixes should remain easy to forward to Strawberry. Upstream-sync work
must record old and new upstream commits, preserve the fork's additive feature
gate, review database migrations and branding-sensitive paths, and rerun all
release gates. Never force-push a published default or release branch.

Until a user-owned remote is explicitly chosen, the existing `origin` is
upstream-only in practice: fetch is permitted, push is not. Do not create,
rename, or replace remotes as part of an ordinary contribution.

## Security and publication

Follow [`SECURITY.md`](SECURITY.md) for vulnerabilities. Remote publication,
release signing, package upload, update feeds, OAuth registrations, and public
announcements require separate human authorization. `make publish` is a
fail-closed guard, not a release command.

No CLA or DCO policy has been selected. A public contribution process must make
that decision before accepting external submissions.
