#!/bin/sh
# Conformance: Tiny Torrent against libtorrent (qBittorrent's engine) and
# Transmission, both directions, plaintext and RC4, .torrent and magnet;
# seeding in seed mode; a v1+v2 hybrid torrent with padding files.
# Runs on any Docker host: sh conformance/run.sh
set -u
cd "$(dirname "$0")/.."
NET=ttconf
VOL=ttconf-shared
TRANSMISSION=lscr.io/linuxserver/transmission:latest

echo "Building images…"
docker build -q -f bench/Dockerfile -t tinytorrent-bench . >/dev/null
docker build -q -f conformance/Dockerfile.libtorrent -t tt-libtorrent conformance >/dev/null
docker pull -q $TRANSMISSION >/dev/null
docker network create $NET >/dev/null 2>&1 || true
docker volume rm -f $VOL >/dev/null 2>&1; docker volume create $VOL >/dev/null

tt() { docker run --rm --network $NET -v $VOL:/shared --entrypoint bun "$@"; }
cleanup() { docker rm -f tt-tracker tt-seed lt-seed tr >/dev/null 2>&1; }
cleanup

tt tinytorrent-bench conformance/peer.ts make /shared http://tt-tracker:8000/announce
docker run --rm -v $VOL:/shared tt-libtorrent make-hybrid /shared http://tt-tracker:8000/announce

# A fresh tracker per case, so no case sees peers from the last one
tracker() {
  docker rm -f tt-tracker >/dev/null 2>&1
  docker run -d --name tt-tracker --network $NET --entrypoint bun tinytorrent-bench conformance/tracker.ts 8000 >/dev/null
  sleep 1
}

transmission() { # transmission <encryption flag: -er|-ep|-et>
  docker run -d --name tr --network $NET -v $VOL:/shared -e PUID=0 -e PGID=0 -e PEERPORT=51413 $TRANSMISSION >/dev/null
  for i in $(seq 1 30); do docker exec tr transmission-remote -l >/dev/null 2>&1 && break; sleep 1; done
  docker exec tr transmission-remote "$1" >/dev/null
}

PASS=0; FAIL=0
report() { # report <name> <output>
  line=$(echo "$2" | grep -E "^(OK|FAIL)" | tail -1)
  [ -z "$line" ] && line="FAIL: no result ($(echo "$2" | tail -2 | tr '\n' ' '))"
  case "$line" in OK*) PASS=$((PASS + 1));; *) FAIL=$((FAIL + 1));; esac
  printf '%-58s %s\n' "$1" "$line"
}

leech_tt() { tt tinytorrent-bench conformance/peer.ts leech /shared "$@" 2>&1; }

for case in "forced require" "disabled prefer" "enabled prefer-plaintext --magnet" "forced prefer --magnet"; do
  set -- $case
  tracker
  docker run -d --name lt-seed --network $NET -v $VOL:/shared tt-libtorrent seed /shared "$1" >/dev/null
  sleep 3
  report "libtorrent seeds ($1) → tinytorrent leeches ($2${3:+, $3})" "$(leech_tt "$2" ${3:-})"
  docker rm -f lt-seed >/dev/null
done

# Hybrid v1+v2 torrent with padding files, both ways
tracker
docker run -d --name lt-seed --network $NET -v $VOL:/shared tt-libtorrent seed /shared enabled hybrid.torrent >/dev/null
sleep 3
report "libtorrent seeds a hybrid torrent → tinytorrent leeches (v1)" "$(leech_tt prefer --torrent hybrid.torrent)"
docker rm -f lt-seed >/dev/null
tracker
docker run -d --name tt-seed --network $NET -v $VOL:/shared --entrypoint bun tinytorrent-bench conformance/peer.ts seed /shared prefer --torrent hybrid.torrent >/dev/null
sleep 5
report "tinytorrent seeds a hybrid torrent from disk → libtorrent leeches" "$(docker run --rm --network $NET -v $VOL:/shared tt-libtorrent leech /shared enabled hybrid.torrent 2>&1)"
docker rm -f tt-seed >/dev/null

for case in "-er prefer" "-et off" "-ep require --magnet" "-ep prefer-plaintext"; do
  set -- $case
  tracker
  transmission "$1"
  docker exec tr transmission-remote -a /shared/payload.torrent -w /shared/data >/dev/null
  sleep 5
  report "Transmission seeds ($1) → tinytorrent leeches ($2${3:+, $3})" "$(leech_tt "$2" ${3:-})"
  docker rm -f tr >/dev/null
done

for case in "require forced" "prefer enabled" "prefer-plaintext disabled" "prefer enabled --seed-mode"; do
  set -- $case
  tracker
  docker run -d --name tt-seed --network $NET -v $VOL:/shared --entrypoint bun tinytorrent-bench conformance/peer.ts seed /shared "$1" ${3:-} >/dev/null
  sleep 3
  report "tinytorrent seeds ($1${3:+, $3}) → libtorrent leeches ($2)" "$(docker run --rm --network $NET -v $VOL:/shared tt-libtorrent leech /shared "$2" 2>&1)"
  docker rm -f tt-seed >/dev/null
done

for case in "require -er" "prefer-plaintext -et"; do
  set -- $case
  tracker
  docker run -d --name tt-seed --network $NET -v $VOL:/shared --entrypoint bun tinytorrent-bench conformance/peer.ts seed /shared "$1" >/dev/null
  transmission "$2"
  docker exec tr transmission-remote -a /shared/payload.torrent -w "/shared/tr-out-$1" >/dev/null
  out="FAIL: Transmission timed out"
  for i in $(seq 1 120); do
    if docker exec tr transmission-remote -t 1 -i 2>/dev/null | grep -q "Percent Done: 100%"; then out="OK: Transmission finished in ${i} s"; break; fi
    sleep 1
  done
  report "tinytorrent seeds ($1) → Transmission leeches ($2)" "$out"
  docker rm -f tt-seed tr >/dev/null
done

cleanup
docker volume rm -f $VOL >/dev/null
docker network rm $NET >/dev/null
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
