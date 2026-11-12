import Foundation
#if canImport(SQLite3)
    import SQLite3
#else
    import CSQLite
#endif

/// A failed SQLite call, with SQLite's message (never row contents).
public struct DatabaseError: Error, CustomStringConvertible {
    public let code: Int32
    public let message: String
    public var description: String { "sqlite \(code): \(message)" }
}

/// A value bound to or read from a statement.
public enum SQLValue: Sendable, Equatable {
    case null
    case int(Int64)
    case text(String)
}

/// A minimal SQLite connection (docs/ADR/0025-ios-storage-and-bookmarks.md): parameterized statements only, one
/// connection used from one actor. Apple's SQLite on iOS, the system library on Linux (tests).
public final class Database: @unchecked Sendable {
    private var db: OpaquePointer?
    private static let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

    /// Opens (creating) the database at `path`, or an in-memory one for ":memory:".
    public init(path: String) throws {
        let flags = SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX
        let rc = sqlite3_open_v2(path, &db, flags, nil)
        guard rc == SQLITE_OK else {
            let msg = db.map { String(cString: sqlite3_errmsg($0)) } ?? "open failed"
            sqlite3_close(db)
            throw DatabaseError(code: rc, message: msg)
        }
        try execute("PRAGMA journal_mode = WAL")
        try execute("PRAGMA foreign_keys = ON")
    }

    deinit { sqlite3_close(db) }

    /// Runs statements without results.
    public func execute(_ sql: String, _ args: [SQLValue] = []) throws {
        _ = try query(sql, args)
    }

    /// Runs one statement and returns its rows as column-name maps.
    @discardableResult
    public func query(_ sql: String, _ args: [SQLValue] = []) throws -> [[String: SQLValue]] {
        var stmt: OpaquePointer?
        try check(sqlite3_prepare_v2(db, sql, -1, &stmt, nil))
        defer { sqlite3_finalize(stmt) }
        for (i, a) in args.enumerated() {
            let idx = Int32(i + 1)
            switch a {
            case .null: try check(sqlite3_bind_null(stmt, idx))
            case let .int(v): try check(sqlite3_bind_int64(stmt, idx, v))
            case let .text(s): try check(sqlite3_bind_text(stmt, idx, s, -1, Database.transient))
            }
        }
        var rows: [[String: SQLValue]] = []
        while true {
            let rc = sqlite3_step(stmt)
            if rc == SQLITE_DONE { break }
            guard rc == SQLITE_ROW else { try check(rc); break }
            var row: [String: SQLValue] = [:]
            for c in 0 ..< sqlite3_column_count(stmt) {
                let name = String(cString: sqlite3_column_name(stmt, c))
                switch sqlite3_column_type(stmt, c) {
                case SQLITE_NULL: row[name] = .null
                case SQLITE_INTEGER: row[name] = .int(sqlite3_column_int64(stmt, c))
                default: row[name] = .text(String(cString: sqlite3_column_text(stmt, c)))
                }
            }
            rows.append(row)
        }
        return rows
    }

    /// Rows changed by the last statement.
    public var changes: Int { Int(sqlite3_changes(db)) }

    /// Runs `body` in a transaction, rolling back when it throws.
    public func transaction<T>(_ body: () throws -> T) throws -> T {
        try execute("BEGIN IMMEDIATE")
        do {
            let result = try body()
            try execute("COMMIT")
            return result
        } catch {
            try? execute("ROLLBACK")
            throw error
        }
    }

    public var userVersion: Int {
        get { (try? query("PRAGMA user_version").first?.int("user_version")).flatMap { $0 }.map(Int.init) ?? 0 }
        set { try? execute("PRAGMA user_version = \(newValue)") }
    }

    private func check(_ rc: Int32) throws {
        guard rc == SQLITE_OK || rc == SQLITE_ROW || rc == SQLITE_DONE else {
            throw DatabaseError(code: rc, message: String(cString: sqlite3_errmsg(db)))
        }
    }
}

public extension [String: SQLValue] {
    func string(_ k: String) -> String? { if case let .text(s)? = self[k] { s } else { nil } }
    func int(_ k: String) -> Int64? { if case let .int(v)? = self[k] { v } else { nil } }
}
