#!/usr/bin/env bash
# Reset state between runs: drop leftover databases on the baseline Postgres
# (litegres-test-pg on :55432) and restart the Litegres daemon (default native
# engine, which starts its own managed postgres container).
set -e
cd "$(dirname "$0")"
rm -rf build/bench-* build/spike-*
docker exec litegres-test-pg psql -U postgres -qAt -c "SELECT 'DROP DATABASE IF EXISTS ' || quote_ident(datname) || ' WITH (FORCE);' FROM pg_database WHERE datname NOT IN ('postgres','template0','template1')" | docker exec -i litegres-test-pg psql -U postgres -q >/dev/null
RT=/tmp/litegres-spike-rt
LITEGRES_RUNTIME_DIR=$RT ../../dist/litegresd stop >/dev/null 2>&1 || true
sleep 1
LITEGRES_RUNTIME_DIR=$RT ../../dist/litegresd start --background --port 49300 --max-databases 32 "$@" >/dev/null
for i in $(seq 1 60); do LITEGRES_RUNTIME_DIR=$RT ../../dist/litegresd status 2>/dev/null | grep -q "state: READY" && break; sleep 1; done
