package dev.litegres.core

/**
 * A custom post-startup initializer, e.g. running Flyway migrations. Declared as
 * a `fun interface` so it is usable as a lambda from both Kotlin and Java.
 */
fun interface PGliteInitializer {
    fun initialize(connectionInfo: PGliteConnectionInfo)
}
