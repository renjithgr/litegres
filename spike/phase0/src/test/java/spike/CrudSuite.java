package spike;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.JdbcTemplate;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;

/** The "bread and butter" integration test: JPA + JdbcTemplate + jsonb + arrays. */
abstract class CrudSuite extends SpikeSpringBase {
    @Autowired AccountRepository accounts;
    @Autowired JdbcTemplate jdbc;

    @BeforeEach
    void clean() {
        jdbc.execute("TRUNCATE ledger, accounts RESTART IDENTITY CASCADE");
    }

    @Test
    void savesAndReads() {
        accounts.save(new Account("alice", 100));
        accounts.save(new Account("bob", 50));
        assertEquals(2, accounts.count());
        assertEquals("alice", accounts.findAll().get(0).getOwner());
    }

    @Test
    void jsonbAndArrays() {
        jdbc.update("INSERT INTO accounts(owner, balance, meta, tags) VALUES (?, 1, ?::jsonb, ?::text[])",
                "carol", "{\"tier\":\"gold\"}", "{a,b}");
        List<String> hit = jdbc.queryForList(
                "SELECT owner FROM accounts WHERE meta->>'tier' = 'gold' AND tags @> ARRAY['a']", String.class);
        assertEquals(List.of("carol"), hit);
    }

    @Test
    void constraintsAreEnforced() {
        org.junit.jupiter.api.Assertions.assertThrows(Exception.class,
                () -> jdbc.update("INSERT INTO accounts(owner, balance) VALUES ('neg', -1)"));
    }
}
