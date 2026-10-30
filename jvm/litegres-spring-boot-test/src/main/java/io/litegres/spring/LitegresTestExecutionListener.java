package io.litegres.spring;

import java.lang.reflect.Method;
import java.util.List;
import java.util.Map;

import javax.sql.DataSource;

import org.springframework.context.ApplicationContext;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.AnnotatedElementUtils;
import org.springframework.test.context.TestContext;
import org.springframework.test.context.TestExecutionListener;

/**
 * Resets the Litegres database between tests according to
 * {@link LitegresTest#reset()}. A no-op for tests without {@code @LitegresTest}.
 *
 * <p>Runs after dependency injection and before Spring's transactional
 * listener, so a {@code @Transactional} test starts on the restored database.</p>
 */
public final class LitegresTestExecutionListener implements TestExecutionListener, Ordered {

    /** After DependencyInjectionTestExecutionListener (2000), before TransactionalTestExecutionListener (4000). */
    private static final int ORDER = 3500;

    @Override
    public int getOrder() {
        return ORDER;
    }

    @Override
    public void beforeTestClass(TestContext testContext) {
        prepare(testContext, LitegresTest.Reset.BEFORE_CLASS);
    }

    @Override
    public void beforeTestMethod(TestContext testContext) {
        prepare(testContext, LitegresTest.Reset.BEFORE_EACH);
    }

    /**
     * The class hook serves {@code BEFORE_CLASS}, the method hook serves
     * {@code BEFORE_EACH}. A database that nothing has used yet is already
     * pristine, so the first user never pays for a reset.
     */
    private void prepare(TestContext testContext, LitegresTest.Reset moment) {
        LitegresTest annotation = AnnotatedElementUtils.findMergedAnnotation(testContext.getTestClass(), LitegresTest.class);
        if (annotation == null || annotation.reset() != moment) {
            return;
        }
        LitegresDatabases.Handle handle = LitegresDatabases.get(keyOf(annotation));
        if (handle.dirty()) {
            handle.reset();
            evictPools(testContext.getApplicationContext());
        }
        handle.markDirty();
    }

    static LitegresDatabases.Key keyOf(LitegresTest annotation) {
        return new LitegresDatabases.Key(
                List.of(annotation.statements()), annotation.templateId(), List.of(annotation.migrations()));
    }

    /**
     * A reset terminates every open connection. Hikari is told to discard its
     * connections so the next borrow opens a fresh one instead of handing out
     * a dead one; other pools must validate connections on borrow.
     */
    private static void evictPools(ApplicationContext context) {
        Map<String, DataSource> dataSources = context.getBeansOfType(DataSource.class);
        for (DataSource ds : dataSources.values()) {
            try {
                Class<?> hikari = Class.forName("com.zaxxer.hikari.HikariDataSource");
                Object unwrapped = ds.isWrapperFor(hikari) ? ds.unwrap(hikari) : null;
                if (unwrapped == null) {
                    continue;
                }
                Object pool = hikari.getMethod("getHikariPoolMXBean").invoke(unwrapped);
                if (pool != null) {
                    Method evict = Class.forName("com.zaxxer.hikari.HikariPoolMXBean").getMethod("softEvictConnections");
                    evict.invoke(pool);
                }
            } catch (ReflectiveOperationException | java.sql.SQLException e) {
                // no Hikari on the classpath, or an unsupported pool: nothing to evict
            }
        }
    }
}
