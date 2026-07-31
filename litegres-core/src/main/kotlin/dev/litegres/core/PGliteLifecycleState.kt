package dev.litegres.core

/**
 * Lifecycle states of a [PGliteDatabase]. Transitions are one-directional:
 * NEW -> STARTING -> RUNNING -> STOPPING -> STOPPED, with a NEW/STARTING -> FAILED
 * branch if startup fails. A database that reaches STOPPED or FAILED cannot be
 * restarted; create a new instance instead.
 */
enum class PGliteLifecycleState {
    NEW,
    STARTING,
    RUNNING,
    STOPPING,
    STOPPED,
    FAILED,
}
