package io.litegres.client.model;

import java.util.Map;

/**
 * A client session: one test run or client process. Owns databases.
 */
public record Session(
        String id,
        String status,
        Map<String, Object> client,
        String createdAt,
        String expiresAt,
        Map<String, String> metadata) {

    public boolean active() {
        return "active".equals(status);
    }
}
