package io.litegres.client.model;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Request to create a client session.
 */
public final class SessionRequest {

    private String clientName;
    private String clientVersion;
    private Integer clientPid;
    private String clientFramework;
    private int ttlSeconds = 1800;
    private final Map<String, String> metadata = new LinkedHashMap<>();

    private SessionRequest() {
    }

    public static SessionRequest create() {
        return new SessionRequest();
    }

    public SessionRequest clientName(String clientName) {
        this.clientName = clientName;
        return this;
    }

    public SessionRequest clientVersion(String clientVersion) {
        this.clientVersion = clientVersion;
        return this;
    }

    public SessionRequest clientPid(int pid) {
        this.clientPid = pid;
        return this;
    }

    public SessionRequest clientFramework(String framework) {
        this.clientFramework = framework;
        return this;
    }

    public SessionRequest ttlSeconds(int ttlSeconds) {
        this.ttlSeconds = ttlSeconds;
        return this;
    }

    public SessionRequest metadata(String key, String value) {
        this.metadata.put(key, value);
        return this;
    }

    public Map<String, Object> toJson() {
        Map<String, Object> json = new LinkedHashMap<>();
        Map<String, Object> client = new LinkedHashMap<>();
        if (clientName != null) {
            client.put("name", clientName);
        }
        if (clientVersion != null) {
            client.put("version", clientVersion);
        }
        if (clientPid != null) {
            client.put("pid", clientPid);
        }
        if (clientFramework != null) {
            client.put("framework", clientFramework);
        }
        if (!client.isEmpty()) {
            json.put("client", client);
        }
        json.put("ttlSeconds", ttlSeconds);
        if (!metadata.isEmpty()) {
            json.put("metadata", metadata);
        }
        return json;
    }
}
