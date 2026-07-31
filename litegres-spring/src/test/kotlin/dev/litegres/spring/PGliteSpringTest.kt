package dev.litegres.spring

import dev.litegres.core.PGliteDatabase
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Test
import org.springframework.test.context.DynamicPropertyRegistry
import java.util.function.Supplier

/** Records added properties without needing a full Spring [org.springframework.context.ApplicationContext]. */
private class RecordingPropertyRegistry : DynamicPropertyRegistry {
    val values = linkedMapOf<String, Any?>()
    override fun add(name: String, valueSupplier: Supplier<Any>) {
        values[name] = valueSupplier.get()
    }
}

class PGliteSpringTest {

    private var database: PGliteDatabase? = null

    @AfterEach
    fun tearDown() {
        database?.close()
    }

    @Test
    fun `applies datasource properties and conservative hikari defaults`() {
        val db = PGliteDatabase.builder().build().also { it.start() }
        database = db

        val registry = RecordingPropertyRegistry()
        PGliteSpring.applyTo(registry, db)

        assertEquals(db.jdbcUrl, registry.values["spring.datasource.url"])
        assertEquals(db.username, registry.values["spring.datasource.username"])
        assertEquals(db.password, registry.values["spring.datasource.password"])
        assertEquals("org.postgresql.Driver", registry.values["spring.datasource.driver-class-name"])
        assertEquals(1, registry.values["spring.datasource.hikari.maximum-pool-size"])
        assertEquals(1, registry.values["spring.datasource.hikari.minimum-idle"])
    }

    @Test
    fun `hikari pool sizes can be overridden`() {
        val db = PGliteDatabase.builder().build().also { it.start() }
        database = db

        val registry = RecordingPropertyRegistry()
        PGliteSpring.applyTo(registry, db, hikariMaximumPoolSize = 4, hikariMinimumIdle = 2)

        assertEquals(4, registry.values["spring.datasource.hikari.maximum-pool-size"])
        assertEquals(2, registry.values["spring.datasource.hikari.minimum-idle"])
    }

    @Test
    fun `refuses to apply properties for a database that has not been started`() {
        val db = PGliteDatabase.builder().build()
        database = db
        val registry = RecordingPropertyRegistry()

        assertThrows(IllegalStateException::class.java) {
            PGliteSpring.applyTo(registry, db)
        }
    }
}
