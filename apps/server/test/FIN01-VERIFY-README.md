# Adversarial FIN-01 characterising suites — read this before running them

These files describe the **pre-fix, defective** behaviour of the FIN-01/B02 contour.
They are a historical evidence snapshot of the three live holes found in the public
contour, kept on the branch `feat/fin01-adversarial-verify` (remote `2aa267e`).

- `fin01-verify-*.test.mjs` (6 files, 13 tests) — characterising suites: they were
  **green against the defective code** and must now be **RED** wherever the defects
  were fixed. A red result here is the expected outcome, not a regression.
- `fin01-verify-defect-contract.mjs` (4 tests) — deliberately failing contract of the
  defect. Not matched by `*.test.mjs` globs, so it never runs in the default suite.
- `fin01-verify-support.mjs` — shared helper.

The **normative** replacement lives on `feat/b13-acceptance-closure` as
`apps/server/test/fin01-release-contract.test.mjs` (4/4 green; 3 of the 4 were red
before the fixes in `f18ae85`).

Do **not** copy these files into another branch's `apps/server/test/`: their glob
matches `*.test.mjs`, so they would turn an unrelated green suite red. That is exactly
what happened once and it cost a round of false-regression triage.
