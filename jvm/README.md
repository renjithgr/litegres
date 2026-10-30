# Litegres JVM: Java client + JUnit 5 extension

Java library and JUnit 5 extension for running tests against a Litegres
daemon.

```
jvm/
├── litegres-client/            io.litegres.client — control-plane client (JDK HTTP + Jackson), daemon launcher
├── litegres-junit5/            io.litegres.junit5 — per-test disposable databases
├── litegres-spring-boot-test/  io.litegres.spring — @LitegresTest for Spring (Boot) tests
├── litegres-testcontainers/    daemon in Docker, Testcontainers style
└── litegres-samples/           sample JUnit tests (need a daemon or a litegresd binary)
```

## Requirements

- JDK 17+ (compiled with `--release 17`; verified with JDK 25)
- Gradle (wrapper included, Gradle 9.6)
- A running Litegres daemon for the samples:
  `litegresd run` (see the repo root README) — client discovery honors the
  JVM property `litegres.runtimeDir` (set by `-PlitegresRuntimeDir`),
  `LITEGRES_RUNTIME_DIR`, `XDG_RUNTIME_DIR`, then the platform default
  runtime dir. See “What `-PlitegresRuntimeDir=<path>` means” below.

## Spring Boot tests (`litegres-spring-boot-test`)

```java
@SpringBootTest
@LitegresTest(migrations = "classpath:db/migration")   // Flyway -> template, built once
class AccountRepositoryTest {
    @Autowired JdbcTemplate jdbc;
    ...
}
```

`@LitegresTest` starts (or finds) the daemon, creates **one database per JVM**
for each distinct configuration, and sets `spring.datasource.url/username/password`
to it. Forked test JVMs (`maxParallelForks`) therefore never share state, and
every class in a JVM with the same configuration shares **one cached Spring
context** and one database.

Isolation inside a JVM is `reset`:

| `reset` | behaviour |
|---|---|
| `BEFORE_CLASS` (default) | restore the database before each class that is not its first user |
| `BEFORE_EACH` | restore before every test method (~15 ms): full isolation with a cached context |
| `NEVER` | you clean up (e.g. `@Transactional`) |

A reset restores the database from its template under the same name and
credentials, terminates its connections, and soft-evicts a Hikari pool so the
cached context keeps working. Other pools must validate connections on borrow.

Sources for the database (at most one): `migrations` (Flyway locations, hashed
into the template fingerprint, rebuilt only when a migration changes, shared by
all forks), `statements`, or `templateId`. The module depends only on
`spring-test` (Flyway is optional), so it works with Spring Boot 3 and 4.

## Starting the daemon from tests

`LitegresClients.connectOrStart()` (used by `LitegresExtension` and
`@LitegresTest`) connects to a running daemon or starts one detached and
leaves it running, so every JVM and run shares it (`litegresd stop` ends it).
Parallel forks are serialized by a file lock. Binary lookup: `-Dlitegres.bin`,
`LITEGRES_BIN`, `litegresd` on `PATH`, then `dist/litegresd` in a parent of the
working directory. `-Dlitegres.postgresUrl=...` (or `LITEGRES_POSTGRES_URL`)
selects the PostgreSQL server; without it the daemon starts a throwaway
container. `-Dlitegres.autoStart=false` disables starting.

```kotlin
// build.gradle.kts of your project
tasks.test {
    systemProperty("litegres.bin", "/usr/local/bin/litegresd")
    systemProperty("litegres.postgresUrl", "postgresql://postgres:postgres@127.0.0.1:5432/postgres")
    maxParallelForks = 4
}
```

## Build and test

```bash
cd jvm
./gradlew build          # compile + run unit tests (client)
./gradlew test -PlitegresRuntimeDir=<path>   # sample tests (requires the daemon)
```

## What `-PlitegresRuntimeDir=<path>` means

When `litegresd` starts, it writes a small **runtime directory** that acts as
its front door for clients:

```text
<runtime-dir>/
├── daemon.json    discovery file: controlUrl, pid, tokenFile, startedAt
└── token          the daemon control token (chmod 600)
```

Any client (the TypeScript client, the Java client, the JUnit extension)
finds and authenticates to the daemon by reading those two files. The
client-side runtime-dir resolution order is:

1. JVM property `-Dlitegres.runtimeDir=...` (Gradle tests set this
   automatically from `-PlitegresRuntimeDir`),
2. environment variable `LITEGRES_RUNTIME_DIR`,
3. `$XDG_RUNTIME_DIR/litegres` (Linux),
4. `~/.local/state/litegres` (macOS / when XDG is unset),
5. the system temp dir.

So **`-PlitegresRuntimeDir=<path>` tells the Gradle tests where the daemon
wrote its `daemon.json`/`token` files** — i.e. "this is the daemon to talk
to". It must point at the same directory the daemon used, and it is the
Java equivalent of starting the daemon with
`LITEGRES_RUNTIME_DIR=<path> ./dist/litegresd start --background`.

### How to find the value

Pick a directory and use it consistently on both sides:

```bash
# 1. start the daemon with an explicit runtime dir
LITEGRES_RUNTIME_DIR=/tmp/litegres-rt ./dist/litegresd start --background

# 2. point the tests at the same directory
cd jvm && ./gradlew test -PlitegresRuntimeDir=/tmp/litegres-rt

# 3. stop
LITEGRES_RUNTIME_DIR=/tmp/litegres-rt ./dist/litegresd stop
```

If you started the daemon *without* an explicit directory, it used the
default for your platform — find it by checking for a `daemon.json` file:

```bash
ls ~/.local/state/litegres/daemon.json   # macOS
ls $XDG_RUNTIME_DIR/litegres/daemon.json # Linux (if XDG_RUNTIME_DIR is set)
```

and pass that directory. When in doubt, `./dist/litegresd status` must
report `READY` before the tests will work.

### Why a Gradle property instead of just the environment variable?

The Gradle *daemon* (a long-lived background process) captures the
environment it was started with. If you set `LITEGRES_RUNTIME_DIR` after the
daemon started — or start tests from a different terminal — the test JVMs
would inherit the stale environment and look in the wrong place. Gradle
`-P` project properties are passed from the command line to the daemon on
every invocation, so they are always fresh. (If you never use a Gradle
daemon — `./gradlew --no-daemon` — the environment variable also works
fine.)

## Using the Java client

```java
try (LitegresClient client = LitegresClients.connect()) {   // discovers daemon + token
    SessionWithLeaseToken session = client.createSession(
            SessionRequest.create().clientName("my-tests").ttlSeconds(1800));

    DatabaseWithConnection database = client.createDatabase(
            DatabaseRequest.empty().sessionId(session.session().id()).ttlSeconds(600)
                    .statement("CREATE TABLE accounts (id bigint primary key, name text)"));

    System.setProperty("spring.datasource.url", database.connection().jdbcUrl());
    System.setProperty("spring.datasource.username", database.connection().username());
    System.setProperty("spring.datasource.password", database.connection().password());

    // ... run your test against the ordinary PostgreSQL endpoint ...

    client.deleteSession(session.session().id());   // destroys owned databases
}
```

The client exposes sessions, databases, templates, leases, exec, status, and
typed `LitegresException` errors with `code`/`status`/`requestId`/`details`.

## Using the JUnit 5 extension

```java
class AccountRepositoryTest {

    @RegisterExtension
    static LitegresExtension postgres = LitegresExtension.empty();

    @Test
    void insertsAnAccount(LitegresDatabase db) throws Exception {
        try (Connection conn = DriverManager.getConnection(db.jdbcUrl(), db.username(), db.password());
             Statement st = conn.createStatement()) {
            st.execute("INSERT INTO accounts VALUES (1, 'alice')");
        }
    }

    @Test
    void anotherIsolatedTest(Connection conn) throws Exception { ... }
}
```

Factories:

- `LitegresExtension.empty()` — fresh empty database per test
- `LitegresExtension.fromTemplate(templateId)` — fresh clone per test
- `LitegresExtension.withStatements("CREATE TABLE ...", ...)` — initialized per test

Fluent configuration: `.ttlSeconds(int)`, `.sessionTtlSeconds(int)`,
`.metadata(key, value)`, `.controlUrl(String)`, `.controlToken(String)`.

Lifecycle: one session per test class (closed in `afterAll`), one database
per test method (deleted in `afterEach`), injected `Connection`s closed
automatically. The extension is parallel-safe (per-test state lives in
per-test stores) — see `LitegresParallelTest`.

Parameter types you can inject: `LitegresDatabase` (connection details) and
`java.sql.Connection` (a live, auto-closed JDBC connection).

## External provisioning (Flyway / Liquibase / Prisma style)

```java
TemplateProvisioning provisioning = client.createTemplate(
        TemplateRequest.forProvisioning("sha256:my-migrations-v1"));

// run your migrations with your normal tooling:
//   flyway migrate -url=<provisioning.provisioningDatabase().jdbcUrl()> ...

Template finalized = client.finalizeTemplate(provisioning.template().id());

DatabaseWithConnection clone = client.createDatabase(
        DatabaseRequest.fromTemplate(provisioning.template().id()).ttlSeconds(600));
```

## Modules

| Module | Purpose | Depends on |
|---|---|---|
| `litegres-client` | control-plane client (JDK HttpClient, Jackson) | jackson-databind |
| `litegres-junit5` | JUnit 5 extension | litegres-client, junit-jupiter-api |
| `litegres-spring-boot-test` | `@LitegresTest` for Spring tests | litegres-client, spring-test (compileOnly), flyway-core (optional) |
| `litegres-samples` | runnable samples (JUnit, JDBC, HikariCP) | junit-jupiter, postgresql, HikariCP |
