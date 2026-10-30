package spike;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

import java.util.*;
import java.util.concurrent.*;

import static org.junit.jupiter.api.Assertions.*;

/** Queue-worker pattern: FOR UPDATE SKIP LOCKED. */
class SkipLockedTest extends SpikeSpringBase {
    @DynamicPropertySource
    static void props(DynamicPropertyRegistry r) { register(r, "SkipLocked"); }

    @Autowired TransferService svc;
    @Autowired JdbcTemplate jdbc;

    @BeforeEach
    void seed() {
        jdbc.execute("TRUNCATE jobs RESTART IDENTITY");
        jdbc.update("INSERT INTO jobs(payload) SELECT 'p' || g FROM generate_series(1, 200) g");
    }

    @Test
    @Timeout(60)
    void everyJobClaimedExactlyOnce() throws Exception {
        ExecutorService pool = Executors.newFixedThreadPool(4);
        List<Future<List<Long>>> fs = new ArrayList<>();
        for (int w = 0; w < 4; w++) {
            final String name = "w" + w;
            fs.add(pool.submit(() -> {
                List<Long> mine = new ArrayList<>();
                List<Long> got;
                while (!(got = svc.claim(name, 5, 5)).isEmpty()) mine.addAll(got);
                return mine;
            }));
        }
        Set<Long> all = new HashSet<>();
        int total = 0;
        for (var f : fs) { var l = f.get(); total += l.size(); all.addAll(l); }
        pool.shutdown();
        assertEquals(200, total, "no job may be claimed twice or skipped");
        assertEquals(200, all.size());
    }

    /** Worker A holds 5 locked jobs in an open transaction; worker B must proceed immediately with other jobs. */
    @Test
    @Timeout(60)
    void secondWorkerIsNotBlockedByFirstWorkersOpenTransaction() throws Exception {
        ExecutorService pool = Executors.newFixedThreadPool(2);
        Future<List<Long>> a = pool.submit(() -> svc.claim("A", 5, 3000));
        Thread.sleep(800);
        long t0 = System.nanoTime();
        Future<List<Long>> b = pool.submit(() -> svc.claim("B", 5, 0));
        List<Long> bIds = b.get();
        long waited = Db.ms(t0);
        List<Long> aIds = a.get();
        pool.shutdown();
        Db.report("behavior.csv", Db.BACKEND + ",skiplocked_B_latency_ms," + waited);
        assertTrue(waited < 1500, "B waited " + waited + "ms behind A's open transaction");
        assertTrue(Collections.disjoint(aIds, bIds));
    }
}
