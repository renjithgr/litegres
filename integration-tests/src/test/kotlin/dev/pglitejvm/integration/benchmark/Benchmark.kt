package dev.pglitejvm.integration.benchmark

import dev.pglitejvm.core.PGliteDatabase
import dev.pglitejvm.flyway.PGliteFlyway
import org.testcontainers.containers.PostgreSQLContainer

/**
 * A rough, single-machine startup-time comparison. This is NOT a rigorous
 * benchmark: it runs each scenario once, on whatever machine happens to run
 * it, with no warm-up or statistical repetition. Do not draw broad performance
 * conclusions from it — it only demonstrates the rough order of magnitude of
 * "PGlite vs. Testcontainers cold start", which is the whole reason this
 * project exists. Run with `./gradlew :integration-tests:benchmark`.
 */
fun main() {
    println("pglite-jvm startup benchmark (single run, single machine — order-of-magnitude only)")
    println("=".repeat(80))

    val pgliteMillis = timeMillis {
        PGliteDatabase.builder().build().use { it.start() }
    }
    println("1. PGlite cold startup:                    ${pgliteMillis} ms")

    val pgliteFlywayMillis = timeMillis {
        PGliteDatabase.builder()
            .withInitializer(PGliteFlyway.migrate(listOf("classpath:db/migration")))
            .build()
            .use { it.start() }
    }
    println("2. PGlite startup + Flyway migration:       ${pgliteFlywayMillis} ms")

    val testcontainersMillis = runCatching {
        timeMillis {
            PostgreSQLContainer("postgres:17-alpine").use { it.start() }
        }
    }.onFailure {
        println("3. PostgreSQL Testcontainers cold startup: FAILED (${it.message}) — is Docker running?")
    }.getOrNull()

    if (testcontainersMillis != null) {
        println("3. PostgreSQL Testcontainers cold startup: ${testcontainersMillis} ms")
    }

    println("=".repeat(80))
    if (testcontainersMillis != null) {
        val speedup = testcontainersMillis.toDouble() / pgliteMillis.toDouble()
        println("PGlite started roughly %.1fx faster than Testcontainers on this run.".format(speedup))
    }
    println("Single-machine, single-run numbers — do not generalize. See README for methodology notes.")
}

private inline fun timeMillis(block: () -> Unit): Long {
    val start = System.nanoTime()
    block()
    return (System.nanoTime() - start) / 1_000_000
}
