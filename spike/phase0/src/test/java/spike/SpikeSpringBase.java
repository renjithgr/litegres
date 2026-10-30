package spike;

import org.junit.jupiter.api.AfterAll;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.DynamicPropertyRegistry;

import java.util.concurrent.ConcurrentHashMap;
import java.util.Map;

/** Each concrete subclass registers its own @DynamicPropertySource -> its own database + its own cached Spring context. */
@SpringBootTest(classes = App.class)
abstract class SpikeSpringBase {
    private static final Map<String, Db.Handle> HANDLES = new ConcurrentHashMap<>();

    static void register(DynamicPropertyRegistry r, String label) {
        Db.Handle h = HANDLES.computeIfAbsent(label, Db::acquire);
        r.add("spring.datasource.url", () -> h.urlWith("socketTimeout=30"));
        String pool = System.getProperty("spike.poolSize");
        if (pool != null) { r.add("spring.flyway.enabled", () -> "false"); r.add("spring.datasource.hikari.maximum-pool-size", () -> pool); r.add("spring.datasource.hikari.minimum-idle", () -> pool); }
        r.add("spring.datasource.username", h::user);
        r.add("spring.datasource.password", h::password);
    }

    @AfterAll
    static void releaseAll() {
        HANDLES.values().forEach(h -> h.release().run());
        HANDLES.clear();
    }
}
