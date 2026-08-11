package io.litegres.client.model;

import java.util.Map;

/**
 * A disposable database descriptor. Never contains credentials.
 */
public record Database(
        String id,
        String sessionId,
        String templateId,
        String status,
        String host,
        int port,
        String database,
        String username,
        String createdAt,
        String expiresAt,
        Map<String, String> metadata) {

    public boolean ready() {
        return "ready".equals(status);
    }
}
