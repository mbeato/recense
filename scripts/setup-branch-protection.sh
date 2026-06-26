#!/usr/bin/env bash
#
# One-time maintainer setup: protect `main` so the CI `test` job gates every change.
#
# Prevents the 2026-06-25 failure mode: a behavior-moving refactor (D-11, 9e6f309) left
# stale tests, was batched onto main off-CI for ~4 days (~135 commits, zero main CI runs),
# and only surfaced red on the next push. Routing changes through PRs makes CI run before
# merge instead of after.
#
# Requires: gh CLI authenticated with admin on the repo.
# Run:      bash scripts/setup-branch-protection.sh
#
set -euo pipefail

REPO="mbeato/recense"
BRANCH="main"

# "false" (default): admins (you) keep an emergency direct-push / bypass.
# "true": even admins must go through a PR with green CI — a hard gate on yourself.
ENFORCE_ADMINS="false"

# Check names come from the matrix job in .github/workflows/ci.yml.
# If you change the matrix (os / node), update these to match the new check-run names.
read -r -d '' BODY <<JSON || true
{
  "required_status_checks": {
    "strict": true,
    "contexts": ["test (ubuntu-22.04, 22)", "test (macos-15, 22)"]
  },
  "enforce_admins": ${ENFORCE_ADMINS},
  "required_pull_request_reviews": { "required_approving_review_count": 0 },
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false
}
JSON

printf '%s' "$BODY" | gh api -X PUT "repos/${REPO}/branches/${BRANCH}/protection" \
  -H "Accept: application/vnd.github+json" --input -

echo ""
echo "✓ Branch protection applied to ${BRANCH} on ${REPO}:"
echo "  - PRs required (0 approvals) — every change flows through a PR where CI runs."
echo "  - 'test (ubuntu-22.04, 22)' + 'test (macos-15, 22)' must pass and the branch"
echo "    must be up to date with main before merge."
echo "  - enforce_admins=${ENFORCE_ADMINS} (set ENFORCE_ADMINS=true in this script for a hard gate)."
