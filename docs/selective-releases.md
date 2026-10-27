# Selective main releases

This adapts the selective commit approach from Prenetics/pipeline-node PR #662 to Cloud Run and a `main` production branch. It does not import the AWS CodePipeline implementation.

## Release flow

1. Open **Actions → Prepare selective release**, run it on **main**, choose the source branch, and enter ordered comma-separated commit SHAs. Source commits must be reachable from the source branch, must not already be ancestors of main, and must not be merge/root commits. Maximum 50 commits.
2. Automation starts a new `release/selective-*` branch from current `origin/main`, cherry-picks only those commits, and commits `.release/selection.json`. Conflicts or missing dependencies fail preparation; it never guesses a resolution.
3. It opens a PR to main and explicitly dispatches this repository's verification workflow on the release branch. This explicit dispatch is required because PRs created using `GITHUB_TOKEN` do not automatically trigger ordinary PR CI. No persistent PAT or new secret is required. The dispatched run cannot deploy because deployment requires the main ref.
4. The release-policy job independently replays the selected changes in a temporary Git worktree and compares the entire resulting application tree. Only the provenance manifest is excluded from that comparison. Unrelated edits or a changed main base fail the check. Recreate the release against the current main if it moves. Keep the source branch and selected commits available until verification and deployment finish.
5. Review and merge the PR normally. The main deployment waits for the existing tests and the release-policy check. It builds the exact main commit, resolves the image digest, runs the existing migrations/readiness/promotion safeguards, and records provenance on the candidate revision.

The selected source SHAs differ from the deployed main SHA because cherry-picking and merging create new commits. The dashboard shows both. It reads **observed traffic**, so candidate deployments and rollbacks do not make it falsely report the latest build as live.

## Activation

- First merge this implementation with selective enforcement disabled (the default). Otherwise the bootstrap PR has no release manifest and cannot pass the new policy.
- Enable **Allow GitHub Actions to create and approve pull requests** in the repository's Actions settings. The workflow only creates PRs; it does not approve or merge them. Its permissions are repository-scoped `contents:write`, `pull-requests:write`, and `actions:write` for preparation. Normal CI remains read-only.
- Set repository variable `ENABLE_SELECTIVE_RELEASE=true` to enforce selective-only deployment. The workflow cannot bypass this check by manually dispatching on main. Verify that `ENABLE_GCP_DEPLOY` and the existing `gcp-production` environment are configured as intended.
- Make **Verify selective release provenance** and the existing application verification check required on main, with branches required to be up to date, wherever the repository's plan supports branch protection. Without that protection, the deployment job still fails for an invalid selection, but a user with push rights can place unselected code on main.
- Do not switch to selective-only mode until the workflow exists on main. Prepare the first release after enabling it.

Existing runtime behavior is preserved: these changes do not enable real email/Slack sending, production Shopify writes, or other currently disabled integrations. The existing GitHub environment name `gcp-production` does not imply those business features are live.

## Provenance

Every instrumented candidate records `RELEASE_COMMIT`, `RELEASE_REPOSITORY`, `RELEASE_SOURCE_COMMITS`, `RELEASE_RUN_URL`, and `RELEASE_MODE`. Docker images carry OCI source/commit labels and are deployed by digest. When enforcement is off, selected source commits are deliberately omitted to avoid presenting an old manifest as a new selective release.

## Verification

`python3 scripts/release/test_selective.py` creates isolated temporary Git repositories. It tests exact selection, merge-to-main, unrelated edits, stale bases, duplicates, merge commits, missing dependencies, wrong repository provenance, and invalid input. No remote repository or cloud resource is modified by these tests.
