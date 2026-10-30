# Client integrations

The control API is language-neutral. The MVP ships the daemon, a TypeScript
client (`clients/typescript`), and a **JVM stack** (`jvm/`): a Java client
(`litegres-client`) and a JUnit 5 extension (`litegres-junit5`) with runnable
samples. This document records the integration pattern for other ecosystems
(Rust, Go, Python, Ruby, CLI/CI) so future clients stay consistent.

The pattern in every ecosystem is the same:

1. **Discover** the daemon (runtime dir → `daemon.json`) and read the token.
2. **Create a session** (one per test run / client process).
3. **Create databases** (empty or cloned from a template) per test; treat the
   returned connection details as ordinary PostgreSQL.
4. **Tear down** per test (delete the database) and per run (delete the
   session — this destroys everything it owned).
5. **Lease renewal** keeps long runs alive; TTLs and the reaper handle
   crashes.

## JVM / Spring Boot

Implemented: `jvm/litegres-client` (Java 17, JDK HttpClient + Jackson, with a
launcher that starts `litegresd` on demand), `jvm/litegres-junit5`, and
`jvm/litegres-spring-boot-test` (`@LitegresTest`: one database per JVM, Flyway
templates, reset between tests on a cached context). See `jvm/README.md`.

```java
try (LitegresClient client = LitegresClients.connect()) {
    SessionWithLeaseToken session = client.createSession(
            SessionRequest.create().clientName("my-tests").ttlSeconds(1800));
    DatabaseWithConnection database = client.createDatabase(
            DatabaseRequest.empty().sessionId(session.session().id()).ttlSeconds(600));

    System.setProperty("spring.datasource.url", database.connection().jdbcUrl());
    System.setProperty("spring.datasource.username", database.connection().username());
    System.setProperty("spring.datasource.password", database.connection().password());
}
```

Spring Boot works because the daemon exposes a plain JDBC endpoint
(`jdbc:postgresql://127.0.0.1:PORT/postgres?sslmode=disable`).

## JUnit 5

Implemented: `jvm/litegres-junit5` (see `jvm/README.md`).

```java
@RegisterExtension
static LitegresExtension postgres = LitegresExtension.fromTemplate(templateId);
// every test method gets a fresh database cloned from the template
```

The extension's lifecycle mirrors the HTTP flow: `beforeEach` → create
database, `afterEach` → delete database, `afterAll` → close session.

## JavaScript / TypeScript tests

```ts
beforeEach(async () => {
  database = await client.createDatabase({
    sessionId: session.id,
    templateId,               // optional
  });
});

afterEach(async () => {
  await client.deleteDatabase(database.id);
});
```

## Rust

```rust
let database = client.create_database(&session.id).await?;
let pool = PgPool::connect(&database.connection.postgres_url).await?;
// diesel/sqlx/sqlx-postgres all work — it is an ordinary wire endpoint
```

## Go

```go
conn, err := pgx.Connect(context.Background(), db.Connection.PostgresUrl)
```

## Python

```python
conn = psycopg.connect(db.connection.postgres_url)
```

## Command-line scripts and CI

```bash
litegresd start --background
export LITEGRES_RUNTIME_DIR=...   # per-CI-job runtime dir
# run tests; each test uses the control API (or the CLI) to get a database
litegresd stop
```

CI should give each job its own `LITEGRES_RUNTIME_DIR` (isolation) and use
the daemon's lease TTLs as a safety net for crashed jobs.

## Rules for future clients

- Never put test-runner lifecycle in the generic client; frameworks build
  on top of it.
- Credentials come from the creation response only; never from list/get.
- Lease tokens authorize scoped operations; daemon tokens authorize
  everything.
- Always close sessions in `afterAll`/`finally`; rely on TTLs only as a
  backstop.
