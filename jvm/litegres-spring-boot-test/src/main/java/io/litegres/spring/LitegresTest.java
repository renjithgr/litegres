package io.litegres.spring;

import java.lang.annotation.Documented;
import java.lang.annotation.ElementType;
import java.lang.annotation.Inherited;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;

/**
 * Backs a Spring test context with a disposable Litegres database.
 *
 * <pre>{@code
 * @SpringBootTest
 * @LitegresTest(migrations = "classpath:db/migration")
 * class AccountRepositoryTest { ... }
 * }</pre>
 *
 * <p>The module starts (or finds) the Litegres daemon, creates <b>one
 * database per JVM</b> for each distinct configuration, and points
 * {@code spring.datasource.url/username/password} at it. Forked test JVMs
 * therefore never share state, while every test class in a JVM that uses the
 * same configuration shares one cached Spring context.</p>
 *
 * <p>Isolation inside a JVM is controlled by {@link #reset()}: the database
 * is restored from its template in ~15 ms (open connections are terminated
 * and a Hikari pool is soft-evicted so the cached context keeps working).</p>
 *
 * <p>Requires the native Litegres engine (reset is not supported on pglite).
 * Choose at most one of {@link #templateId()}, {@link #migrations()} and
 * {@link #statements()}; with none, the database starts empty.</p>
 */
@Target(ElementType.TYPE)
@Retention(RetentionPolicy.RUNTIME)
@Documented
@Inherited
public @interface LitegresTest {

    /** Restore policy between tests that share this configuration's database. */
    enum Reset {
        /** Never reset; tests clean up after themselves (e.g. {@code @Transactional}). */
        NEVER,
        /** Reset before each test class that is not the first to use the database. */
        BEFORE_CLASS,
        /** Reset before every test method that is not the first to use the database. */
        BEFORE_EACH
    }

    /**
     * Classpath locations of Flyway migrations (for example
     * {@code "classpath:db/migration"}). A template is built once from them,
     * identified by a hash of their contents, and reused by every JVM until a
     * migration changes. Requires {@code flyway-core} on the test classpath.
     */
    String[] migrations() default {};

    /** Raw SQL statements applied to the empty database when it is created. */
    String[] statements() default {};

    /** An existing Litegres template to clone. */
    String templateId() default "";

    Reset reset() default Reset.BEFORE_CLASS;
}
