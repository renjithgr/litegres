package dev.pglitejvm.integration

import dev.pglitejvm.core.PGliteDatabase
import dev.pglitejvm.spring.PGliteSpring
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test
import org.springframework.boot.autoconfigure.EnableAutoConfiguration
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.context.annotation.Configuration
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.test.context.DynamicPropertyRegistry
import org.springframework.test.context.DynamicPropertySource
import org.springframework.beans.factory.annotation.Autowired

@Configuration
@EnableAutoConfiguration
class SpringBootDatasourceTestConfig

/** Proves a Spring Boot `DataSource` (via Hikari) can be built from a running PGlite instance. */
@SpringBootTest(classes = [SpringBootDatasourceTestConfig::class])
class SpringBootDatasourceIntegrationTest {

    companion object {
        private val database = PGliteDatabase.builder()
            .withInitSql("create table greetings (id int primary key, message text not null);")
            .withInitSql("insert into greetings values (1, 'hello from spring boot');")
            .build()
            .also { it.start() }

        @JvmStatic
        @DynamicPropertySource
        fun databaseProperties(registry: DynamicPropertyRegistry) {
            PGliteSpring.applyTo(registry, database)
        }
    }

    @Autowired
    private lateinit var jdbcTemplate: JdbcTemplate

    @Test
    fun `spring boot starts a HikariCP datasource against PGlite and can query it`() {
        val message = jdbcTemplate.queryForObject(
            "select message from greetings where id = 1",
            String::class.java,
        )
        assertEquals("hello from spring boot", message)
    }
}
