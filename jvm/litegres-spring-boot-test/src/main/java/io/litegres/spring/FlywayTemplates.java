package io.litegres.spring;

import java.io.IOException;
import java.io.InputStream;
import java.nio.channels.FileChannel;
import java.nio.channels.FileLock;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.HexFormat;
import java.util.List;
import java.util.Optional;

import org.springframework.core.io.Resource;
import org.springframework.core.io.support.PathMatchingResourcePatternResolver;

import io.litegres.client.Discovery;
import io.litegres.client.LitegresClient;
import io.litegres.client.LitegresException;
import io.litegres.client.model.ConnectionInfo;
import io.litegres.client.model.Template;
import io.litegres.client.model.TemplateProvisioning;
import io.litegres.client.model.TemplateRequest;

/**
 * Builds (once) a Litegres template from Flyway migrations.
 *
 * <p>The template is identified by a hash of the migration files, so it is
 * rebuilt exactly when a migration changes and shared by every JVM and Gradle
 * fork. Building is serialized across processes with a file lock.</p>
 */
final class FlywayTemplates {

    private static final String NAME_PREFIX = "spring-flyway-";
    private static final Object JVM_LOCK = new Object();

    private FlywayTemplates() {
    }

    static String ensure(LitegresClient client, List<String> locations) {
        String fingerprint = fingerprint(locations);
        Optional<Template> existing = findReady(client, fingerprint);
        if (existing.isPresent()) {
            return existing.get().id();
        }
        synchronized (JVM_LOCK) {
            Path lock = Discovery.runtimeDir().resolve("template-" + fingerprint.substring(fingerprint.length() - 16) + ".lock");
            try (FileChannel channel = FileChannel.open(lock, StandardOpenOption.CREATE, StandardOpenOption.WRITE);
                    FileLock ignored = channel.lock()) {
                // another process may have built it while we waited
                Optional<Template> built = findReady(client, fingerprint);
                if (built.isPresent()) {
                    return built.get().id();
                }
                return provision(client, locations, fingerprint);
            } catch (IOException e) {
                throw new IllegalStateException("Could not lock " + lock + ": " + e.getMessage(), e);
            }
        }
    }

    private static Optional<Template> findReady(LitegresClient client, String fingerprint) {
        return client.listTemplates().stream()
                .filter(t -> fingerprint.equals(t.fingerprint()) && t.ready())
                .findFirst();
    }

    private static String provision(LitegresClient client, List<String> locations, String fingerprint) {
        TemplateProvisioning provisioning;
        try {
            provisioning = client.createTemplate(TemplateRequest.forProvisioning(fingerprint).name(NAME_PREFIX + locations.get(0)));
        } catch (LitegresException e) {
            if (!"TEMPLATE_CAPACITY_EXHAUSTED".equals(e.code())) {
                throw e;
            }
            dropStaleTemplates(client, fingerprint);
            provisioning = client.createTemplate(TemplateRequest.forProvisioning(fingerprint).name(NAME_PREFIX + locations.get(0)));
        }
        String templateId = provisioning.template().id();
        try {
            migrate(provisioning.provisioningDatabase(), locations);
            return client.finalizeTemplate(templateId).id();
        } catch (RuntimeException | Error e) {
            try {
                client.deleteTemplate(templateId);
            } catch (RuntimeException ignored) {
                // best effort
            }
            throw e;
        }
    }

    /** Older migration sets we built ourselves; safe to drop since clones no longer need them. */
    private static void dropStaleTemplates(LitegresClient client, String keepFingerprint) {
        for (Template t : client.listTemplates()) {
            if (t.name() != null && t.name().startsWith(NAME_PREFIX) && !keepFingerprint.equals(t.fingerprint())) {
                client.deleteTemplate(t.id());
            }
        }
    }

    private static void migrate(ConnectionInfo connection, List<String> locations) {
        try {
            org.flywaydb.core.Flyway.configure()
                    .dataSource(connection.jdbcUrl(), connection.username(), connection.password())
                    .locations(locations.toArray(String[]::new))
                    .load()
                    .migrate();
        } catch (NoClassDefFoundError e) {
            throw new IllegalStateException(
                    "@LitegresTest(migrations = ...) needs flyway-core (and flyway-database-postgresql) on the test classpath.", e);
        }
    }

    /** SHA-256 over the names and contents of every file in the locations, order-independent. */
    static String fingerprint(List<String> locations) {
        PathMatchingResourcePatternResolver resolver = new PathMatchingResourcePatternResolver();
        List<Resource> resources = new ArrayList<>();
        for (String location : locations) {
            String pattern = location.startsWith("classpath:")
                    ? "classpath*:" + location.substring("classpath:".length())
                    : location;
            if (!pattern.endsWith("/")) {
                pattern += "/";
            }
            try {
                resources.addAll(Arrays.asList(resolver.getResources(pattern + "**")));
            } catch (IOException e) {
                throw new IllegalStateException("Cannot read migrations at " + location + ": " + e.getMessage(), e);
            }
        }
        resources.removeIf(r -> {
            try {
                return r.getFilename() == null || !r.isReadable() || r.contentLength() < 0 || r.getURL().toString().endsWith("/");
            } catch (IOException e) {
                return true;
            }
        });
        if (resources.isEmpty()) {
            throw new IllegalStateException("No migrations found at " + locations);
        }
        resources.sort(Comparator.comparing(r -> r.getFilename()));
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            for (Resource r : resources) {
                digest.update(r.getFilename().getBytes(StandardCharsets.UTF_8));
                digest.update((byte) 0);
                try (InputStream in = r.getInputStream()) {
                    digest.update(in.readAllBytes());
                }
                digest.update((byte) 0);
            }
            return "flyway-sha256-" + HexFormat.of().formatHex(digest.digest());
        } catch (NoSuchAlgorithmException | IOException e) {
            throw new IllegalStateException("Cannot fingerprint migrations: " + e.getMessage(), e);
        }
    }
}
