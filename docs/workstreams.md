# Barebuh workstreams

This document mirrors the Kanban dependency graph by task ID. Kanban state is
a live operational record; this file is the release traceability snapshot for
the local client line.

```mermaid
flowchart TD
  A["t_0aac8c65<br/>Architecture and implementation plan"]
  P["t_85f93b8a<br/>Protocol schemas and fixtures"]
  R2["t_526d83c0<br/>Second remediation review: PASS"]
  V0["t_635ba349<br/>Private MVP verification: PASS"]
  RR["t_eee9e4e7<br/>Rebase review: PASS"]
  RV["t_32faafff<br/>Rebase verification: PASS"]
  I["t_c23dfde5<br/>Local client integration"]
  A1["t_844ca855<br/>Read-only release audit"]
  F["t_9b18a45c<br/>Release-gate remediation"]
  PR["t_f5905823<br/>Pinned-commit implementation review"]
  PV["t_14b350e7<br/>Pinned-commit safeguards verification"]
  H["t_8359c76b<br/>Branding and release hygiene"]
  R["t_e7edb4f5<br/>Independent release review"]
  V["t_ce5cefce<br/>Deterministic release verification"]
  O["t_289536b8<br/>HUMAN GATE: ownership coordinates"]
  X["t_93ba3260<br/>HUMAN GATE: create/publish fork"]

  A --> P
  P --> R2
  R2 --> V0
  V0 --> RR
  RR --> RV
  RV --> I
  I --> H
  A1 --> H
  F --> PR
  PR --> PV
  PR --> H
  PV --> H
  H --> R
  R --> V
  V --> O
  O --> X
```

## Gate semantics

- Initial implementation commit `b8826cf5d7b607046731360644e546271f591844`
  and DAG commit `a6a133669d33fd98682ba487f4687a4ad2a6a36a` were superseded after review.
  Remediation task `t_9b18a45c` produced final candidate
  `8c44141d305646de9ccb57ce59097c6af5d1e491`.
- `t_f5905823` and `t_14b350e7` are the pre-completion review and safeguards
  verification gates for that exact final candidate.
  They use active project profiles and keep `t_8359c76b` pending until both
  return evidence.
- Completed implementation is not approval. `t_e7edb4f5` must return an explicit
  PASS before `t_ce5cefce` may verify the same exact commit.
- `t_ce5cefce` approves only an unsigned local candidate. It does not authorize
  a remote, signing, upload, package repository, update feed, or announcement.
- `t_289536b8` is blocked until a human supplies the forge, owner/organization,
  repository name, visibility, canonical URLs, release destination, signing
  identity, and remote policy.
- `t_93ba3260` is a second blocked human gate for the actual external action.
  Ownership choices do not themselves authorize creation or publication.
- Superseded task `t_2ac60841` and its old verification lane are intentionally
  omitted from the active path because they pointed at the primary checkout;
  the corrected exact-worktree lane above preserves the same acceptance gates.

## Remaining independent workstreams

Registry-node implementation, deployment, protocol-namespace governance,
translation service, binary packaging, reproducible toolchain closure, and
public support/governance are separate workstreams. They must receive their own
task-ID DAGs before execution and must not be inferred from this client-release
lane.
