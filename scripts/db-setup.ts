// Creates the items table and loads DB_ROWS rows, as the DSQL admin role, using the same connector as the app.
// Usage: npm run db-setup -- <cluster-endpoint>      (idempotent; uses the default AWS credentials)
import { AuroraDSQLClient } from "@aws/aurora-dsql-node-postgres-connector";
import { DB_ROWS } from "../src/db.js";

const host = process.argv[2];
if (!host) {
  console.error("usage: db-setup <cluster-endpoint>");
  process.exit(2);
}

const client = new AuroraDSQLClient({ host, user: "admin" });
await client.connect();
try {
  // DSQL does not allow DDL and DML in the same transaction, so each statement runs on its own.
  await client.query("CREATE TABLE IF NOT EXISTS items (id integer PRIMARY KEY, payload text NOT NULL)");
  // 1,000 rows of about 100 bytes; the per-transaction limit is 3,000 rows.
  // Rows are built here (about 100 bytes each) and sent as one multi-row INSERT, so the SQL stays plain.
  const ids = Array.from({ length: DB_ROWS }, (_, i) => i + 1);
  const payload = (id: number) => `row-${id}-`.padEnd(100, "x");
  await client.query(
    `INSERT INTO items (id, payload) VALUES ${ids.map((_, i) => `($${2 * i + 1}, $${2 * i + 2})`).join(", ")}
     ON CONFLICT (id) DO NOTHING`,
    ids.flatMap((id) => [id, payload(id)]),
  );
  const { rows } = await client.query("SELECT count(*)::int AS n, min(length(payload))::int AS bytes FROM items");
  console.log(`items: ${rows[0].n} rows, payload ${rows[0].bytes} bytes`);
} finally {
  await client.end();
}
