#!/bin/sh
# Fast path for quietsync's Claude Code hooks. Finds this session's bridge
# socket from the hook input and forwards the input to it; exits right away
# when quietsync isn't running in this session. If a bridge is there but can't
# answer a tool check, the human is asked instead (fail closed).
# Runs on every tool call, so it sticks to shell builtins plus one sed.
here=${0%/*}
[ "$OS" = Windows_NT ] && exec node "$here/hook.mjs" "$1"
input=$(cat)
home=${QUIETSYNC_HOME:-$HOME/.quietsync}
run=${QUIETSYNC_RUN_DIR:-$home/run}

# session_id is a top-level key Claude Code writes before any nested object.
# Anything else (it only appears nested, or not at all) goes to the JSON parser.
sid=$(printf '%s' "$input" | sed -n 's/^{[^{}]*"session_id"[ ]*:[ ]*"\([A-Za-z0-9_-]\{1,12\}\)[A-Za-z0-9_-]*".*/\1/p;q')
if [ -z "$sid" ]; then
  case "$input" in
    *'"session_id"'*) printf '%s' "$input" | QUIETSYNC_HOOK_PPID=$PPID node "$here/hook.mjs" "$1"; exit 0 ;;
    *) exit 0 ;;
  esac
fi

sock=$run/$sid.sock
# At startup the bridge starts alongside this hook: give it up to 3 seconds,
# so what's waiting can be said now rather than at the first prompt.
if [ "$1" = session-start ] && [ ! -S "$sock" ] && [ -d "$run" ]; then
  i=0; while [ $i -lt 15 ] && [ ! -S "$sock" ]; do sleep 0.2; i=$((i + 1)); done
fi
# After /clear or a resume the session id changes but the bridge doesn't.
[ -S "$sock" ] || sock=$run/p$PPID.sock
if [ ! -S "$sock" ]; then
  # At startup this can run before the session's bridge listens. What's waiting
  # comes from the last summary another session wrote; telling the bridge
  # later, in the background, lets it know its hooks are live.
  [ "$1" = session-start ] && [ -f "$run/waiting.json" ] && cat "$run/waiting.json"
  if [ "$1" = session-start ] && command -v curl >/dev/null 2>&1; then
    (i=0; while [ $i -lt 15 ] && [ ! -S "$run/$sid.sock" ]; do sleep 1; i=$((i + 1)); done
     [ -S "$run/$sid.sock" ] && printf '%s' "$input" | curl -s --max-time 5 --unix-socket "$run/$sid.sock" -H 'content-type: application/json' --data-binary @- "http://quietsync/hook/raw/session-start") </dev/null >/dev/null 2>&1 &
  fi
  exit 0
fi

if ! command -v curl >/dev/null 2>&1; then
  printf '%s' "$input" | QUIETSYNC_HOOK_PPID=$PPID node "$here/hook.mjs" "$1"
  exit 0
fi
if ! printf '%s' "$input" | curl -sf --max-time 8 --unix-socket "$sock" -H 'content-type: application/json' --data-binary @- "http://quietsync/hook/raw/$1"; then
  if [ "$1" = "pre-tool-use" ]; then
    printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"quietsync is running in this session but did not answer, so it could not check this call. Approve only if you expect it."}}'
  fi
fi
exit 0
