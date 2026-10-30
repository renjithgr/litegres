package spike;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.*;

import static org.junit.jupiter.api.Assertions.assertEquals;

/** 8 threads, each on its own pooled connection, hammering row-locked transfers. Money must be conserved. */
class ConcurrentTransfersTest extends SpikeSpringBase {
    @DynamicPropertySource
    static void props(DynamicPropertyRegistry r) { register(r, "ConcurrentTransfers"); }

    @Autowired TransferService transfers;
    @Autowired JdbcTemplate jdbc;

    @Test
    @Timeout(120)
    void moneyIsConservedUnderConcurrency() throws Exception {
        for (int i = 0; i < 10; i++) jdbc.update("INSERT INTO accounts(owner, balance) VALUES (?, 1000)", "o" + i);
        List<Long> ids = jdbc.queryForList("SELECT id FROM accounts ORDER BY id", Long.class);

        int threads = 8, perThread = 100;
        ExecutorService pool = Executors.newFixedThreadPool(threads);
        List<Future<?>> fs = new ArrayList<>();
        long t0 = System.nanoTime();
        for (int t = 0; t < threads; t++) {
            final int seed = t;
            fs.add(pool.submit(() -> {
                var rnd = new java.util.Random(seed);
                for (int i = 0; i < perThread; i++) {
                    long a = ids.get(rnd.nextInt(ids.size())), b = ids.get(rnd.nextInt(ids.size()));
                    if (a != b) transfers.transfer(a, b, 1 + rnd.nextInt(5));
                }
            }));
        }
        for (Future<?> f : fs) f.get();
        pool.shutdown();
        Db.report("behavior.csv", Db.BACKEND + ",concurrent_transfers_ms," + Db.ms(t0));

        assertEquals(10_000L, jdbc.queryForObject("SELECT sum(balance) FROM accounts", Long.class));
    }
}
