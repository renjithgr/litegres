package io.litegres.spring;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.RepeatedTest;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;

/**
 * Flyway migrations become a template; every test method starts from it even
 * though the Spring context (and its connection pool) is cached.
 */
@SpringBootTest(classes = TestApp.class)
@LitegresTest(migrations = "classpath:db/migration", reset = LitegresTest.Reset.BEFORE_EACH)
class FlywayResetBeforeEachTest {

    @Autowired
    JdbcTemplate jdbc;

    @Test
    void usesALitegresDatabaseWithTheMigrationsApplied() {
        String db = jdbc.queryForObject("SELECT current_database()", String.class);
        assertTrue(db.startsWith("litegres_"), "unexpected database " + db);
        // Flyway ran at startup against the clone and found nothing to do
        assertEquals(1, jdbc.queryForObject("SELECT count(*) FROM flyway_schema_history WHERE success", Integer.class));
    }

    @RepeatedTest(5)
    void everyTestStartsEmptyAndMayWriteFreely() {
        assertEquals(0, jdbc.queryForObject("SELECT count(*) FROM people", Integer.class));
        jdbc.update("INSERT INTO people(name) VALUES ('ada'), ('grace')");
        assertEquals(2, jdbc.queryForObject("SELECT count(*) FROM people", Integer.class));
    }

    @Test
    void schemaChangesDoNotLeakEither() {
        jdbc.execute("CREATE TABLE scratch (x int)");
        jdbc.execute("ALTER TABLE people ADD COLUMN extra text");
    }

    @Test
    void thereIsNoScratchTableFromOtherTests() {
        assertEquals(0, jdbc.queryForObject(
                "SELECT count(*) FROM information_schema.tables WHERE table_name = 'scratch'", Integer.class));
        assertEquals(0, jdbc.queryForObject(
                "SELECT count(*) FROM information_schema.columns WHERE table_name = 'people' AND column_name = 'extra'",
                Integer.class));
    }
}
