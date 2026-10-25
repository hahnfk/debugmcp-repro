# Repository instructions

## Publishing reproduction material

- Prepare reproduction scripts, documentation, and evidence in this repository.
- Open a pull request and merge the required material into this repository's
  `main` branch before creating an upstream GitHub issue that refers to it.
- Public issue instructions and reproduction links must use this repository's
  `main` branch. Do not require a feature-branch checkout or link to a feature
  branch. Verify that all linked files are available on `main` before posting.
- After merging, rerun each newly added reproduction harness from this
  repository's `main` before publishing its upstream issue. Recheck whether the
  pinned Microsoft source baseline still matches the current upstream `main`.
- Keep the tested Microsoft/DebugMCP source commit as the upstream version
  baseline. This is distinct from the reproduction repository's publication
  branch and remains necessary for repeatable results.
- Obtain explicit user authorization before publishing a new upstream issue.
  Approval for earlier issues is not approval for every later finding.
- Temporary German reading copies belong under the ignored `.diagnostics/`
  directory. Keep the English reports as the publication sources.
- Disclose assistance from OpenAI Codex in upstream issue reports. For desktop
  investigations, record the verified desktop app version, build and verification
  date. Distinguish authoring assistance from the reproduction's execution
  environment, and do not infer an unrecorded historical client version.
