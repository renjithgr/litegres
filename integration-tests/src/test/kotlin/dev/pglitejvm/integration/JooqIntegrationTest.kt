package dev.pglitejvm.integration

import dev.pglitejvm.junit5.PGliteExtension
import org.jooq.SQLDialect
import org.jooq.impl.DSL
import org.jooq.impl.DSL.field
import org.jooq.impl.DSL.table
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.extension.RegisterExtension
import java.sql.DriverManager

/**
 * jOOQ example without codegen (dynamic `table()`/`field()` references), since
 * generating typed jOOQ sources against a PGlite-launched schema is out of
 * scope for this MVP. Demonstrates jOOQ's fluent DSL executing against PGlite
 * through the same JDBC connection any other tool would use.
 */
class JooqIntegrationTest {

    companion object {
        @JvmField
        @RegisterExtension
        val database = PGliteExtension.builder()
            .withInitSql("create table employees (id int primary key, name text not null, salary_cents int not null);")
            .build()
    }

    @Test
    fun `jOOQ DSL inserts and queries against PGlite`() {
        DriverManager.getConnection(database.jdbcUrl, database.username, database.password).use { connection ->
            val create = DSL.using(connection, SQLDialect.POSTGRES)
            val employees = table("employees")
            val id = field("id", Int::class.javaObjectType)
            val name = field("name", String::class.java)
            val salaryCents = field("salary_cents", Int::class.javaObjectType)

            create.insertInto(employees, id, name, salaryCents)
                .values(1, "Grace Hopper", 12_000_00)
                .execute()

            val fetchedName = create.select(name)
                .from(employees)
                .where(id.eq(1))
                .fetchOne(name)

            assertEquals("Grace Hopper", fetchedName)
        }
    }
}
