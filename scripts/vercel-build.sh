#!/bin/sh

set -eu

BUILD_CMD='rm -rf .vercel/output && npm run build'

if [ "${VERCEL_ENV:-}" = "preview" ] && [ -n "${VERCEL_GIT_COMMIT_REF:-}" ]; then
  exec npx convex deploy \
    "$@" \
    --preview-create "${VERCEL_GIT_COMMIT_REF}" \
    --cmd "${BUILD_CMD}" \
    --cmd-url-env-var-name VITE_CONVEX_URL
fi

exec npx convex deploy \
  "$@" \
  --cmd "${BUILD_CMD}" \
  --cmd-url-env-var-name VITE_CONVEX_URL
