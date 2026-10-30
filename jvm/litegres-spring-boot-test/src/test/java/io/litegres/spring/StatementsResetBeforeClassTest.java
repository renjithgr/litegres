package io.litegres.spring;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;

/** Inline statements and BEFORE_CLASS: the next class with this config must see the seed rows only. */
@SpringBootTest(classes = TestApp.class, properties = "spring.flyway.enabled=false")
@LitegresTest(
        statements = {"CREATE TABLE seeded (n int)", "INSERT INTO seeded VALUES (1), (2)"},
        reset = LitegresTest.Reset.BEFORE_CLASS)
class StatementsResetBeforeClassTest {

    @Autowired
    JdbcTemplate jdbc;

    @Test
    void seededRowsArePresentAndWritesAreAllowed() {
        assertEquals(2, jdbc.queryForObject("SELECT count(*) FROM seeded", Integer.class));
        jdbc.update("INSERT INTO seeded VALUES (3)");
    }
}
