# mtkruto-storage-sqlite

SQLite storage adapter for [MTKruto](https://github.com/MTKruto/MTKruto).

## Features

- Driver-agnostic: works with [`better-sqlite3`](https://github.com/WiseLibs/better-sqlite3) and [`bun:sqlite`](https://bun.sh/docs/api/sqlite)
- Synchronous API (no async overhead)
- Supports branching, range queries, and atomic `incr`
- Stores all value types including `BigInt` and `Uint8Array`

## Requirements

- Node.js with `better-sqlite3`, or Bun with `bun:sqlite`

## Installation

```bash
# npm
npm install mtkruto-storage-sqlite

# bun
bun add mtkruto-storage-sqlite
```

## Usage

### With `bun:sqlite`

```ts
import { Database } from "bun:sqlite";
import { StorageSqlite } from "mtkruto-storage-sqlite";

const db = new Database("session.db");
const storage = new StorageSqlite(db);
```

### With `better-sqlite3`

```ts
import Database from "better-sqlite3";
import { StorageSqlite } from "mtkruto-storage-sqlite";

const db = new Database("session.db");
const storage = new StorageSqlite(db);
```

### Passing storage to MTKruto

```ts
import { Client } from "@mtkruto/node";

const client = new Client(storage, apiId, apiHash);
await client.connect();
```

## API

### `new StorageSqlite(db: SqliteDatabase)`

Creates a new storage instance. The `db` parameter must implement the `SqliteDatabase` interface (compatible with both `better-sqlite3` and `bun:sqlite`).

### `storage.initialize()`

Creates the required table and prepares statements. Must be called before use — MTKruto calls this automatically.

### `storage.branch(id: string): StorageSqlite`

Returns a child storage instance that shares the same database connection but namespaces all keys under `id`.

## Development

```bash
# Build
npm run build

# Run tests
bun test
```

## License

GNU Lesser General Public License v3.0 — see [COPYING.LESSER](./COPYING.LESSER) for details.

Copyright (C) 2026 [https://github.com/KeksKlip](https://github.com/KeksKlip)