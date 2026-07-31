package dev.litegres.integration.benchmark

import dev.litegres.core.PGliteDatabase
import dev.litegres.flyway.PGliteFlyway
import org.flywaydb.core.Flyway
import org.testcontainers.containers.PostgreSQLContainer
import java.io.File

private const val MIGRATION_LOCATION = "classpath:db/migration"
private const val POSTGRES_IMAGE = "postgres:16-alpine"

/**
 * A repeatable startup-time comparison between litegres and PostgreSQL
 * Testcontainers, covering the scenario this project actually exists for:
 * spinning up a fresh, isolated database for a test suite.
 *
 * This is still a single-machine, single-run-per-invocation benchmark — not a
 * substitute for proper multi-machine, multi-run statistical benchmarking —
 * but it runs several iterations per scenario (after a warm-up) and reports
 * min/median/mean/max/stddev rather than one bare number, so a single fluke
 * run doesn't dominate the picture. Do not draw broad performance conclusions
 * from it; see the README's "Compatibility limitations" section.
 *
 * Run with `./gradlew :integration-tests:benchmark` (requires Docker for the
 * Testcontainers scenarios; the litegres-only scenarios still run without it).
 */
fun main() {
    println("litegres vs Testcontainers startup benchmark")
    println("Single machine, single invocation — see README for methodology notes.")

    val results = mutableListOf<ScenarioResult>()

    results += runScenario("litegres: cold startup (in-memory)", measuredIterations = 7, warmupIterations = 2) {
        PGliteDatabase.builder().build().use { it.start() }
    }

    results += runScenario(
        "litegres: cold startup + Flyway migration",
        measuredIterations = 7,
        warmupIterations = 2,
    ) {
        PGliteDatabase.builder()
            .withInitializer(PGliteFlyway.migrate(listOf(MIGRATION_LOCATION)))
            .build()
            .use { it.start() }
    }

    results += runScenario(
        "litegres: 5 sequential fresh instances",
        measuredIterations = 3,
        warmupIterations = 1,
    ) {
        repeat(5) {
            PGliteDatabase.builder().build().use { it.start() }
        }
    }

    val dockerAvailable = runCatching {
        // Also pulls the Postgres image once, outside of any measured sample.
        PostgreSQLContainer(POSTGRES_IMAGE).use { it.start() }
    }.onFailure {
        println()
        println("Docker/Testcontainers not available (${it.message}) — skipping Testcontainers scenarios.")
    }.isSuccess

    if (dockerAvailable) {
        results += runScenario("Testcontainers: cold startup", measuredIterations = 3) {
            PostgreSQLContainer(POSTGRES_IMAGE).use { it.start() }
        }

        results += runScenario("Testcontainers: cold startup + Flyway migration", measuredIterations = 3) {
            val container = PostgreSQLContainer(POSTGRES_IMAGE)
            container.start()
            try {
                Flyway.configure()
                    .dataSource(container.jdbcUrl, container.username, container.password)
                    .locations(MIGRATION_LOCATION)
                    .load()
                    .migrate()
            } finally {
                container.stop()
            }
        }

        results += runScenario("Testcontainers: 5 sequential fresh instances", measuredIterations = 2) {
            repeat(5) {
                PostgreSQLContainer(POSTGRES_IMAGE).use { it.start() }
            }
        }
    }

    printResultsTable(results)
    printSpeedups(results)
    writeMarkdownReport(results, File("build/benchmark-results.md"))
}
