package io.litegres.client;

import java.io.IOException;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicReference;

import io.litegres.client.model.ConnectionInfo;
import io.litegres.client.model.Database;
import io.litegres.client.model.DatabaseFilter;
import io.litegres.client.model.DatabaseRequest;
import io.litegres.client.model.DatabaseWithConnection;
import io.litegres.client.model.ExecResult;
import io.litegres.client.model.Session;
import io.litegres.client.model.SessionRequest;
import io.litegres.client.model.SessionWithLeaseToken;
import io.litegres.client.model.Status;
import io.litegres.client.model.Template;
import io.litegres.client.model.TemplateProvisioning;
import io.litegres.client.model.TemplateRequest;

/**
 * Default {@link LitegresClient} backed by {@link java.net.http.HttpClient}.
 * All methods talk to the daemon's HTTP control plane.
 */
final class HttpLitegresClient implements LitegresClient {

    private final String baseUrl;
    private final String token;
    private final String leaseToken; // nullable: scoped authentication
    private final HttpClient http;
    private final AtomicReference<Boolean> closed = new AtomicReference<>(false);

    HttpLitegresClient(String controlUrl, String token, String leaseToken, HttpClient http) {
        this.baseUrl = controlUrl.endsWith("/") ? controlUrl.substring(0, controlUrl.length() - 1) : controlUrl;
        this.token = token;
        this.leaseToken = leaseToken;
        this.http = http;
    }

    @Override
    public String controlUrl() {
        return baseUrl;
    }

    // ---- sessions ----

    @Override
    public SessionWithLeaseToken createSession(SessionRequest request) {
        Map<String, Object> body = request.toJson();
        Map<String, Object> json = request("POST", "/v1/sessions", body);
        Map<String, Object> client = asMap(json.get("client"));
        Session session = new Session(
                (String) json.get("id"),
                (String) json.get("status"),
                client,
                (String) json.get("createdAt"),
                (String) json.get("expiresAt"),
                stringMap(json.get("metadata")));
        return new SessionWithLeaseToken(session, (String) json.get("leaseToken"));
    }

    @Override
    public Session getSession(String sessionId) {
        return sessionOf(request("GET", "/v1/sessions/" + encode(sessionId), null));
    }

    @Override
    public List<Session> listSessions() {
        Map<String, Object> json = request("GET", "/v1/sessions", null);
        List<Session> out = new ArrayList<>();
        for (Object item : asList(json.get("sessions"))) {
            out.add(sessionOf(asMap(item)));
        }
        return out;
    }

    @Override
    public Session renewSession(String sessionId, int ttlSeconds) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("ttlSeconds", ttlSeconds);
        return sessionOf(request("POST", "/v1/sessions/" + encode(sessionId) + "/renew", body));
    }

    @Override
    public void deleteSession(String sessionId) {
        request("DELETE", "/v1/sessions/" + encode(sessionId), null);
    }

    // ---- databases ----

    @Override
    public DatabaseWithConnection createDatabase(DatabaseRequest request) {
        Map<String, Object> json = request("POST", "/v1/databases", request.toJson());
        ConnectionInfo connection = ConnectionInfo.from(asMap(json.get("connection")));
        return new DatabaseWithConnection(databaseOf(json), connection);
    }

    @Override
    public Database getDatabase(String databaseId) {
        return databaseOf(request("GET", "/v1/databases/" + encode(databaseId), null));
    }

    @Override
    public List<Database> listDatabases(DatabaseFilter filter) {
        StringBuilder path = new StringBuilder("/v1/databases");
        Map<String, String> query = (filter == null ? DatabaseFilter.none() : filter).toQuery();
        if (!query.isEmpty()) {
            List<String> pairs = new ArrayList<>();
            query.forEach((k, v) -> pairs.add(k + "=" + encode(v)));
            path.append('?').append(String.join("&", pairs));
        }
        Map<String, Object> json = request("GET", path.toString(), null);
        List<Database> out = new ArrayList<>();
        for (Object item : asList(json.get("databases"))) {
            out.add(databaseOf(asMap(item)));
        }
        return out;
    }

    @Override
    public Database renewDatabase(String databaseId, int ttlSeconds) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("ttlSeconds", ttlSeconds);
        return databaseOf(request("POST", "/v1/databases/" + encode(databaseId) + "/renew", body));
    }

    @Override
    public Database resetDatabase(String databaseId) {
        return databaseOf(request("POST", "/v1/databases/" + encode(databaseId) + "/reset", null));
    }

    @Override
    public void deleteDatabase(String databaseId) {
        request("DELETE", "/v1/databases/" + encode(databaseId), null);
    }

    @Override
    public ExecResult exec(String databaseId, String sql, List<?> parameters) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("sql", sql);
        if (parameters != null && !parameters.isEmpty()) {
            body.put("parameters", parameters);
        }
        Map<String, Object> json = request("POST", "/v1/databases/" + encode(databaseId) + "/exec", body);
        List<String> fields = new ArrayList<>();
        for (Object f : asList(json.get("fields"))) {
            fields.add(String.valueOf(f));
        }
        List<Map<String, Object>> rows = new ArrayList<>();
        for (Object row : asList(json.get("rows"))) {
            rows.add(asMap(row));
        }
        Number affected = (Number) json.get("affectedRows");
        return new ExecResult(fields, rows, affected == null ? null : affected.longValue());
    }

    // ---- templates ----

    @Override
    public Template putTemplate(TemplateRequest request) {
        Map<String, Object> json = request("PUT", "/v1/templates/" + encode(request.fingerprint()), request.toJson());
        return templateOf(json);
    }

    @Override
    public TemplateProvisioning createTemplate(TemplateRequest request) {
        Map<String, Object> body = request.toJson();
        body.put("fingerprint", request.fingerprint());
        Map<String, Object> json = request("POST", "/v1/templates", body);
        Template template = templateOf(json);
        Object pd = json.get("provisioningDatabase");
        return new TemplateProvisioning(template, pd instanceof Map<?, ?> m ? ConnectionInfo.from(asMap(m)) : null);
    }

    @Override
    public Template getTemplate(String templateId) {
        return templateOf(request("GET", "/v1/templates/" + encode(templateId), null));
    }

    @Override
    public List<Template> listTemplates() {
        Map<String, Object> json = request("GET", "/v1/templates", null);
        List<Template> out = new ArrayList<>();
        for (Object item : asList(json.get("templates"))) {
            out.add(templateOf(asMap(item)));
        }
        return out;
    }

    @Override
    public Template finalizeTemplate(String templateId) {
        return templateOf(request("POST", "/v1/templates/" + encode(templateId) + "/finalize", Map.of()));
    }

    @Override
    public void deleteTemplate(String templateId) {
        request("DELETE", "/v1/templates/" + encode(templateId), null);
    }

    // ---- daemon ----

    @Override
    public Status status() {
        return Status.from(request("GET", "/v1/status", null));
    }

    @Override
    public void shutdown() {
        request("POST", "/v1/shutdown", Map.of());
    }

    @Override
    public LitegresClient withLeaseToken(String leaseToken) {
        return new HttpLitegresClient(baseUrl, token, leaseToken, http);
    }

    @Override
    public void close() {
        closed.set(true);
        // HttpClient has no close(); it is GC-managed.
    }

    // ---- transport ----

    private Map<String, Object> request(String method, String path, Object body) {
        try {
            HttpRequest.Builder builder = HttpRequest.newBuilder()
                    .uri(URI.create(baseUrl + path))
                    .timeout(Duration.ofSeconds(30))
                    .header("Accept", "application/json");
            if (token != null) {
                builder.header("Authorization", "Bearer " + token);
            }
            if (leaseToken != null) {
                builder.header("X-Litegres-Lease-Token", leaseToken);
            }
            if (body != null) {
                builder.header("Content-Type", "application/json")
                        .method(method, HttpRequest.BodyPublishers.ofString(Json.write(body)));
            } else {
                builder.method(method, HttpRequest.BodyPublishers.noBody());
            }
            HttpResponse<String> response = http.send(builder.build(), HttpResponse.BodyHandlers.ofString());
            if (response.statusCode() >= 200 && response.statusCode() < 300) {
                String text = response.body();
                if (text == null || text.isBlank()) {
                    return Map.of();
                }
                return Json.readObject(text);
            }
            throw errorFrom(response);
        } catch (LitegresException e) {
            throw e;
        } catch (IOException e) {
            throw new LitegresException(
                    "DAEMON_UNREACHABLE",
                    "Could not reach Litegres at " + baseUrl + " (" + e.getMessage() + "). Is litegresd running?",
                    -1, null, Map.of("url", baseUrl));
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new LitegresException("INTERRUPTED", "Request interrupted", -1, null, Map.of());
        }
    }

    private LitegresException errorFrom(HttpResponse<String> response) {
        String code = "INTERNAL_ERROR";
        String message = "Litegres request failed with HTTP " + response.statusCode();
        String requestId = null;
        Map<String, Object> details = Map.of();
        try {
            Map<String, Object> json = Json.readObject(response.body());
            Map<String, Object> error = asMap(json.get("error"));
            code = str(error.get("code"), code);
            message = str(error.get("message"), message);
            requestId = (String) error.get("requestId");
            details = error.get("details") instanceof Map<?, ?> m ? (Map<String, Object>) m : Map.of();
        } catch (Exception ignored) {
            // non-JSON error body
        }
        return new LitegresException(code, message, response.statusCode(), requestId, details);
    }

    // ---- model conversion helpers ----

    private static Session sessionOf(Map<String, Object> json) {
        return new Session(
                (String) json.get("id"),
                (String) json.get("status"),
                asMap(json.get("client")),
                (String) json.get("createdAt"),
                (String) json.get("expiresAt"),
                stringMap(json.get("metadata")));
    }

    private static Database databaseOf(Map<String, Object> json) {
        return new Database(
                (String) json.get("id"),
                (String) json.get("sessionId"),
                (String) json.get("templateId"),
                (String) json.get("status"),
                (String) json.get("host"),
                ((Number) json.getOrDefault("port", 0)).intValue(),
                (String) json.get("database"),
                (String) json.get("username"),
                (String) json.get("createdAt"),
                (String) json.get("expiresAt"),
                stringMap(json.get("metadata")));
    }

    private static Template templateOf(Map<String, Object> json) {
        return new Template(
                (String) json.get("id"),
                (String) json.get("fingerprint"),
                (String) json.get("name"),
                (String) json.get("status"),
                (String) json.get("createdAt"),
                (String) json.get("lastUsedAt"),
                stringMap(json.get("metadata")));
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> asMap(Object value) {
        return value instanceof Map<?, ?> m ? (Map<String, Object>) m : Map.of();
    }

    @SuppressWarnings("unchecked")
    private static List<Object> asList(Object value) {
        return value instanceof List<?> l ? (List<Object>) l : List.of();
    }

    private static Map<String, String> stringMap(Object value) {
        Map<String, Object> m = asMap(value);
        Map<String, String> out = new LinkedHashMap<>();
        m.forEach((k, v) -> out.put(k, String.valueOf(v)));
        return out;
    }

    private static String str(Object value, String fallback) {
        return value == null ? fallback : String.valueOf(value);
    }

    private static String encode(String value) {
        return URLEncoder.encode(value, StandardCharsets.UTF_8).replace("+", "%20");
    }
}
