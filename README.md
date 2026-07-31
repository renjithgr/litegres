# litegres

**A fast, Docker-free alternative to PostgreSQL Testcontainers for JVM integration tests.**

litegres launches [PGlite](https://pglite.dev) — PostgreSQL compiled to WebAssembly, running inside [Bun](https://bun.sh) — as a child process, exposes it over the real PostgreSQL wire protocol on a local TCP port, and hands you back an ordinary JDBC URL. Your Kotlin or Java code (Spring Boot, Flyway, jOOQ, JPA, plain JDBC — anything that speaks PostgreSQL over JDBC) connects with the standard `org.postgresql:postgresql` driver, completely unaware that there's no real `postgres` binary, no container runtime, and no Docker daemon involved.

It is **not** a claim that PGlite is a container, and **not** a claim that PGlite is a complete, certified PostgreSQL replacement. See [Compatibility limitations](#compatibility-limitations) below — read it before you rely on this for anything beyond fast local/CI integration tests.

## 30-second quick start

```bash
# once: install Bun, the only supported development runtime
curl -fsSL https://bun.sh/install | bash
```

```kotlin
PGliteDatabase.builder().build().use { database ->
    database.start()
    println(database.jdbcUrl) // jdbc:postgresql://127.0.0.1:54321/postgres?sslmode=disable&prepareThreshold=0

    DriverManager.getConnection(database.jdbcUrl, database.username, database.password).use { conn ->
        conn.createStatement().use { it.execute("select 1") }
    }
}
```

That's it — no Docker, no `docker-compose.yml`, no waiting for a container to become healthy.

## Plain JDBC example

```kotlin
import dev.litegres.core.PGliteDatabase
import java.sql.DriverManager
import java.time.Duration

val database = PGliteDatabase.builder()
    .databaseName("postgres")
    .username("postgres")
    .password("postgres")
    .startupTimeout(Duration.ofSeconds(15))
    .withInitScript("classpath:schema.sql")
    .withInitScript("classpath:test-data.sql")
    .build()

database.start()

DriverManager.getConnection(database.jdbcUrl, database.username, database.password).use { conn ->
    conn.createStatement().use { statement ->
        statement.executeQuery("select count(*) from accounts").use { rs ->
            rs.next()
            println(rs.getInt(1))
        }
    }
}

database.close()
```

## JUnit 5 example

```kotlin
import dev.litegres.junit5.PGliteExtension
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.extension.RegisterExtension

class AccountRepositoryTest {

    companion object {
        @JvmField
        @RegisterExtension
        val database = PGliteExtension.builder()
            .withInitScript("classpath:schema.sql")
            .build()
    }

    @Test
    fun `finds accounts by id`() {
        // database.jdbcUrl / .host / .port / .username / .password
    }
}
```

By default the extension is class-scoped (`PGliteLifecycle.PER_CLASS`): one database for the whole test class. Pass `.lifecycle(PGliteLifecycle.PER_TEST)` for a fresh database per test method — useful given PGlite's single shared session (see [Compatibility limitations](#compatibility-limitations)), at the cost of a slower suite.

## Spring Boot example

```kotlin
import dev.litegres.core.PGliteDatabase
import dev.litegres.spring.PGliteSpring
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.test.context.DynamicPropertyRegistry
import org.springframework.test.context.DynamicPropertySource

@SpringBootTest
class AccountRepositoryTest {

    companion object {
        private val database = PGliteDatabase.builder().build().also { it.start() }

        @JvmStatic
        @DynamicPropertySource
        fun databaseProperties(registry: DynamicPropertyRegistry) {
            PGliteSpring.applyTo(registry, database)
        }
    }
}
```

`PGliteSpring.applyTo` sets `spring.datasource.{url,username,password,driver-class-name}` plus a **conservative Hikari pool** (`maximum-pool-size=1`, `minimum-idle=1`) — deliberately, since PGlite is a single-session backend and a bigger pool would not buy real concurrency. See [Compatibility limitations](#compatibility-limitations).

## Flyway example

```kotlin
import dev.litegres.core.PGliteDatabase
import dev.litegres.flyway.PGliteFlyway

val database = PGliteDatabase.builder()
    .withInitializer(PGliteFlyway.migrate(listOf("classpath:db/migration")))
    .build()

database.start() // migrations have already run by the time start() returns
```

`litegres-flyway` is a separate, optional module — `litegres-core` has no Flyway dependency. Internally it's just `PGliteDatabaseBuilder.withInitializer { connectionInfo -> Flyway.configure()... }`, so you can do the same thing yourself without the module if you want more control.

## Requirements

- JDK 21+
- [Bun](https://bun.sh) installed locally (development mode) — **Node.js is not supported**. This project is Bun-only by design; see [Roadmap](#roadmap) for planned standalone-executable distribution that won't need Bun at all.
- Gradle (the wrapper is checked in — use `./gradlew`)

## Bun runtime discovery

Resolution order, first match wins:

1. Explicit builder configuration — `.withBunExecutable(path)`, `.withRuntimeExecutable(path)`, or `.useBundledRuntime()`
2. `LITEGRES_RUNTIME_PATH` — path to an externally-compiled standalone runtime executable
3. This library's own bundled standalone executable for the current platform (only present if you built it — see [Packaging](#packaging-and-runtime-modes) below)
4. `LITEGRES_BUN_PATH` — path to a `bun` executable
5. `bun` found on `PATH`

If none of these resolve, `PGliteRuntimeNotFoundException` explains exactly what was checked and how to fix it — install Bun, or point at one of the above.

## Lifecycle

```
NEW → STARTING → RUNNING → STOPPING → STOPPED
        └──────────────────→ FAILED
```

- `start()` is idempotent: calling it again while `RUNNING` is a no-op; it never launches a second process.
- `close()` is idempotent and safe to call even if `start()` was never called.
- Once `STOPPED` or `FAILED`, a `PGliteDatabase` cannot be restarted — construct a new one.
- A JVM shutdown hook is registered while running and deregistered on a normal `close()`, so a forgotten `close()` still won't leave orphaned processes behind.
- Transitions are guarded by a lock — safe to call `start()`/`close()` from multiple threads, though `start()` is inherently serial (concurrent callers simply queue behind the first).

## Packaging and runtime modes

Two modes, both reading PGlite's WASM/data assets from an explicit directory next to the launcher (a real, on-disk asset directory the JVM extracts to a private temp dir — see [Compatibility limitations](#compatibility-limitations) for why this had to be explicit rather than PGlite's own default relative-path resolution):

- **Development mode** — requires Bun installed. `litegres-core` bundles the TypeScript launcher as a single dependency-free JS file (`bun build --target=bun`) plus PGlite's WASM/data assets as classpath resources; at runtime these are extracted to a temp directory and run as `bun <bundle.js> <config>`.
- **Standalone executable mode** — `bun build --compile` produces a single self-contained executable (Bun itself included) for the *host* platform, packaged as a classpath resource under `litegres-runtime/bin/<platform-id>/`. `.useBundledRuntime()` extracts and runs it directly — no Bun installation needed on the machine running the tests. Supported platform identifiers: `darwin-aarch64`, `darwin-x86_64`, `linux-aarch64`, `linux-x86_64`, `windows-x86_64` (only the platform you actually built on will be present; missing platforms fail with a clear "not present on the classpath" error rather than silently using the wrong binary).

Build/package the runtime with:

```bash
./gradlew :litegres-core:buildPGliteRuntime   # typecheck + bun:test + package both modes
```

`./gradlew build` and `./gradlew test` do this automatically as part of `processResources` — you do not need to run it separately in normal development.

## Compatibility limitations

PGlite is real PostgreSQL, but it runs Postgres's single-user bootstrap mode compiled to WASM, single-threaded, inside one Bun process. That has real, sharp edges — some documented by PGlite itself, some discovered while building this library:

- **One shared backend session for every connection.** PGlite is single-user: every socket connection you open — from any number of separate JDBC `Connection` objects — is bridged onto the *same* underlying Postgres session. Consequences we hit directly:
  - `current_database()` / `current_user` are **always** `postgres`/`postgres`, no matter what database/username you put in the JDBC URL — PGlite's socket layer does not read the wire-protocol StartupMessage's requested db/user at all. `.databaseName()`/`.username()` are still accepted (and appear in the URL, since some tools require *some* value there), but they provide no real per-database or per-role isolation.
  - There is **no password authentication** — any password is accepted.
  - Server-side prepared statement names are **not connection-private** — a second JDBC connection can collide with a name a prior (still "connected" from Postgres's point of view) connection never released, failing with `prepared statement "S_1" already exists`. litegres works around this by appending `&prepareThreshold=0` to the JDBC URL it hands you (the same trick used for PgBouncer transaction-pooling mode, for the same underlying reason).
  - **An error on one statement can surface on a *later* statement's response**, if both run over the same connection. We reproduced this independently of this library with a raw JDBC connection against the runtime directly — it's a PGlite/pglite-socket wire-protocol bridging limitation, not a bug in this project. Don't assume "no exception here" means "this statement succeeded" when reusing one connection across statements that might fail; give risky/independent operations their own connections, as this project's own test suite does.
  - **LISTEN/NOTIFY is not delivered across connections.** NOTIFY executes without error, but pglite-socket does not push the asynchronous NotificationResponse to a *different* connection's LISTEN — only real concurrent PostgreSQL backends do that.
  - A long-held open transaction on one connection can **stall queries on every other connection** (PGlite's query queue only serves the transaction owner's next query while a transaction is open). This is why `litegres-flyway` disables Flyway's default transactional advisory-lock strategy (`flyway.postgresql.transactional.lock=false`) — Flyway's default holds a transaction open across the whole migrate() call, which deadlocked against this exact limitation.
- **Do not use PGlite to validate**: realistic concurrent database sessions, deadlocks, lock contention, connection-pool exhaustion, replication, failover, WAL behavior, external PostgreSQL extensions your production database relies on, SSL/TLS behavior, OS-level PostgreSQL behavior, or performance characteristics relative to native PostgreSQL. `SELECT ... FOR UPDATE` and advisory locks execute as valid SQL, but there is no second concurrent backend to actually contend with, so real locking semantics are not exercised.
- **This is not production certification.** PGlite is alpha-status software (per its own README) with real, sharp single-session semantics. Treat litegres as a fast inner-loop tool, not a substitute for testing against real PostgreSQL before release.

### Recommended two-tier testing strategy

```
Fast integration tests:    PGlite, on every local run and every pull request.
Compatibility tests:       native PostgreSQL via Testcontainers, in CI or before release.
```

Use litegres for the tests you run constantly (schema shape, query correctness, migrations, repository logic). Keep a smaller Testcontainers-backed suite — gated in CI, or run before a release — for anything touching concurrency, locking, extensions, or replication.

## PGlite vs. Testcontainers

| Capability | litegres | PostgreSQL Testcontainers |
|---|---|---|
| Requires Docker | No | Yes |
| Cold startup time | Milliseconds–low seconds | Seconds (image pull aside) |
| Real, separate PostgreSQL backend processes | No (single-user WASM session) | Yes |
| Concurrent session / connection-pool semantics | Not meaningful (see above) | Real |
| Row locking / deadlock behavior | Not meaningful (see above) | Real |
| LISTEN/NOTIFY across connections | Not supported | Real |
| Extensions (PostGIS, custom `.so`, etc.) | Only what PGlite ships/supports | Any |
| Replication / WAL / failover | No | Yes (with setup) |
| SSL/TLS | No (`sslmode=disable` only) | Yes |
| PostgreSQL version fidelity | PGlite's WASM build (see `postgresVersion`) | Exact, real PostgreSQL |
| Standard JDBC driver | Yes | Yes |
| Docker daemon required in CI | No | Yes |

## Troubleshooting

- **`PGliteRuntimeNotFoundException`** — the exception message lists every location checked (env vars, bundled resources, `PATH`). Install Bun, or set `LITEGRES_BUN_PATH` / `LITEGRES_RUNTIME_PATH`.
- **`LITEGRES_BUN_PATH` points at an invalid executable** — the exception names the exact path and why it was rejected (missing, not a regular file, not executable).
- **Unsupported operating system / architecture** — `PlatformId` supports `darwin`/`linux`/`windows` × `aarch64`/`x86_64` only; anything else throws `UnsupportedOperationException` rather than guessing.
- **Executable permission errors on the extracted standalone binary** — this project sets the executable bit itself after extraction; if your environment strips exec permissions from temp directories (some hardened CI sandboxes do), fall back to development mode (`.withBunExecutable(...)`, or just have `bun` on `PATH`).
- **macOS quarantine / signing** — a locally-built standalone executable is not notarized. If macOS refuses to run it, `xattr -d com.apple.quarantine <path>` on the extracted binary, or use development mode instead.
- **Missing PGlite WASM assets** — if you see `classpath resource litegres-runtime/... was not found`, the runtime wasn't packaged; run `./gradlew :litegres-core:buildPGliteRuntime`.
- **Child process exits before readiness** — `PGliteProcessExitedException` includes the exit code and recent stderr output.
- **Malformed control messages** — `PGliteReadinessException` includes the raw line that failed to parse and recent stderr, for diagnosing a broken/incompatible runtime build.

## Project status

**MVP / early alpha.** The core lifecycle, JUnit 5 extension, Spring helper, optional Flyway module, both packaging modes (Bun + standalone executable), and an end-to-end test suite (lifecycle, SQL features including documented limitations, Flyway, Spring Boot, plain JDBC, jOOQ) all work and are tested — see the module READMEs/tests for specifics. Not yet published to any Maven repository.

## Roadmap

Documented as future work, not implemented yet:

- Bundled standalone executables for every supported platform (currently: host-platform-only build)
- Database snapshots / migrated-template cloning (start every test from a pre-migrated template instead of re-running Flyway)
- A custom `jdbc:litegres:` driver (no dependency on a spawned TCP server)
- R2DBC support
- Spring Boot service connections (`@ServiceConnection`)
- Gradle test fixtures plugin integration
- Maven support
- A supported-extension registry (which PGlite extensions are bundled/available)

## Repository structure

```
litegres/
├── litegres-runtime/    TypeScript launcher (Bun-only): PGlite + pglite-socket, wire protocol bridge
├── litegres-core/       Kotlin lifecycle API: process management, runtime discovery, JDBC verification
├── litegres-junit5/     JUnit 5 extension (PER_CLASS / PER_TEST)
├── litegres-spring/     @DynamicPropertySource helper with conservative Hikari defaults
├── litegres-flyway/     Optional Flyway convenience (Flyway is not a litegres-core dependency)
└── integration-tests/   End-to-end tests across all modules + a startup-time benchmark
```

## Commands

```bash
./gradlew build                                  # build everything, including the runtime
./gradlew test                                   # unit tests for all modules
./gradlew :integration-tests:integrationTest      # full end-to-end suite (JDBC, JUnit5, Spring, Flyway, jOOQ)
./gradlew :integration-tests:benchmark            # rough startup-time comparison (requires Docker)
./gradlew :litegres-core:buildPGliteRuntime       # typecheck + bun:test + package the runtime explicitly

cd litegres-runtime
bun install
bun run dev     # or: bun test / bun run typecheck / bun run build
```
