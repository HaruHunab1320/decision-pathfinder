import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { EnhancedPathRecord, VisitStatus } from '../core/interfaces.js';
import { withLock } from './FileLock.js';

export type FinalStatus =
  | 'success'
  | 'failure'
  | 'error'
  | 'max_steps_exceeded'
  | VisitStatus;

export interface PersistedSession {
  timestamp: string;
  records: EnhancedPathRecord[];
  finalStatus: FinalStatus;
  stepCount: number;
  /** Extracted reason for failure, if the session ended in failure. */
  failureReason?: string;
}

/**
 * Append-only JSONL session store.
 *
 * Each tree gets its own file at `{storeDir}/{treeId}.jsonl`. Every completed
 * session appends one line (valid JSON). This is crash-safe, debuggable
 * (you can `cat` / `grep` / `tail` the files), and suitable for single-process
 * writers (the MCP server).
 *
 * Default directory: `~/.decision-pathfinder/sessions/`
 */
export interface SessionStoreOptions {
  /**
   * Maximum sessions to keep per tree before auto-compaction triggers on load().
   * Set to 0 to disable auto-compaction. Default: 1000.
   */
  maxSessionsPerTree?: number;

  /**
   * Number of recent sessions to retain during compaction.
   * Older sessions are replaced with a single summary record.
   * Default: 200.
   */
  retainRecent?: number;
}

/** Summary record written during compaction to preserve aggregate stats. */
export interface CompactionSummary {
  compactedAt: string;
  droppedSessions: number;
  successCount: number;
  failureCount: number;
  totalSteps: number;
  oldestTimestamp: string;
  newestTimestamp: string;
}

export class SessionStore {
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
  }

  getStoreDir(): string {
    return this.storeDir;
  }

  private fileFor(treeId: string): string {
    // Sanitize treeId to be a safe filename
    const safe = treeId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(this.storeDir, `${safe}.jsonl`);
  }

  async append(treeId: string, session: PersistedSession): Promise<void> {
    const filePath = this.fileFor(treeId);
    const line = `${JSON.stringify(session)}\n`;
    await withLock(filePath, () =>
      fs.promises.appendFile(filePath, line, 'utf-8'),
    );
  }

  async load(treeId: string): Promise<PersistedSession[]> {
    const filePath = this.fileFor(treeId);
    if (!fs.existsSync(filePath)) {
      return [];
    }
    const content = await fs.promises.readFile(filePath, 'utf-8');
    const sessions: PersistedSession[] = [];
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        sessions.push(JSON.parse(trimmed) as PersistedSession);
      } catch {
        // Skip malformed lines rather than fail the whole load
      }
    }
    return sessions;
  }

  async clear(treeId: string): Promise<void> {
    const filePath = this.fileFor(treeId);
    if (fs.existsSync(filePath)) {
      await fs.promises.unlink(filePath);
    }
  }

  async count(treeId: string): Promise<number> {
    const sessions = await this.load(treeId);
    return sessions.length;
  }

  async listTreeIds(): Promise<string[]> {
    if (!fs.existsSync(this.storeDir)) return [];
    const entries = await fs.promises.readdir(this.storeDir);
    return entries
      .filter((e) => e.endsWith('.jsonl'))
      .map((e) => e.slice(0, -'.jsonl'.length));
  }

  /**
   * Compact a tree's session file: keep the most recent `retainRecent`
   * sessions and replace older ones with a summary marker file.
   *
   * Returns the number of sessions dropped, or 0 if no compaction needed.
   */
  async compact(
    treeId: string,
    retainRecent?: number,
  ): Promise<{ dropped: number; summary: CompactionSummary | null }> {
    const retain = retainRecent ?? this.retainRecent;
    const sessions = await this.load(treeId);
    if (sessions.length <= retain) {
      return { dropped: 0, summary: null };
    }

    const dropped = sessions.slice(0, sessions.length - retain);
    const kept = sessions.slice(sessions.length - retain);

    // Build summary of dropped sessions
    let successCount = 0;
    let failureCount = 0;
    let totalSteps = 0;
    for (const s of dropped) {
      if (s.finalStatus === 'success') successCount++;
      else failureCount++;
      totalSteps += s.stepCount;
    }

    const summary: CompactionSummary = {
      compactedAt: new Date().toISOString(),
      droppedSessions: dropped.length,
      successCount,
      failureCount,
      totalSteps,
      oldestTimestamp: dropped[0]?.timestamp ?? '',
      newestTimestamp: dropped[dropped.length - 1]?.timestamp ?? '',
    };

    // Write summary to sidecar file
    const summaryPath = path.join(
      this.storeDir,
      `${treeId.replace(/[^a-zA-Z0-9_-]/g, '_')}.compaction.json`,
    );
    // Merge with any prior compaction summary
    let priorSummary: CompactionSummary | undefined;
    if (fs.existsSync(summaryPath)) {
      try {
        priorSummary = JSON.parse(
          fs.readFileSync(summaryPath, 'utf-8'),
        ) as CompactionSummary;
      } catch {
        // ignore corrupt summary
      }
    }

    const mergedSummary: CompactionSummary = {
      compactedAt: summary.compactedAt,
      droppedSessions:
        summary.droppedSessions + (priorSummary?.droppedSessions ?? 0),
      successCount: summary.successCount + (priorSummary?.successCount ?? 0),
      failureCount: summary.failureCount + (priorSummary?.failureCount ?? 0),
      totalSteps: summary.totalSteps + (priorSummary?.totalSteps ?? 0),
      oldestTimestamp: priorSummary?.oldestTimestamp || summary.oldestTimestamp,
      newestTimestamp: summary.newestTimestamp,
    };

    await fs.promises.writeFile(
      summaryPath,
      JSON.stringify(mergedSummary, null, 2),
      'utf-8',
    );

    // Rewrite the JSONL file with only kept sessions (under lock)
    const filePath = this.fileFor(treeId);
    const lines = kept.map((s) => JSON.stringify(s)).join('\n') + '\n';
    await withLock(filePath, () =>
      fs.promises.writeFile(filePath, lines, 'utf-8'),
    );

    return { dropped: dropped.length, summary: mergedSummary };
  }

  /**
   * Rotate a tree's session file: move current file to a timestamped archive
   * and start fresh. Returns the archive path, or null if no file existed.
   */
  async rotate(treeId: string): Promise<string | null> {
    const filePath = this.fileFor(treeId);
    if (!fs.existsSync(filePath)) return null;

    const timestamp = new Date()
      .toISOString()
      .replace(/[:.]/g, '-')
      .slice(0, 19);
    const safe = treeId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const archivePath = path.join(
      this.storeDir,
      `${safe}.${timestamp}.archive.jsonl`,
    );
    await withLock(filePath, () =>
      fs.promises.rename(filePath, archivePath),
    );
    return archivePath;
  }

  /**
   * Load sessions with optional auto-compaction when the session count
   * exceeds `maxSessionsPerTree`.
   */
  async loadWithAutoCompact(
    treeId: string,
  ): Promise<{ sessions: PersistedSession[]; compacted: boolean }> {
    const sessions = await this.load(treeId);
    if (
      this.maxSessionsPerTree > 0 &&
      sessions.length > this.maxSessionsPerTree
    ) {
      await this.compact(treeId);
      const compacted = await this.load(treeId);
      return { sessions: compacted, compacted: true };
    }
    return { sessions, compacted: false };
  }

  /** Get the compaction summary for a tree, if any compaction has occurred. */
  async getCompactionSummary(
    treeId: string,
  ): Promise<CompactionSummary | null> {
    const summaryPath = path.join(
      this.storeDir,
      `${treeId.replace(/[^a-zA-Z0-9_-]/g, '_')}.compaction.json`,
    );
    if (!fs.existsSync(summaryPath)) return null;
    try {
      return JSON.parse(
        await fs.promises.readFile(summaryPath, 'utf-8'),
      ) as CompactionSummary;
    } catch {
      return null;
    }
  }
}
