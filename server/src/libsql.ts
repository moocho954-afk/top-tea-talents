import { Database } from "bun:sqlite";
import * as fs from "node:fs";

// Storage layer: Turso (libSQL HTTP pipeline API, plain fetch, no SDK) when
// TURSO_DATABASE_URL + TURSO_AUTH_TOKEN are set, else bun:sqlite at
// DATABASE_PATH (default ./data/top-tea-talents.db).
// One uniform async interface: all / run / exec.

export type Row = Record<string, any>;

export interface Db {
  storage: "turso" | "sqlite";
  durable: boolean;
  all(sql: string, args?: any[]): Promise<Row[]>;
  run(sql: string, args?: any[]): Promise<{ changes: number; lastInsertRowid: number }>;
  exec(sql: string): Promise<void>;
}

function tursoArg(v: any): any {
  if (v === null || v === undefined) return { type: "null" };
  if (typeof v === "number") return Number.isInteger(v) ? { type: "integer", value: String(v) } : { type: "float", value: v };
  if (typeof v === "boolean") return { type: "integer", value: v ? "1" : "0" };
  if (v instanceof Uint8Array) return { type: "blob", value: Buffer.from(v).toString("base64") };
  return { type: "text", value: String(v) };
}

function tursoVal(v: any): any {
  if (!v || v.type === "null") return null;
  if (v.type === "integer") return parseInt(v.value, 10);
  if (v.type === "float") return Number(v.value);
  if (v.type === "blob") return Buffer.from(v.value, "base64").toString("base64");
  return v.value;
}

function stripSqlComments(sql: string): string {
  // Remove -- line comments and /* */ block comments, respecting
  // single-quoted string literals (a -- inside '...' is data, not a comment).
  // Needed because Turso rejects a comment-only statement ("SQL string does
  // not contain any statement") while bun:sqlite swallows the whole file.
  let out = "";
  let i = 0;
  let inStr = false;
  while (i < sql.length) {
    const c = sql[i];
    const n = sql[i + 1];
    if (inStr) {
      out += c;
      if (c === "'") inStr = false;
      i++;
      continue;
    }
    if (c === "'") { inStr = true; out += c; i++; continue; }
    if (c === "-" && n === "-") {
      while (i < sql.length && sql[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && n === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end === -1 ? sql.length : end + 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

class TursoDb implements Db {
  storage: "turso" = "turso";
  durable = true;
  constructor(private url: string, private token: string) {}
  private async pipeline(requests: any[]): Promise<any[]> {
    // Turso database URLs use the libsql:// scheme, but fetch() only accepts
    // http:/https: — convert to https:// for the HTTP pipeline endpoint.
    const httpUrl = this.url.replace(/^libsql:\/\//, "https://").replace(/\/$/, "");
    const res = await fetch(httpUrl + "/v2/pipeline", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ requests: [...requests, { type: "close" }] }),
    });
    if (!res.ok) throw new Error(`Turso pipeline HTTP ${res.status}: ${await res.text()}`);
    const json: any = await res.json();
    const results = json.results ?? [];
    for (const r of results) {
      if (r.type === "error") throw new Error(`Turso error: ${r.error?.message ?? JSON.stringify(r.error)}`);
    }
    return results;
  }
  async all(sql: string, args: any[] = []): Promise<Row[]> {
    // Hrana: a statement returns NO rows unless want_rows is set — without
    // it every SELECT comes back empty (writes still land, so the failure
    // looks like duplicate-key crashes instead of a read bug).
    const [r] = await this.pipeline([{ type: "execute", stmt: { sql, args: args.map(tursoArg), want_rows: true } }]);
    const result = r?.result;
    if (!result) return [];
    const cols: string[] = (result.cols ?? []).map((c: any) => c.name);
    return (result.rows ?? []).map((row: any[]) => {
      const o: Row = {};
      cols.forEach((c, i) => { o[c] = tursoVal(row[i]); });
      return o;
    });
  }
  async run(sql: string, args: any[] = []): Promise<{ changes: number; lastInsertRowid: number }> {
    const [r] = await this.pipeline([{ type: "execute", stmt: { sql, args: args.map(tursoArg) } }]);
    const result = r?.result;
    return {
      changes: result?.affected_row_count ?? 0,
      lastInsertRowid: result?.last_insert_rowid ? Number(result.last_insert_rowid) : 0,
    };
  }
  async exec(sql: string): Promise<void> {
    const stmts = stripSqlComments(sql).split(";").map((s) => s.trim()).filter((s) => s.length > 0);
    if (!stmts.length) return;
    await this.pipeline(stmts.map((s) => ({ type: "execute", stmt: { sql: s, args: [] } })));
  }
}

class SqliteDb implements Db {
  storage: "sqlite" = "sqlite";
  durable = false;
  private db: any;
  constructor(path: string) {
    const dir = path.split("/").slice(0, -1).join("/");
    if (dir) fs.mkdirSync(dir, { recursive: true });
    this.db = new Database(path);
    this.db.exec("PRAGMA journal_mode = WAL;");
  }
  async all(sql: string, args: any[] = []): Promise<Row[]> {
    return this.db.query(sql).all(...args) as Row[];
  }
  async run(sql: string, args: any[] = []): Promise<{ changes: number; lastInsertRowid: number }> {
    const info = this.db.query(sql).run(...args);
    return { changes: info.changes ?? 0, lastInsertRowid: Number(info.lastInsertRowid ?? 0) };
  }
  async exec(sql: string): Promise<void> {
    this.db.exec(sql);
  }
}

export function createDb(): Db {
  const tursoUrl = process.env.TURSO_DATABASE_URL;
  const tursoToken = process.env.TURSO_AUTH_TOKEN;
  if (tursoUrl && tursoToken) return new TursoDb(tursoUrl, tursoToken);
  const path = process.env.DATABASE_PATH || "./data/top-tea-talents.db";
  return new SqliteDb(path);
}
