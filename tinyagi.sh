#!/usr/bin/env bash
# tinyAGI primary entrypoint. Delegates to compatibility runtime script.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export TINYAGI_HOME="$SCRIPT_DIR"

# Prefer modern bash on macOS if current shell is too old.
if [ -n "${BASH_VERSINFO:-}" ] && [ "${BASH_VERSINFO[0]}" -lt 4 ]; then
    if [ -x "/opt/homebrew/bin/bash" ]; then
        exec "/opt/homebrew/bin/bash" "$0" "$@"
    elif [ -x "/usr/local/bin/bash" ]; then
        exec "/usr/local/bin/bash" "$0" "$@"
    fi
fi

exec "$SCRIPT_DIR/tinyclaw.sh" "$@"
