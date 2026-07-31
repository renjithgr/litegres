package dev.pglitejvm.junit5

/** How often [PGliteExtension] starts a fresh [dev.pglitejvm.core.PGliteDatabase]. */
enum class PGliteLifecycle {
    /** One database for the whole test class: started in `beforeAll`, stopped in `afterAll`. */
    PER_CLASS,

    /** A fresh database per test method: started in `beforeEach`, stopped in `afterEach`. */
    PER_TEST,
}
