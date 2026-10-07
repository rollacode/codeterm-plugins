#!/usr/bin/env bash
# Resolve the selected entry point, never a guessed global Python or new venv.
set -eu
refuse() {
  printf '%s\n' "Domios Aider adapter refused launch: $*. Install aider-chat==0.86.2 with uv tool or pipx, or explicitly set plainMode=true." >&2
  exit 2
}
entry=$(command -v aider) || refuse 'aider is not on PATH'
case "$entry" in /*) ;; *) refuse 'entry point is not a file' ;; esac
# Follow entry-point links only. Resolving the Python binary loses venv identity.
links=0
while [ -L "$entry" ]; do
  links=$((links + 1)); [ "$links" -le 20 ] || refuse 'entry-point symlink loop'
  target=$(readlink "$entry")
  case "$target" in /*) entry=$target ;; *) entry=$(dirname "$entry")/$target ;; esac
done
[ -f "$entry" ] || refuse 'entry point is missing'
IFS= read -r first < "$entry" || refuse 'empty entry point'
case "$first" in
  '#!/bin/sh')
    second=$(sed -n '2p' "$entry")
    third=$(sed -n '3p' "$entry")
    [ "$third" = "' '''" ] || refuse 'unknown shell trampoline'
    prefix="'''exec' "
    suffix=' "$0" "$@"'
    case "$second" in "$prefix"*"$suffix") value=${second#"$prefix"}; value=${value%"$suffix"} ;; *) refuse 'unknown exec frame' ;; esac
    relative='"$(dirname -- "$(realpath -- "$0")")"/'
    base=''
    case "$value" in "$relative"*) base=$(cd "$(dirname "$entry")" && pwd)/; value=${value#"$relative"} ;; esac
    case "$value" in
      "'"*"'") value=${value#\'}; value=${value%\'}
        # uv/distlib use single-quote escaping; reject any other shell grammar.
        escaped="'\"'\"'"; value=${value//"$escaped"/\'}
        ;;
      /*) case "$value" in *[\ \;\$\`\"\'\(\)]*) refuse 'unknown unquoted trampoline' ;; esac ;;
      *) refuse 'unknown quoted interpreter' ;;
    esac
    python=$base$value
    ;;
  '#!/usr/bin/env python'|'#!/usr/bin/env python3') python=$(command -v "${first##* }") || refuse 'env Python is unavailable' ;;
  '#!'/*) python=${first#\#!}; case "$python" in *[\ \;\$\`\"\(\)]*) refuse 'unknown shebang arguments' ;; esac ;;
  *) refuse 'unknown launcher format' ;;
esac
grep -Eq '^from aider\.main import main[[:space:]]*$' "$entry" || refuse 'entry point is not aider.main:main'
[ -x "$python" ] || refuse 'entry-point Python is unavailable'
plugin_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
exec "$python" "$plugin_dir/domios_adapter.py" "$@"
