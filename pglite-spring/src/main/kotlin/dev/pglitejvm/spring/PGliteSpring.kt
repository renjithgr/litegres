package dev.pglitejvm.spring

import dev.pglitejvm.core.PGliteDatabase
import org.springframework.test.context.DynamicPropertyRegistry

/**
 * Wires a started [PGliteDatabase] into Spring's `@DynamicPropertySource` /
 * `DynamicPropertyRegistry`, so `@SpringBootTest` picks it up as the
 * `DataSource` without a static config file.
 *
 * ```kotlin
 * companion object {
 *     private val database = PGliteDatabase.builder().build().also { it.start() }
 *
 *     @JvmStatic
 *     @DynamicPropertySource
 *     fun databaseProperties(registry: DynamicPropertyRegistry) {
 *         PGliteSpring.applyTo(registry, database)
 *     }
 * }
 * ```
 *
 * The default Hikari pool size is deliberately `1`: PGlite is a single-session
 * backend, so a larger pool does not buy real concurrency and would only mask
 * how your application behaves under contention. Use a Testcontainers-backed
 * native PostgreSQL for connection-pool/concurrency-sensitive tests instead —
 * see the project README's "Compatibility limitations" section.
 */
object PGliteSpring {

    const val DEFAULT_HIKARI_MAXIMUM_POOL_SIZE: Int = 1
    const val DEFAULT_HIKARI_MINIMUM_IDLE: Int = 1

    @JvmStatic
    @JvmOverloads
    fun applyTo(
        registry: DynamicPropertyRegistry,
        database: PGliteDatabase,
        hikariMaximumPoolSize: Int = DEFAULT_HIKARI_MAXIMUM_POOL_SIZE,
        hikariMinimumIdle: Int = DEFAULT_HIKARI_MINIMUM_IDLE,
    ) {
        check(database.isRunning()) {
            "PGliteDatabase must already be started before calling PGliteSpring.applyTo() " +
                "— call database.start() first, since @DynamicPropertySource methods run before the Spring context exists"
        }

        registry.add("spring.datasource.url") { database.jdbcUrl }
        registry.add("spring.datasource.username") { database.username }
        registry.add("spring.datasource.password") { database.password }
        registry.add("spring.datasource.driver-class-name") { "org.postgresql.Driver" }
        registry.add("spring.datasource.hikari.maximum-pool-size") { hikariMaximumPoolSize }
        registry.add("spring.datasource.hikari.minimum-idle") { hikariMinimumIdle }
    }
}
