# syntax=docker/dockerfile:1
#
# Litegres container image: PostgreSQL 17 plus the litegresd daemon.
#
# Build:    docker build -t litegres/litegresd:0.1.0 .
# Run:      docker run --rm -p 49100:49100 -p 5432:5432 litegres/litegresd:0.1.0
#
# One PostgreSQL server (tuned for throwaway data: fsync off) hosts every
# database; the daemon manages them through the control API on 49100.
#
#   - the control API binds 0.0.0.0 so Docker port publishing can reach it;
#   - PostgreSQL's own port 5432 is the only data port: every database is
#     reachable there, told apart by database name;
#   - connection info advertises `localhost` so host-side clients (psql, JDBC,
#     the Java client, curl) can connect through the published ports. If you
#     publish 5432 on a different host port, set LITEGRES_PUBLIC_PORT.
#
# The server uses a fixed, loopback-published test password; do not expose
# this container to untrusted networks. Everything can be overridden with
# LITEGRES_* / POSTGRES_* environment variables.

# ---- build stage: compile the standalone litegresd binary ----
FROM oven/bun:1.2 AS build
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .
RUN bun run build

# ---- runtime stage: PostgreSQL + the binary ----
FROM postgres:17

COPY --from=build /app/dist/litegresd /usr/local/bin/litegresd
COPY docker/entrypoint.sh /usr/local/bin/litegres-entrypoint

ENV POSTGRES_PASSWORD=litegres \
    LITEGRES_POSTGRES_URL=postgresql://postgres:litegres@127.0.0.1:5432/postgres \
    LITEGRES_POSTGRES_DOCKER=false \
    LITEGRES_HOST=0.0.0.0 \
    LITEGRES_REJECT_NON_LOCAL_BIND=false \
    # Fixed, predictable runtime dir so clients can read the control token.
    LITEGRES_RUNTIME_DIR=/var/lib/litegres \
    # Advertise the host-visible address in every connection string.
    LITEGRES_PUBLIC_HOST=localhost

# Control API + PostgreSQL (EXPOSE is documentation only; the publish flags
# on `docker run` do the actual mapping).
EXPOSE 49100 5432

# `litegresd status --json` exits non-zero until the daemon has written its
# discovery file; the grep distinguishes READY from STARTING/FAILED.
HEALTHCHECK --interval=5s --timeout=3s --start-period=30s --retries=20 \
    CMD litegresd status --json 2>/dev/null | grep -q '"state": "READY"' || exit 1

ENTRYPOINT ["litegres-entrypoint"]
