package io.litegres.spring;

import java.util.List;

import org.springframework.core.annotation.AnnotatedElementUtils;
import org.springframework.test.context.ContextConfigurationAttributes;
import org.springframework.test.context.ContextCustomizer;
import org.springframework.test.context.ContextCustomizerFactory;

/** Registers a {@link LitegresContextCustomizer} for tests annotated with {@link LitegresTest}. */
public final class LitegresContextCustomizerFactory implements ContextCustomizerFactory {

    @Override
    public ContextCustomizer createContextCustomizer(Class<?> testClass, List<ContextConfigurationAttributes> configAttributes) {
        LitegresTest annotation = AnnotatedElementUtils.findMergedAnnotation(testClass, LitegresTest.class);
        return annotation == null ? null : new LitegresContextCustomizer(LitegresTestExecutionListener.keyOf(annotation));
    }
}
