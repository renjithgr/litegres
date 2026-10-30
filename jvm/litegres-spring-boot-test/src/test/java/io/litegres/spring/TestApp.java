package io.litegres.spring;

import java.util.concurrent.atomic.AtomicInteger;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.stereotype.Component;

@SpringBootApplication
public class TestApp {

    /** Counts how many application contexts this JVM created. */
    @Component
    static class ContextCounter {
        static final AtomicInteger CREATED = new AtomicInteger();

        ContextCounter() {
            CREATED.incrementAndGet();
        }
    }

    public static void main(String[] args) {
        SpringApplication.run(TestApp.class, args);
    }
}
