package dev.litegres.flyway

import dev.litegres.core.PGliteInitializer
import org.flywaydb.core.Flyway

/**
 * A small optional convenience over [dev.litegres.core.PGliteDatabaseBuilder.withInitializer]
 * for running Flyway migrations after PGlite starts. Flyway is only a dependency
 * of this module — `pglite-core` remains usable without it.
 *
 * ```kotlin
 * val database = PGliteDatabase.builder()
 *     .withInitializer(PGliteFlyway.migrate())
 *     .build()
 * ```
 */
object PGliteFlyway {

    @JvmStatic
    @JvmOverloads
    fun migrate(locations: List<String> = listOf("classpath:db/migration")): PGliteInitializer =
        PGliteInitializer { connectionInfo ->
            Flyway.configure()
                .dataSource(connectionInfo.jdbcUrl, connectionInfo.username, connectionInfo.password)
                .locations(*locations.toTypedArray())
                // PGlite serializes queries across connections by tracking a single
                // "current transaction owner" handler; Flyway's default advisory-lock
                // strategy holds one physical connection inside a long-lived
                // transaction (BEGIN ... SET ROLE ... COMMIT) for the whole migrate()
                // call, which deadlocks against any other connection PGlite tries to
                // serve in the meantime. Disabling the transactional lock switches
                // Flyway to plain, individually-committed pg_advisory_lock/unlock
                // calls, which avoids holding a transaction open across the operation.
                .configuration(mapOf("flyway.postgresql.transactional.lock" to "false"))
                .load()
                .migrate()
        }
}
