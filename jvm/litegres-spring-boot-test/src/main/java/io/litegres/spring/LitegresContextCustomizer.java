package io.litegres.spring;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;

import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.core.env.MapPropertySource;
import org.springframework.test.context.ContextCustomizer;
import org.springframework.test.context.MergedContextConfiguration;

import io.litegres.client.model.ConnectionInfo;

/**
 * Points {@code spring.datasource.*} at the Litegres database for a
 * configuration. Equality is by configuration so that test classes with the
 * same {@link LitegresTest} settings share one cached context.
 */
final class LitegresContextCustomizer implements ContextCustomizer {

    private final LitegresDatabases.Key key;

    LitegresContextCustomizer(LitegresDatabases.Key key) {
        this.key = key;
    }

    @Override
    public void customizeContext(ConfigurableApplicationContext context, MergedContextConfiguration mergedConfig) {
        ConnectionInfo connection = LitegresDatabases.get(key).connection();
        Map<String, Object> properties = new LinkedHashMap<>();
        properties.put("spring.datasource.url", connection.jdbcUrl());
        properties.put("spring.datasource.username", connection.username());
        properties.put("spring.datasource.password", connection.password());
        context.getEnvironment().getPropertySources().addFirst(new MapPropertySource("litegres", properties));
    }

    @Override
    public boolean equals(Object other) {
        return other instanceof LitegresContextCustomizer that && key.equals(that.key);
    }

    @Override
    public int hashCode() {
        return Objects.hash(key);
    }
}
