package spike;

import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.*;
import java.util.*;
import java.util.concurrent.*;

/** Raw-JDBC microbenchmark: provisioning latency, parallel provisioning, per-DB workload scaling, memory. */
public final class Bench {
    public static void main(String[] args) throws Exception {
        try { run(); } catch (Throwable t) { t.printStackTrace(); System.exit(1); }
    }

    static void run() throws Exception {
        String backend = Db.BACKEND;
        StringBuilder out = new StringBuilder();
        System.out.println("== bench backend=" + backend);

        // first acquire includes building the template
        long t0 = System.nanoTime();
        Db.Handle first = Db.acquire("warm");
        out.append(line("first_database_incl_template_ms", Db.ms(t0)));
        first.release().run();

        // 1. sequential provision + drop
        List<Long> seq = new ArrayList<>();
        for (int i = 0; i < 20; i++) {
            Db.Handle h = Db.acquire("seq" + i);
            seq.add(h.provisionMs());
            h.release().run();
        }
        Collections.sort(seq);
        out.append(line("provision_seq_p50_ms", seq.get(seq.size() / 2)));
        out.append(line("provision_seq_p95_ms", seq.get((int) (seq.size() * 0.95) - 1)));
        out.append(line("provision_seq_max_ms", seq.get(seq.size() - 1)));

        // 2. parallel provision of 16
        int n = 16;
        ExecutorService pool = Executors.newFixedThreadPool(n);
        t0 = System.nanoTime();
        List<Future<Db.Handle>> fs = new ArrayList<>();
        for (int i = 0; i < n; i++) { final int k = i; fs.add(pool.submit(() -> Db.acquire("par" + k))); }
        List<Db.Handle> live = new ArrayList<>();
        for (var f : fs) live.add(f.get());
        out.append(line("provision_parallel16_wall_ms", Db.ms(t0)));

        // 3. workload scaling: same work on 1 DB, then on 8 DBs at once
        long one = workload(List.of(live.get(0)));
        long eight = workload(live.subList(0, 8));
        out.append(line("workload_1db_ms", one));
        out.append(line("workload_8db_parallel_ms", eight));
        out.append(line("workload_scaling_ratio_8db_vs_1db", Math.round(100.0 * eight / one) / 100.0));

        // 4. memory with 16 live, used databases
        workload(live.subList(8, 16));
        out.append(line("memory_16_live_dbs", memory()));
        live.forEach(h -> h.release().run());
        pool.shutdown();

        Files.createDirectories(Db.OUT);
        Files.writeString(Db.OUT.resolve("bench.txt"), out.toString());
        System.out.println(out);
        System.exit(0);
    }

    static String line(String k, Object v) { return k + " = " + v + "\n"; }

    /** Insert 5000 rows in batches, 3000 point selects, 20 aggregates, over one connection per DB, all DBs concurrently. */
    static long workload(List<Db.Handle> hs) throws Exception {
        ExecutorService ex = Executors.newFixedThreadPool(hs.size());
        long t0 = System.nanoTime();
        List<Future<?>> fs = new ArrayList<>();
        for (Db.Handle h : hs) fs.add(ex.submit(() -> { run(h); return null; }));
        for (var f : fs) f.get();
        ex.shutdown();
        return Db.ms(t0);
    }

    static void run(Db.Handle h) throws SQLException {
        try (Connection c = DriverManager.getConnection(h.url(), h.user(), h.password())) {
            c.setAutoCommit(false);
            try (PreparedStatement ins = c.prepareStatement("INSERT INTO accounts(owner, balance, meta) VALUES (?, ?, ?::jsonb)")) {
                for (int i = 0; i < 5000; i++) {
                    ins.setString(1, "o" + i); ins.setLong(2, i); ins.setString(3, "{\"i\":" + i + "}");
                    ins.addBatch();
                    if (i % 500 == 499) ins.executeBatch();
                }
            }
            c.commit();
            try (PreparedStatement q = c.prepareStatement("SELECT balance FROM accounts WHERE id = ?")) {
                for (int i = 0; i < 3000; i++) { q.setLong(1, 1 + (i % 5000)); try (ResultSet rs = q.executeQuery()) { rs.next(); } }
            }
            try (Statement s = c.createStatement()) {
                for (int i = 0; i < 20; i++) s.executeQuery("SELECT count(*), sum(balance), max((meta->>'i')::int) FROM accounts").close();
            }
        }
    }

    static String memory() throws Exception {
        if (Db.BACKEND.equals("litegres")) {
            String dir = System.getProperty("litegres.runtimeDir");
            String json = Files.readString(Path.of(dir, "daemon.json"));
            var m = java.util.regex.Pattern.compile("\"pid\"\\s*:\\s*(\\d+)").matcher(json);
            m.find();
            String rssKb = sh("ps", "-o", "rss=", "-p", m.group(1)).trim();
            return Math.round(Long.parseLong(rssKb) / 1024.0) + " MiB RSS (litegresd pid " + m.group(1) + ")";
        }
        return sh("docker", "stats", "--no-stream", "--format", "{{.MemUsage}}", System.getProperty("spike.pg.container", "litegres-spike-pg")).trim();
    }

    static String sh(String... cmd) throws Exception {
        Process p = new ProcessBuilder(cmd).redirectErrorStream(true).start();
        String s = new String(p.getInputStream().readAllBytes());
        p.waitFor();
        return s;
    }
}
