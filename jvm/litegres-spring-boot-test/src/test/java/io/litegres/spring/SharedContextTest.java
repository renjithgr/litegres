package io.litegres.spring;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;

/**
 * Same configuration as {@link FlywayResetBeforeEachTest}, so it shares both
 * the Spring context and the Litegres database; the reset policy is not part
 * of the cache key. All classes in a JVM must therefore use one context.
 */
@SpringBootTest(classes = TestApp.class)
@LitegresTest(migrations = "classpath:db/migration", reset = LitegresTest.Reset.BEFORE_EACH)
class SharedContextTest {

    @Autowired
    JdbcTemplate jdbc;

    @Test
    void startsFromTheTemplateAndSharesTheCachedContext() {
        assertEquals(0, jdbc.queryForObject("SELECT count(*) FROM people", Integer.class));
        assertEquals(1, TestApp.ContextCounter.CREATED.get(),
                "test classes with the same @LitegresTest configuration must share one Spring context");
    }
}
