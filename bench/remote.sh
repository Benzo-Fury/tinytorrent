#!/bin/sh
# Runs the benchmark on a remote Docker host through a VPN container.
#   bench/remote.sh <ssh-host> <vpn-container|-> <bench args…>
# Syncs this project, builds the bench image there, and runs it inside the
# VPN container's network namespace (or Docker's default network for "-")
# with a tmpfs work directory.
set -e
host=$1; vpn=$2; shift 2
cd "$(dirname "$0")/.."
COPYFILE_DISABLE=1 tar --no-xattrs --exclude node_modules --exclude .bench --exclude .git -czf - . 2>/dev/null \
  | ssh "$host" 'mkdir -p ~/ttbench/src ~/ttbench/out && cd ~/ttbench/src && tar xzf - 2>/dev/null && docker build -q -f bench/Dockerfile -t tinytorrent-bench . >/dev/null'
net="--network container:$vpn"; [ "$vpn" = "-" ] && net=""
ssh "$host" "docker run --rm $net --tmpfs /work:size=8g -v \$HOME/ttbench/out:/out -e TT_BENCH_DIR=/work tinytorrent-bench $*"
