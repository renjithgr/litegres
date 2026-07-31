package dev.litegres.core.init

import java.sql.Connection

/**
 * Executes an init script's full text as a single JDBC `Statement.execute()` call.
 *
 * This intentionally does not implement its own SQL statement splitter: the
 * PostgreSQL simple-query protocol already splits semicolon-separated statements
 * server-side (correctly handling dollar-quoted function bodies, string
 * literals, etc.), so handing the whole script to the driver in one call gets
 * that splitting for free. The one limitation this brings is that psql
 * meta-commands (`\i`, `\copy`, ...) are not supported, since those are a psql
 * client feature, not part of the wire protocol.
 */
internal object SqlScriptRunner {
    fun run(connection: Connection, script: InitScript) {
        val sql = script.readSql()
        connection.createStatement().use { statement -> statement.execute(sql) }
    }
}
