# syntax=docker/dockerfile:1
#
# Litegres daemon container image.
#
# Build:    docker build -t litegres/litegresd:0.1.0 .
# Run:      docker run --rm -p 49100:49100 -p 49152-49183:49152-49183 litegres/litegresd:0.1.0
#
# The image is pre-configured for Docker networking:
#   - the control API and every data-plane (PostgreSQL) endpoint bind 0.0.0.0
#     so Docker port publishing can reach them;
#   - databases bind a fixed in-container port range (49152-49183) so the
#     whole range can be published 1:1 with `-p 49152-49183:49152-49183`;
#   - connection info advertises `localhost` so host-side clients (psql,
#     JDBC, the Java client, curl) can connect through the published ports.
#
# All of it can be overridden with LITEGRES_* environment variables.

# ---- build stage: compile the standalone litegresd binary ----
FROM oven/bun:1.2 AS build
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .
RUN bun run build

# ---- runtime stage: just the binary + docker-friendly defaults ----
FROM oven/bun:1.2

COPY --from=build /app/dist/litegresd /usr/local/bin/litegresd

# Bind everything on 0.0.0.0 so published ports are reachable.
ENV LITEGRES_HOST=0.0.0.0 \
    LITEGRES_REJECT_NON_LOCAL_BIND=false \
    # Fixed, predictable runtime dir so clients can read the control token.
    LITEGRES_RUNTIME_DIR=/var/lib/litegres \
    # Databases bind a fixed contiguous range (published 1:1 on the host).
    LITEGRES_DATA_PLANE_PORT_BASE=49152 \
    LITEGRES_DATA_PLANE_PORT_COUNT=32 \
    # Advertise the host-visible address in every connection string.
    LITEGRES_PUBLIC_HOST=localhost

# Control API + the data-plane range (EXPOSE is documentation only; the
# publish flags on `docker run` do the actual mapping).
EXPOSE 49100 49152-49183

# `litegresd status --json` exits non-zero until the daemon has written its
# discovery file; the grep distinguishes READY from STARTING/FAILED.
HEALTHCHECK --interval=5s --timeout=3s --start-period=20s --retries=20 \
    CMD litegresd status --json 2>/dev/null | grep -q '"state": "READY"' || exit 1

CMD ["litegresd", "run"]
