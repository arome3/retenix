import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

// Sanctioned direct DATABASE_URL read (doc 00): this package is consumed by
// both apps (which validate DATABASE_URL in their typed env modules first)
// and by drizzle-kit tooling. Lazy init so importing the package never
// requires env at build time.
let pool: Pool | undefined;
let db: NodePgDatabase<typeof schema> | undefined;

export function getPool(): Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error("DATABASE_URL is not set");
    pool = new Pool({ connectionString });
  }
  return pool;
}

export function getDb(): NodePgDatabase<typeof schema> {
  if (!db) db = drizzle(getPool(), { schema });
  return db;
}

export type Db = NodePgDatabase<typeof schema>;
