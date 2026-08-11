package io.litegres.client.model;

import java.util.Map;

/**
 * An immutable, prepared template snapshot.
 */
public record Template(
        String id,
        String fingerprint,
        String name,
        String status,
        String createdAt,
        String lastUsedAt,
        Map<String, String> metadata) {

    public boolean ready() {
        return "ready".equals(status);
    }
}
