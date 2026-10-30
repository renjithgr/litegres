#!/bin/sh
# Runs PostgreSQL and the Litegres daemon in one container.
#
# PostgreSQL is started through the official image's entrypoint (first-run
# init, then the server); the daemon starts once the server accepts TCP
# connections, and the container stops when either process dies.
set -e

docker-entrypoint.sh postgres \
    -c fsync=off \
    -c synchronous_commit=off \
    -c full_page_writes=off \
    -c max_connections=300 &
PG=$!

# Wait on TCP, not the socket: the image's first-run init server listens on a
# unix socket only, so a TCP probe succeeds only for the real server.
tries=0
until pg_isready -q -h 127.0.0.1 -p 5432 -U postgres; do
  if ! kill -0 "$PG" 2>/dev/null; then
    echo "litegres: postgres exited during startup" >&2
    exit 1
  fi
  tries=$((tries + 1))
  if [ "$tries" -gt 600 ]; then
    echo "litegres: postgres did not accept connections within 120s" >&2
    exit 1
  fi
  sleep 0.2
done

litegresd run &
LG=$!

stop() {
  kill -TERM "$LG" 2>/dev/null || true
  wait "$LG" 2>/dev/null || true
  kill -TERM "$PG" 2>/dev/null || true
  wait "$PG" 2>/dev/null || true
  exit 0
}
trap stop TERM INT

# Stop everything as soon as either process exits.
while kill -0 "$PG" 2>/dev/null && kill -0 "$LG" 2>/dev/null; do
  sleep 1 &
  wait $!
done
stop
