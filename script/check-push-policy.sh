#!/usr/bin/env bash
#
# Content may be pushed straight to master. Code may not.
#
# Reviews arrive as machine-written commits that touch _data/ (and _posts/ for a
# new company) and push directly to master, so that the page rebuilds
# immediately. That path is load-bearing and must keep working without a pull
# request.
#
# Everything else — layouts, includes, HTML, JS, CSS, workflows, config — is
# code. Code reaching users without anyone reading it is exactly how a
# base64-obfuscated popunder loader lived in _layouts/default.html from December
# 2025 to July 2026: it was pushed straight to master in a commit titled
# "init commit", and no one ever opened a diff.
#
# So: a push to master that changes code must come from a merged pull request.
# If it does not, this fails and nothing is deployed.
#
# Usage: check-push-policy.sh <before-sha> <after-sha>

set -euo pipefail

BEFORE="${1:-}"
AFTER="${2:-HEAD}"

# Paths a commit may touch without review. Reviews and company pages are data,
# not code: they cannot execute in a visitor's browser.
CONTENT_ONLY='^(_data/|_posts/)'

# A brand-new branch, or a force push, gives no usable "before". Fall back to
# the single commit rather than guessing, and let the code check below decide.
if [ -z "$BEFORE" ] || ! git cat-file -e "${BEFORE}^{commit}" 2>/dev/null; then
  BEFORE="${AFTER}^"
fi

changed=$(git diff --name-only "$BEFORE" "$AFTER")

if [ -z "$changed" ]; then
  echo "OK — no file changes in this push."
  exit 0
fi

code=$(echo "$changed" | grep -Ev "$CONTENT_ONLY" || true)

if [ -z "$code" ]; then
  count=$(echo "$changed" | wc -l | tr -d ' ')
  echo "OK — content-only push ($count file(s) under _data/ or _posts/). Deploying without review, as intended."
  exit 0
fi

echo "This push changes code, not just content:"
echo "$code" | sed 's/^/    /'
echo

# gh is only available in CI. Locally, report and stop — do not pretend to know.
if [ -z "${GH_TOKEN:-}" ]; then
  echo "No GH_TOKEN, so the pull request cannot be verified here."
  echo "In CI this push would be required to come from a merged pull request."
  exit 0
fi

# Squash-merged and merge-committed PRs both report themselves here, so this
# holds regardless of which merge button the maintainer uses.
pr=$(gh api "repos/${GITHUB_REPOSITORY}/commits/${AFTER}/pulls" \
  --jq '[.[] | select(.merged_at != null)] | first | .number // empty' 2>/dev/null || true)

if [ -n "$pr" ]; then
  echo "OK — these code changes came from merged pull request #${pr}."
  exit 0
fi

cat <<'EOF'
REFUSED — code was pushed straight to master, with no pull request.

Nothing has been deployed. The live site is unchanged.

Content (_data/, _posts/) may be pushed directly; that is how new reviews go
live. Code may not, because code runs in the browser of someone writing an
anonymous review about their employer.

To land this: revert it on master, reopen it as a pull request, and merge it.
EOF
exit 1
