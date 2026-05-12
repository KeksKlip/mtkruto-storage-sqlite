/**
 * mtkruto-storage-sqlite - SQLite storage for MTKruto
 * Copyright (C) 2026 <https://github.com/KeksKlip>
 *
 * This file is part of mtkruto-storage-sqlite.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Lesser General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Lesser General Public License for more details.
 *
 * You should have received a copy of the GNU Lesser General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */


import { type Storage, type StorageKeyPart, type GetManyFilter } from "@mtkruto/node";

// ---------------------------------------------------------------------------
// Driver-agnostic interfaces (compatible with better-sqlite3 and bun:sqlite)
// ---------------------------------------------------------------------------

export interface SqliteStatement {
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
}

export interface SqliteDatabase {
  prepare(sql: string): SqliteStatement;
  transaction<T>(fn: (...args: unknown[]) => T): (...args: unknown[]) => T;
  exec(sql: string): void;
  close(): void;
}

// ---------------------------------------------------------------------------
// Serialization helpers
// ---------------------------------------------------------------------------

type SerializedSpecial =
  | { __type: "bigint"; value: string }
  | { __type: "uint8array"; value: string };

function serializeValue(value: unknown): Buffer {
  const json = JSON.stringify(value, (_key, v) => {
    if (v instanceof Uint8Array) {
      return { __type: "uint8array", value: Buffer.from(v).toString("base64") } satisfies SerializedSpecial;
    }
    if (typeof v === "bigint") {
      return { __type: "bigint", value: v.toString() } satisfies SerializedSpecial;
    }
    return v;
  });
  return Buffer.from(json, "utf8");
}

function deserializeValue<T>(blob: unknown): T | null {
  if (blob === null || blob === undefined) return null;

  let bytes: Uint8Array;
  if (blob instanceof Uint8Array) {
    bytes = blob;
  } else if (Buffer.isBuffer(blob)) {
    bytes = new Uint8Array(blob);
  } else if (Array.isArray(blob)) {
    bytes = new Uint8Array(blob as number[]);
  } else if (typeof blob === "object" && blob !== null) {
    // SQLite may return BLOB as a plain object { 0: byte, 1: byte, ... }
    const values = Object.values(blob as Record<string, number>);
    bytes = new Uint8Array(values);
  } else {
    return null;
  }

  const json = Buffer.from(bytes).toString("utf8");

  return JSON.parse(json, (_key, v) => {
    if (v && typeof v === "object" && "__type" in v) {
      const typed = v as SerializedSpecial;
      if (typed.__type === "uint8array") {
        return new Uint8Array(Buffer.from(typed.value, "base64"));
      }
      if (typed.__type === "bigint") {
        return BigInt(typed.value);
      }
    }
    return v;
  }) as T;
}

// ---------------------------------------------------------------------------
// Key serialization
//
// Keys are stored as JSON arrays: JSON.stringify([branchId, ...keyParts])
// Branch prefix is the first element of the array — no string concatenation,
// no separator conflicts, naturally sortable by SQLite text ordering.
// ---------------------------------------------------------------------------

function serializeKey(key: readonly StorageKeyPart[], branchId: string | null): string {
  const parts: unknown[] = branchId !== null ? [branchId, ...key] : [...key];
  return JSON.stringify(parts);
}

function deserializeKey(
  raw: string,
  branchId: string | null,
): readonly StorageKeyPart[] | null {
  let parsed: unknown[];
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!Array.isArray(parsed)) return null;

  if (branchId !== null) {
    if (parsed[0] !== branchId) return null;
    return parsed.slice(1) as StorageKeyPart[];
  }

  return parsed as StorageKeyPart[];
}

// Build a GLOB pattern that matches all keys with a given prefix.
// JSON arrays start with "[" and elements are comma-separated, so a prefix
// key ["a","b"] serializes to '["a","b"' — we append '*' to match any suffix.
function prefixToGlob(prefix: readonly StorageKeyPart[], branchId: string | null): string {
  const serialized = serializeKey(prefix, branchId);
  // Remove the closing "]" and append wildcard
  return serialized.slice(0, -1) + "*";
}

// ---------------------------------------------------------------------------
// StorageSqlite
// ---------------------------------------------------------------------------

interface Statements {
  get: SqliteStatement;
  set: SqliteStatement;
  del: SqliteStatement;
  getManyPrefix: SqliteStatement;
  getManyPrefixDesc: SqliteStatement;
  getManyRange: SqliteStatement;
  getManyRangeDesc: SqliteStatement;
}

export class StorageSqlite implements Storage {
  readonly #db: SqliteDatabase;
  #id: string | null = null;
  #stmts: Statements | null = null;

  constructor(db: SqliteDatabase) {
    this.#db = db;
  }

  // -------------------------------------------------------------------------
  // Storage interface metadata
  // -------------------------------------------------------------------------

  get mustSerialize(): boolean {
    return true;
  }

  get isMemory(): boolean {
    return false;
  }

  get supportsFiles(): boolean {
    return true;
  }

  // -------------------------------------------------------------------------
  // Initialization
  // -------------------------------------------------------------------------

  initialize(): void {
    if (this.#stmts !== null) return;

    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS kv (
        key   TEXT PRIMARY KEY,
        value BLOB NOT NULL
      ) WITHOUT ROWID;
    `);

    this.#stmts = {
      get: this.#db.prepare(
        "SELECT value FROM kv WHERE key = ?",
      ),
      set: this.#db.prepare(
        "INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)",
      ),
      del: this.#db.prepare(
        "DELETE FROM kv WHERE key = ?",
      ),
      getManyPrefix: this.#db.prepare(
        "SELECT key, value FROM kv WHERE key GLOB ? ORDER BY key ASC LIMIT ?",
      ),
      getManyPrefixDesc: this.#db.prepare(
        "SELECT key, value FROM kv WHERE key GLOB ? ORDER BY key DESC LIMIT ?",
      ),
      getManyRange: this.#db.prepare(
        "SELECT key, value FROM kv WHERE key >= ? AND key <= ? ORDER BY key ASC LIMIT ?",
      ),
      getManyRangeDesc: this.#db.prepare(
        "SELECT key, value FROM kv WHERE key >= ? AND key <= ? ORDER BY key DESC LIMIT ?",
      ),
    };
  }

  #requireStmts(): Statements {
    if (this.#stmts === null) throw new Error("StorageSqlite: not initialized");
    return this.#stmts;
  }

  // -------------------------------------------------------------------------
  // Branching — shares the DB connection and prepared statements
  // -------------------------------------------------------------------------

  branch(id: string): StorageSqlite {
    // Ensure this instance is initialized before branching
    this.#requireStmts();

    const child = new StorageSqlite(this.#db);
    child.#id = this.#id !== null ? `${this.#id}/${id}` : id;
    child.#stmts = this.#stmts;
    return child;
  }

  // -------------------------------------------------------------------------
  // set
  // -------------------------------------------------------------------------

  set(key: readonly StorageKeyPart[], value: unknown): void {
    const { set, del } = this.#requireStmts();
    const serializedKey = serializeKey(key, this.#id);

    if (value === null || value === undefined) {
      del.run(serializedKey);
    } else {
      set.run(serializedKey, serializeValue(value));
    }
  }

  // -------------------------------------------------------------------------
  // get
  // -------------------------------------------------------------------------

  get<T>(key: readonly StorageKeyPart[]): T | null {
    const { get } = this.#requireStmts();
    const row = get.get(serializeKey(key, this.#id)) as { value: unknown } | undefined;
    if (!row) return null;
    return deserializeValue<T>(row.value);
  }

  // -------------------------------------------------------------------------
  // getMany — AsyncGenerator, range queries via SQL GLOB / BETWEEN
  // -------------------------------------------------------------------------

  async *getMany<T>(
    filter: GetManyFilter,
    params?: { limit?: number; reverse?: boolean },
  ): AsyncGenerator<[readonly StorageKeyPart[], T]> {
    const stmts = this.#requireStmts();
    const limit = (params?.limit !== undefined && params.limit > 0) ? params.limit : -1;
    // SQLite LIMIT -1 means no limit — matches the contract exactly
    const sqlLimit = limit === -1 ? 9_007_199_254_740_991 : limit;
    const reverse = params?.reverse ?? false;

    let rows: unknown[];

    if ("prefix" in filter) {
      const glob = prefixToGlob(filter.prefix, this.#id);
      const stmt = reverse ? stmts.getManyPrefixDesc : stmts.getManyPrefix;
      rows = stmt.all(glob, sqlLimit);
    } else {
      const startKey = serializeKey(filter.start, this.#id);
      const endKey = serializeKey(filter.end, this.#id);
      const stmt = reverse ? stmts.getManyRangeDesc : stmts.getManyRange;
      rows = stmt.all(startKey, endKey, sqlLimit);
    }

    for (const row of rows as Array<{ key: string; value: unknown }>) {
      const key = deserializeKey(row.key, this.#id);
      if (key === null) continue;

      const value = deserializeValue<T>(row.value);
      if (value === null) continue;

      yield [key, value];
    }
  }

  // -------------------------------------------------------------------------
  // incr — atomic read-modify-write inside a SQLite transaction
  // -------------------------------------------------------------------------

  incr(key: readonly StorageKeyPart[], by: number): void {
    this.#requireStmts();
    const run = this.#db.transaction(() => {
      const current = this.get<number>(key) ?? 0;
      if (typeof current !== "number") {
        throw new TypeError(
          `StorageSqlite.incr: expected numeric value, got ${typeof current}`,
        );
      }
      this.set(key, current + by);
    });
    run();
  }
}