package io.litegres.testcontainers;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import org.junit.jupiter.api.extension.AfterAllCallback;
import org.junit.jupiter.api.extension.AfterEachCallback;
import org.junit.jupiter.api.extension.BeforeEachCallback;
import org.junit.jupiter.api.extension.ExtensionContext;
import org.junit.jupiter.api.extension.ParameterContext;
import org.junit.jupiter.api.extension.ParameterResolver;
import org.testcontainers.containers.GenericContainer;
import org.testcontainers.containers.wait.strategy.Wait;

import io.litegres.client.LitegresClient;
import io.litegres.client.LitegresClients;
import io.litegres.client.LitegresException;
import io.litegres.client.model.DatabaseRequest;
import io.litegres.junit5.LitegresDatabase;
import io.litegres.junit5.LitegresExtension;

/**
 * Litegres (the daemon plus its PostgreSQL server) running in Docker, managed
 * by Testcontainers.
 *
 * <p>Everything it needs in a container is pre-configured by the image (see
 * {@code Dockerfile}): the control API binds {@code 0.0.0.0}, every database
 * is served by the container's PostgreSQL on port 5432 (told apart by
 * database name), and both ports are published to random host ports. This
 * class rewrites the connection info returned by the control API so tests can
 * connect through the published port — exactly like a Testcontainers module
 * for any other database.</p>
 *
 * <p>Two usage modes:</p>
 *
 * <pre>{@code
 * // 1. As a JUnit 5 extension: daemon in Docker + one disposable database
 * //    per test method, exactly like LitegresExtension but containerized.
 * @RegisterExtension
 * static LitegresContainer litegres = new LitegresContainer();
 *
 * @Test
 * void test(LitegresDatabase db) { ... }
 *
 * // 2. Manual, Testcontainers-style:
 * LitegresContainer litegres = new LitegresContainer();
 * try {
 *     litegres.start();
 *     LitegresClient client = litegres.getClient();
 *     ...
 * } finally {
 *     litegres.stop();
 * }
 * }</pre>
 *
 * <p>The default image is {@code litegres/litegresd:0.1.0} (build it with
 * {@code bun run docker-build} at the repo root). Override it with the
 * constructor argument or the {@code litegres.testcontainers.image} system
 * property ({@code -PlitegresDockerImage=...} from Gradle).</p>
 */
public class LitegresContainer extends GenericContainer<LitegresContainer>
        implements BeforeEachCallback, AfterEachCallback, AfterAllCallback, ParameterResolver {

    /** Control-plane (HTTP) port inside the container. */
    public static final int CONTROL_PORT = 49100;
    /** PostgreSQL port inside the container; every database is served here. */
    public static final int POSTGRES_PORT = 5432;
    /** Default image; build it with `bun run docker-build`. */
    public static final String DEFAULT_IMAGE = "litegres/litegresd:0.1.0";
    /** Where the image keeps its runtime dir (daemon.json + token). */
    public static final String DEFAULT_RUNTIME_DIR = "/var/lib/litegres";

    private final List<String> statements = new ArrayList<>();
    private String templateId;
    private int databaseTtlSeconds = 600;
    private int sessionTtlSeconds = 1800;
    private final Map<String, String> metadata = new LinkedHashMap<>();
    private String runtimeDir = DEFAULT_RUNTIME_DIR;

    private volatile LitegresClient client;
    private volatile String token;
    private volatile LitegresExtension extension;
    private volatile boolean startedByUs;

    /** Default image. */
    public LitegresContainer() {
        this(System.getProperty("litegres.testcontainers.image", DEFAULT_IMAGE));
    }

    /** Use a specific image (e.g. a locally built or mirrored one). */
    public LitegresContainer(String image) {
        super(image);
        withExposedPorts(exposedPorts());
        waitingFor(Wait.forHttp("/health/ready")
                .forPort(CONTROL_PORT)
                .forStatusCode(200)
                .withStartupTimeout(Duration.ofMinutes(3)));
    }

    // ------------------------------------------------------------------
    // Configuration (mirrors LitegresExtension)
    // ------------------------------------------------------------------

    /** A fresh empty database per test. */
    public static LitegresContainer empty() {
        return new LitegresContainer();
    }

    /** A fresh clone of a template per test. */
    public static LitegresContainer fromTemplate(String templateId) {
        LitegresContainer c = new LitegresContainer();
        c.templateId = templateId;
        return c;
    }

    /** A fresh database initialized with the given statements per test. */
    public static LitegresContainer withStatements(String... statements) {
        LitegresContainer c = new LitegresContainer();
        for (String s : statements) {
            c.statements.add(s);
        }
        return c;
    }

    /** Database TTL in seconds (default 600). */
    public LitegresContainer ttlSeconds(int ttlSeconds) {
        this.databaseTtlSeconds = ttlSeconds;
        return this;
    }

    /** Session TTL in seconds (default 1800). */
    public LitegresContainer sessionTtlSeconds(int ttlSeconds) {
        this.sessionTtlSeconds = ttlSeconds;
        return this;
    }

    public LitegresContainer metadata(String key, String value) {
        this.metadata.put(key, value);
        return this;
    }

    /** Override the daemon's maxDatabases (default 32). */
    public LitegresContainer withMaxDatabases(int max) {
        withEnv("LITEGRES_MAX_DATABASES", String.valueOf(max));
        return this;
    }

    /** Override the in-container runtime dir (default {@value #DEFAULT_RUNTIME_DIR}). */
    public LitegresContainer withRuntimeDir(String runtimeDir) {
        this.runtimeDir = runtimeDir;
        withEnv("LITEGRES_RUNTIME_DIR", runtimeDir);
        return this;
    }

    /** The host advertised in connection info (default "localhost", set by the image). */
    public LitegresContainer withPublicHost(String publicHost) {
        withEnv("LITEGRES_PUBLIC_HOST", publicHost);
        return this;
    }

    // ------------------------------------------------------------------
    // Testcontainers accessors
    // ------------------------------------------------------------------

    /** The control API URL reachable from the test JVM. */
    public String getControlUrl() {
        ensureStarted();
        return "http://" + getHost() + ":" + getMappedPort(CONTROL_PORT);
    }

    /** The daemon control token, read from the container's runtime dir. */
    public String getToken() {
        ensureStarted();
        String t = token;
        if (t == null) {
            synchronized (this) {
                t = token;
                if (t == null) {
                    t = readToken();
                    token = t;
                }
            }
        }
        return t;
    }

    /**
     * A {@link LitegresClient} pointed at this daemon. Connection info in
     * responses is rewritten so the {@code host}/{@code port} point at the
     * Docker host's published ports — usable directly from the test JVM.
     */
    public LitegresClient getClient() {
        ensureStarted();
        LitegresClient c = client;
        if (c == null) {
            synchronized (this) {
                c = client;
                if (c == null) {
                    c = new PortRewritingClient(LitegresClients.connectTo(getControlUrl(), getToken()));
                    client = c;
                }
            }
        }
        return c;
    }

    // ------------------------------------------------------------------
    // JUnit 5 extension: delegate per-test database lifecycle to a
    // LitegresExtension wired to this container's client.
    // ------------------------------------------------------------------

    @Override
    public void beforeEach(ExtensionContext context) {
        extension().beforeEach(context);
    }

    @Override
    public void afterEach(ExtensionContext context) {
        extension().afterEach(context);
    }

    @Override
    public void afterAll(ExtensionContext context) {
        LitegresExtension ext = extension;
        if (ext != null) {
            ext.afterAll(context);
        }
        stopIfOwned();
    }

    @Override
    public boolean supportsParameter(ParameterContext parameterContext, ExtensionContext extensionContext) {
        return extension().supportsParameter(parameterContext, extensionContext);
    }

    @Override
    public Object resolveParameter(ParameterContext parameterContext, ExtensionContext extensionContext) {
        return extension().resolveParameter(parameterContext, extensionContext);
    }

    // ------------------------------------------------------------------
    // Internals
    // ------------------------------------------------------------------

    private LitegresExtension extension() {
        ensureStarted();
        LitegresExtension ext = extension;
        if (ext == null) {
            synchronized (this) {
                ext = extension;
                if (ext == null) {
                    ext = buildExtension();
                    extension = ext;
                }
            }
        }
        return ext;
    }

    private LitegresExtension buildExtension() {
        LitegresExtension ext;
        if (templateId != null) {
            ext = LitegresExtension.fromTemplate(templateId);
        } else if (!statements.isEmpty()) {
            ext = LitegresExtension.withStatements(statements.toArray(new String[0]));
        } else {
            ext = LitegresExtension.empty();
        }
        ext.client(getClient())
                .controlUrl(getControlUrl())
                .controlToken(getToken())
                .ttlSeconds(databaseTtlSeconds)
                .sessionTtlSeconds(sessionTtlSeconds);
        for (Map.Entry<String, String> e : metadata.entrySet()) {
            ext.metadata(e.getKey(), e.getValue());
        }
        return ext;
    }

    private void ensureStarted() {
        if (isRunning()) {
            return;
        }
        synchronized (this) {
            if (isRunning()) {
                return;
            }
            start();
            startedByUs = true;
        }
    }

    private void stopIfOwned() {
        if (startedByUs && isRunning()) {
            try {
                stop();
            } catch (Exception ignored) {
                // best effort; Testcontainers logs failures
            }
        }
    }

    private String readToken() {
        Path tmp = null;
        try {
            tmp = Files.createTempFile("litegres-token-", ".txt");
            copyFileFromContainer(runtimeDir + "/token", tmp.toString());
            String content = Files.readString(tmp).trim();
            if (content.isEmpty()) {
                throw new IllegalStateException("empty token at " + runtimeDir + "/token");
            }
            return content;
        } catch (IOException e) {
            throw new LitegresException(
                    "DAEMON_NOT_FOUND",
                    "Could not read the Litegres control token from " + runtimeDir + "/token in the container: " + e.getMessage(),
                    500, null, Map.of("runtimeDir", runtimeDir));
        } finally {
            if (tmp != null) {
                try {
                    Files.deleteIfExists(tmp);
                } catch (IOException ignored) {
                    // best effort
                }
            }
        }
    }

    private Integer[] exposedPorts() {
        return new Integer[] {CONTROL_PORT, POSTGRES_PORT};
    }

    /**
     * Decorates a {@link LitegresClient} so every database/provisioning
     * connection points at the Docker host's published PostgreSQL port instead
     * of the in-container address the daemon advertises.
     */
    private final class PortRewritingClient implements LitegresClient {

        private final LitegresClient delegate;

        private PortRewritingClient(LitegresClient delegate) {
            this.delegate = delegate;
        }

        private io.litegres.client.model.Database rewrite(io.litegres.client.model.Database db) {
            return new io.litegres.client.model.Database(
                    db.id(),
                    db.sessionId(),
                    db.templateId(),
                    db.status(),
                    getHost(),
                    getMappedPort(db.port()),
                    db.database(),
                    db.username(),
                    db.createdAt(),
                    db.expiresAt(),
                    db.metadata());
        }

        private io.litegres.client.model.ConnectionInfo rewrite(io.litegres.client.model.ConnectionInfo c) {
            int port = getMappedPort(c.port());
            String host = getHost();
            return new io.litegres.client.model.ConnectionInfo(
                    host,
                    port,
                    c.database(),
                    c.username(),
                    c.password(),
                    "postgresql://" + c.username() + ":" + c.password() + "@" + host + ":" + port + "/" + c.database(),
                    "jdbc:postgresql://" + host + ":" + port + "/" + c.database() + "?sslmode=disable");
        }

        // ---- sessions ----

        @Override
        public io.litegres.client.model.SessionWithLeaseToken createSession(io.litegres.client.model.SessionRequest request) {
            return delegate.createSession(request);
        }

        @Override
        public io.litegres.client.model.Session getSession(String sessionId) {
            return delegate.getSession(sessionId);
        }

        @Override
        public List<io.litegres.client.model.Session> listSessions() {
            return delegate.listSessions();
        }

        @Override
        public io.litegres.client.model.Session renewSession(String sessionId, int ttlSeconds) {
            return delegate.renewSession(sessionId, ttlSeconds);
        }

        @Override
        public void deleteSession(String sessionId) {
            delegate.deleteSession(sessionId);
        }

        // ---- databases ----

        @Override
        public io.litegres.client.model.DatabaseWithConnection createDatabase(DatabaseRequest request) {
            io.litegres.client.model.DatabaseWithConnection created = delegate.createDatabase(request);
            return new io.litegres.client.model.DatabaseWithConnection(
                    rewrite(created.database()),
                    rewrite(created.connection()));
        }

        @Override
        public io.litegres.client.model.Database getDatabase(String databaseId) {
            return rewrite(delegate.getDatabase(databaseId));
        }

        @Override
        public List<io.litegres.client.model.Database> listDatabases(io.litegres.client.model.DatabaseFilter filter) {
            List<io.litegres.client.model.Database> out = new ArrayList<>();
            for (io.litegres.client.model.Database db : delegate.listDatabases(filter)) {
                out.add(rewrite(db));
            }
            return out;
        }

        @Override
        public io.litegres.client.model.Database renewDatabase(String databaseId, int ttlSeconds) {
            return rewrite(delegate.renewDatabase(databaseId, ttlSeconds));
        }

        @Override
        public io.litegres.client.model.Database resetDatabase(String databaseId) {
            return rewrite(delegate.resetDatabase(databaseId));
        }

        @Override
        public void deleteDatabase(String databaseId) {
            delegate.deleteDatabase(databaseId);
        }

        @Override
        public io.litegres.client.model.ExecResult exec(String databaseId, String sql, List<?> parameters) {
            return delegate.exec(databaseId, sql, parameters);
        }

        // ---- templates ----

        @Override
        public io.litegres.client.model.Template putTemplate(io.litegres.client.model.TemplateRequest request) {
            return delegate.putTemplate(request);
        }

        @Override
        public io.litegres.client.model.TemplateProvisioning createTemplate(io.litegres.client.model.TemplateRequest request) {
            io.litegres.client.model.TemplateProvisioning provisioning = delegate.createTemplate(request);
            io.litegres.client.model.ConnectionInfo endpoint = provisioning.provisioningDatabase();
            return new io.litegres.client.model.TemplateProvisioning(
                    provisioning.template(),
                    endpoint == null ? null : rewrite(endpoint));
        }

        @Override
        public io.litegres.client.model.Template getTemplate(String templateId) {
            return delegate.getTemplate(templateId);
        }

        @Override
        public List<io.litegres.client.model.Template> listTemplates() {
            return delegate.listTemplates();
        }

        @Override
        public io.litegres.client.model.Template finalizeTemplate(String templateId) {
            return delegate.finalizeTemplate(templateId);
        }

        @Override
        public void deleteTemplate(String templateId) {
            delegate.deleteTemplate(templateId);
        }

        // ---- daemon ----

        @Override
        public io.litegres.client.model.Status status() {
            return delegate.status();
        }

        @Override
        public void shutdown() {
            delegate.shutdown();
        }

        @Override
        public LitegresClient withLeaseToken(String leaseToken) {
            return new PortRewritingClient(delegate.withLeaseToken(leaseToken));
        }

        @Override
        public String controlUrl() {
            return getControlUrl();
        }

        @Override
        public void close() {
            delegate.close();
        }
    }
}
