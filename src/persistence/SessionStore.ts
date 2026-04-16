import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { EnhancedPathRecord, VisitStatus } from '../core/interfaces.js';

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
export class SessionStore {
  private storeDir: string;

  constructor(storeDir?: string) {
    this.storeDir =
      storeDir ?? path.join(os.homedir(), '.decision-pathfinder', 'sessions');
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
    await fs.promises.appendFile(filePath, line, 'utf-8');
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
}
