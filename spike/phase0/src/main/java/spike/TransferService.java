package spike;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;

@Service
public class TransferService {
    private final JdbcTemplate jdbc;

    public TransferService(JdbcTemplate jdbc) { this.jdbc = jdbc; }

    /** Lock both rows in id order (avoids deadlock), move money, write ledger. */
    @Transactional
    public void transfer(long from, long to, long amount) {
        long lo = Math.min(from, to), hi = Math.max(from, to);
        jdbc.query("SELECT id FROM accounts WHERE id IN (?, ?) ORDER BY id FOR UPDATE", rs -> {}, lo, hi);
        jdbc.update("UPDATE accounts SET balance = balance - ? WHERE id = ?", amount, from);
        jdbc.update("UPDATE accounts SET balance = balance + ? WHERE id = ?", amount, to);
        jdbc.update("INSERT INTO ledger(from_id, to_id, amount) VALUES (?, ?, ?)", from, to, amount);
    }

    /** Typical queue-worker pattern. */
    @Transactional
    public List<Long> claim(String worker, int n, long holdMillis) {
        List<Long> ids = jdbc.queryForList(
                "SELECT id FROM jobs WHERE claimed_by IS NULL ORDER BY id LIMIT ? FOR UPDATE SKIP LOCKED",
                Long.class, n);
        for (Long id : ids) {
            jdbc.update("UPDATE jobs SET claimed_by = ?, claimed_at = now() WHERE id = ?", worker, id);
        }
        if (holdMillis > 0) {
            try { Thread.sleep(holdMillis); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
        }
        return ids;
    }
}
