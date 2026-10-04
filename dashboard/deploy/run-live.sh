#!/usr/bin/env sh
set -eu
if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
  echo 'Usage: sh dashboard/deploy/run-live.sh /absolute/path/live.env [--check]' >&2
  exit 2
fi
case "$1" in /*) ;; *) echo 'Use an absolute environment-file path' >&2; exit 2;; esac
if [ ! -f "$1" ]; then echo 'Environment file is not readable' >&2; exit 2; fi
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
CONFIG_FILE=$1
shift
exec node --env-file="$CONFIG_FILE" "$HERE/../live-server.mjs" "$@"
