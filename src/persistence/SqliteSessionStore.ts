import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import type { EnhancedPathRecord, VisitStatus } from '../core/interfaces.js';
import type {
  CompactionSummary,
  FinalStatus,
  PersistedSession,
  SessionStoreOptions,
} from './SessionStore.js';

/**
 * SQLite-backed session store.
 *
 * Drop-in replacement for the JSONL `SessionStore`. Uses better-sqlite3 for
 * synchronous reads (fast) and handles concurrency natively via SQLite's
 * WAL mode — no file locking needed.
 *
 * Database location: `{storeDir}/sessions.db` (default: `~/.decision-pathfinder/sessions/sessions.db`)
 */
export class SqliteSessionStore {
  private db: Database.Database;
  private storeDir: string;
  private maxSessionsPerTree: number;
  private retainRecent: number;

  constructor(storeDir?: string, options?: SessionStoreOptions) {
    this.storeDir =
      storeDir ?? path.join(os.homedir(), '.decision-pathfinder', 'sessions');
    this.maxSessionsPerTree = options?.maxSessionsPerTree ?? 1000;
    this.retainRecent = options?.retainRecent ?? 200;

    if (!fs.existsSync(this.storeDir)) {
      fs.mkdirSync(this.storeDir, { recursive: true });
    }

    const dbPath = path.join(this.storeDir, 'sessions.db');
    this.db = new Database(dbPath);

    // WAL mode for concurrent readers + single writer
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tree_id TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        final_status TEXT NOT NULL,
        step_count INTEGER NOT NULL,
        failure_reason TEXT,
        records_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_tree_id ON sessions(tree_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_tree_timestamp ON sessions(tree_id, timestamp);

      CREATE TABLE IF NOT EXISTS compaction_summaries (
        tree_id TEXT PRIMARY KEY,
        compacted_at TEXT NOT NULL,
        dropped_sessions INTEGER NOT NULL,
        success_count INTEGER NOT NULL,
        failure_count INTEGER NOT NULL,
        total_steps INTEGER NOT NULL,
        oldest_timestamp TEXT NOT NULL,
        newest_timestamp TEXT NOT NULL
      );
    `);
  }

  getStoreDir(): string {
    return this.storeDir;
  }

  async append(treeId: string, session: PersistedSession): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT INTO sessions (tree_id, timestamp, final_status, step_count, failure_reason, records_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      treeId,
      session.timestamp,
      session.finalStatus,
      session.stepCount,
      session.failureReason ?? null,
      JSON.stringify(session.records),
    );
  }

  async load(treeId: string): Promise<PersistedSession[]> {
    const rows = this.db
      .prepare(
        'SELECT timestamp, final_status, step_count, failure_reason, records_json FROM sessions WHERE tree_id = ? ORDER BY id',
      )
      .all(treeId) as Array<{
      timestamp: string;
      final_status: string;
      step_count: number;
      failure_reason: string | null;
      records_json: string;
    }>;

    return rows.map((row) => {
      const session: PersistedSession = {
        timestamp: row.timestamp,
        records: JSON.parse(row.records_json) as EnhancedPathRecord[],
        finalStatus: row.final_status as FinalStatus,
        stepCount: row.step_count,
      };
      if (row.failure_reason !== null) {
        session.failureReason = row.failure_reason;
      }
      return session;
    });
  }

  async clear(treeId: string): Promise<void> {
    this.db.prepare('DELETE FROM sessions WHERE tree_id = ?').run(treeId);
  }

  async count(treeId: string): Promise<number> {
    const row = this.db
      .prepare('SELECT COUNT(*) as cnt FROM sessions WHERE tree_id = ?')
      .get(treeId) as { cnt: number };
    return row.cnt;
  }

  async listTreeIds(): Promise<string[]> {
    const rows = this.db
      .prepare('SELECT DISTINCT tree_id FROM sessions ORDER BY tree_id')
      .all() as Array<{ tree_id: string }>;
    return rows.map((r) => r.tree_id);
  }

  async compact(
    treeId: string,
    retainRecent?: number,
  ): Promise<{ dropped: number; summary: CompactionSummary | null }> {
    const retain = retainRecent ?? this.retainRecent;
    const totalCount = await this.count(treeId);
    if (totalCount <= retain) {
      return { dropped: 0, summary: null };
    }

    const toDrop = totalCount - retain;

    // Get stats of sessions to drop
    const stats = this.db
      .prepare(
        `SELECT
          COUNT(*) as cnt,
          SUM(CASE WHEN final_status = 'success' THEN 1 ELSE 0 END) as success_count,
          SUM(CASE WHEN final_status != 'success' THEN 1 ELSE 0 END) as failure_count,
          SUM(step_count) as total_steps,
          MIN(timestamp) as oldest_timestamp,
          MAX(timestamp) as newest_timestamp
        FROM (
          SELECT final_status, step_count, timestamp
          FROM sessions WHERE tree_id = ?
          ORDER BY id LIMIT ?
        )`,
      )
      .get(treeId, toDrop) as {
      cnt: number;
      success_count: number;
      failure_count: number;
      total_steps: number;
      oldest_timestamp: string;
      newest_timestamp: string;
    };

    // Delete the old sessions
    this.db
      .prepare(
        `DELETE FROM sessions WHERE id IN (
          SELECT id FROM sessions WHERE tree_id = ? ORDER BY id LIMIT ?
        )`,
      )
      .run(treeId, toDrop);

    // Merge with prior compaction summary
    const prior = await this.getCompactionSummary(treeId);
    const summary: CompactionSummary = {
      compactedAt: new Date().toISOString(),
      droppedSessions: toDrop + (prior?.droppedSessions ?? 0),
      successCount: stats.success_count + (prior?.successCount ?? 0),
      failureCount: stats.failure_count + (prior?.failureCount ?? 0),
      totalSteps: stats.total_steps + (prior?.totalSteps ?? 0),
      oldestTimestamp: prior?.oldestTimestamp || stats.oldest_timestamp,
      newestTimestamp: stats.newest_timestamp,
    };

    this.db
      .prepare(
        `INSERT OR REPLACE INTO compaction_summaries
        (tree_id, compacted_at, dropped_sessions, success_count, failure_count, total_steps, oldest_timestamp, newest_timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        treeId,
        summary.compactedAt,
        summary.droppedSessions,
        summary.successCount,
        summary.failureCount,
        summary.totalSteps,
        summary.oldestTimestamp,
        summary.newestTimestamp,
      );

    return { dropped: toDrop, summary };
  }

  async rotate(treeId: string): Promise<string | null> {
    const cnt = await this.count(treeId);
    if (cnt === 0) return null;

    // "Rotate" in SQLite means: export to an archive file, then delete from DB
    const sessions = await this.load(treeId);
    const timestamp = new Date()
      .toISOString()
      .replace(/[:.]/g, '-')
      .slice(0, 19);
    const safe = treeId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const archivePath = path.join(
      this.storeDir,
      `${safe}.${timestamp}.archive.jsonl`,
    );

    const lines = sessions.map((s) => JSON.stringify(s)).join('\n') + '\n';
    await fs.promises.writeFile(archivePath, lines, 'utf-8');
    await this.clear(treeId);

    return archivePath;
  }

  async loadWithAutoCompact(
    treeId: string,
  ): Promise<{ sessions: PersistedSession[]; compacted: boolean }> {
    const cnt = await this.count(treeId);
    if (this.maxSessionsPerTree > 0 && cnt > this.maxSessionsPerTree) {
      await this.compact(treeId);
      return { sessions: await this.load(treeId), compacted: true };
    }
    return { sessions: await this.load(treeId), compacted: false };
  }

  async getCompactionSummary(
    treeId: string,
  ): Promise<CompactionSummary | null> {
    const row = this.db
      .prepare('SELECT * FROM compaction_summaries WHERE tree_id = ?')
      .get(treeId) as
      | {
          compacted_at: string;
          dropped_sessions: number;
          success_count: number;
          failure_count: number;
          total_steps: number;
          oldest_timestamp: string;
          newest_timestamp: string;
        }
      | undefined;

    if (!row) return null;
    return {
      compactedAt: row.compacted_at,
      droppedSessions: row.dropped_sessions,
      successCount: row.success_count,
      failureCount: row.failure_count,
      totalSteps: row.total_steps,
      oldestTimestamp: row.oldest_timestamp,
      newestTimestamp: row.newest_timestamp,
    };
  }

  /** Close the database connection. */
  close(): void {
    this.db.close();
  }
}
