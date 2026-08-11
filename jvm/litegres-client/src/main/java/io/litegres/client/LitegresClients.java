package io.litegres.client;

import java.net.URI;
import java.net.http.HttpClient;
import java.time.Duration;

/**
 * Entry points for constructing {@link LitegresClient} instances.
 */
public final class LitegresClients {

    private LitegresClients() {
    }

    /**
     * Discover the daemon (default runtime dir), read its token, and connect.
     * Throws {@link LitegresException} with a helpful message when no daemon
     * is found or it is not ready.
     */
    public static LitegresClient connect() {
        Discovery.Info info = Discovery.discover();
        return connectTo(info.controlUrl(), info.token());
    }

    /**
     * Connect to an explicit control URL with an explicit daemon token.
     * Verifies readiness ({@code /health/ready}) before returning.
     */
    public static LitegresClient connectTo(String controlUrl, String token) {
        LitegresClient client = new HttpLitegresClient(controlUrl, token, null, defaultHttp());
        try {
            if (!client.status().ready()) {
                throw new LitegresException(
                        "DAEMON_NOT_READY",
                        "Litegres at " + controlUrl + " is not ready (state: " + client.status().state() + ").",
                        503, null, java.util.Map.of("url", controlUrl));
            }
        } catch (LitegresException e) {
            client.close();
            throw e;
        }
        return client;
    }

    /**
     * Connect without a readiness check (for tests that assert on failure).
     */
    public static LitegresClient connectToUnchecked(String controlUrl, String token) {
        return new HttpLitegresClient(controlUrl, token, null, defaultHttp());
    }

    /** Connect with a session lease token instead of the daemon token. */
    public static LitegresClient connectWithLeaseToken(String controlUrl, String leaseToken) {
        return new HttpLitegresClient(controlUrl, null, leaseToken, defaultHttp());
    }

    private static HttpClient defaultHttp() {
        return HttpClient.newBuilder()
                .connectTimeout(Duration.ofSeconds(10))
                .followRedirects(HttpClient.Redirect.NEVER)
                .build();
    }
}
