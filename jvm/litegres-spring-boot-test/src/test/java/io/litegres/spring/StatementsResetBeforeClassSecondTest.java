package io.litegres.spring;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;

/** Same configuration as {@link StatementsResetBeforeClassTest}: the earlier class's insert must be gone. */
@SpringBootTest(classes = TestApp.class, properties = "spring.flyway.enabled=false")
@LitegresTest(
        statements = {"CREATE TABLE seeded (n int)", "INSERT INTO seeded VALUES (1), (2)"},
        reset = LitegresTest.Reset.BEFORE_CLASS)
class StatementsResetBeforeClassSecondTest {

    @Autowired
    JdbcTemplate jdbc;

    @Test
    void startsFromTheSeedEvenIfAnotherClassWroteFirst() {
        assertEquals(2, jdbc.queryForObject("SELECT count(*) FROM seeded", Integer.class));
        jdbc.update("INSERT INTO seeded VALUES (4)");
    }
}
