import * as fs from 'node:fs';
import * as path from 'node:path';

export interface TreeIndexEntry {
  treeId: string;
  family?: string;
  tags: string[];
  description?: string;
  taskName?: string;
  sessionCount: number;
  lastUsed: string; // ISO timestamp
  createdAt?: string;
  treePath?: string; // file path to the tree JSON, if known
}

export class TreeIndex {
  private indexPath: string;
  private entries: Map<string, TreeIndexEntry> = new Map();

  constructor(storeDir: string) {
    this.indexPath = path.join(storeDir, '_tree_index.json');
    this.loadSync();
  }

  /** Load index from disk. If missing or corrupt, start empty. */
  private loadSync(): void {
    if (!fs.existsSync(this.indexPath)) return;
    try {
      const raw = fs.readFileSync(this.indexPath, 'utf-8');
      const parsed = JSON.parse(raw) as TreeIndexEntry[];
      this.entries = new Map(parsed.map((e) => [e.treeId, e]));
    } catch {
      // Corrupt index — start fresh, will be rebuilt on next upsert/save
      this.entries = new Map();
    }
  }

  /** Persist the index to disk. */
  private async save(): Promise<void> {
    const arr = Array.from(this.entries.values());
    await fs.promises.writeFile(
      this.indexPath,
      JSON.stringify(arr, null, 2),
      'utf-8',
    );
  }

  /** Insert or update an entry. Merges fields — undefined values don't overwrite existing. */
  async upsert(entry: Partial<TreeIndexEntry> & { treeId: string }): Promise<void> {
    const existing = this.entries.get(entry.treeId);
    const merged: TreeIndexEntry = {
      treeId: entry.treeId,
      tags: entry.tags ?? existing?.tags ?? [],
      sessionCount: entry.sessionCount ?? existing?.sessionCount ?? 0,
      lastUsed: entry.lastUsed ?? existing?.lastUsed ?? new Date().toISOString(),
    };
    const family = entry.family ?? existing?.family;
    if (family !== undefined) merged.family = family;
    const description = entry.description ?? existing?.description;
    if (description !== undefined) merged.description = description;
    const taskName = entry.taskName ?? existing?.taskName;
    if (taskName !== undefined) merged.taskName = taskName;
    const createdAt = entry.createdAt ?? existing?.createdAt;
    if (createdAt !== undefined) merged.createdAt = createdAt;
    const treePath = entry.treePath ?? existing?.treePath;
    if (treePath !== undefined) merged.treePath = treePath;
    this.entries.set(entry.treeId, merged);
    await this.save();
  }

  /** Get a single entry by treeId. */
  get(treeId: string): TreeIndexEntry | undefined {
    return this.entries.get(treeId);
  }

  /** Get all entries. */
  getAll(): TreeIndexEntry[] {
    return Array.from(this.entries.values());
  }

  /** Get all entries belonging to a given family. */
  getFamily(family: string): TreeIndexEntry[] {
    return this.getAll().filter((e) => e.family === family);
  }

  /** Get sibling tree IDs (same family, excluding the given treeId). */
  getFamilySiblings(treeId: string): string[] {
    const entry = this.entries.get(treeId);
    if (!entry?.family) return [];
    return this.getFamily(entry.family)
      .filter((e) => e.treeId !== treeId)
      .map((e) => e.treeId);
  }

  /** Remove an entry. */
  async remove(treeId: string): Promise<void> {
    this.entries.delete(treeId);
    await this.save();
  }

  /** Search the index by a text query. Returns entries ranked by relevance.
   *
   * Scoring:
   * - Tag match (exact, case-insensitive): +3 per tag
   * - taskName/treeId token overlap: +2 per token
   * - Description token overlap: +1 per token
   * - Family match: +1
   * - Tiebreak: sessionCount (higher = better)
   */
  search(query: string, limit: number = 5): Array<TreeIndexEntry & { score: number; matchReasons: string[] }> {
    const queryTokens = tokenize(query);
    if (queryTokens.length === 0) return [];

    const results: Array<TreeIndexEntry & { score: number; matchReasons: string[] }> = [];

    for (const entry of this.entries.values()) {
      let score = 0;
      const matchReasons: string[] = [];

      // Tag matches (+3 each)
      for (const tag of entry.tags) {
        const tagLower = tag.toLowerCase();
        for (const qt of queryTokens) {
          if (tagLower === qt || tagLower.includes(qt) || qt.includes(tagLower)) {
            score += 3;
            matchReasons.push(`tag:"${tag}"`);
            break; // one match per tag
          }
        }
      }

      // taskName / treeId token overlap (+2 each)
      const nameTokens = tokenize(`${entry.taskName ?? ''} ${entry.treeId}`);
      for (const nt of nameTokens) {
        for (const qt of queryTokens) {
          if (nt === qt || nt.includes(qt) || qt.includes(nt)) {
            score += 2;
            matchReasons.push(`name:"${nt}"`);
            break;
          }
        }
      }

      // Description token overlap (+1 each)
      if (entry.description) {
        const descTokens = tokenize(entry.description);
        for (const dt of descTokens) {
          for (const qt of queryTokens) {
            if (dt === qt || dt.includes(qt) || qt.includes(dt)) {
              score += 1;
              matchReasons.push(`desc:"${dt}"`);
              break;
            }
          }
        }
      }

      // Family match (+1)
      if (entry.family) {
        const familyLower = entry.family.toLowerCase();
        for (const qt of queryTokens) {
          if (familyLower === qt || familyLower.includes(qt) || qt.includes(familyLower)) {
            score += 1;
            matchReasons.push(`family:"${entry.family}"`);
            break;
          }
        }
      }

      if (score > 0) {
        results.push({ ...entry, score, matchReasons });
      }
    }

    // Sort by score desc, then sessionCount desc as tiebreak
    results.sort((a, b) => b.score - a.score || b.sessionCount - a.sessionCount);
    return results.slice(0, limit);
  }

  /** Increment session count and update lastUsed for a treeId. */
  async recordSession(treeId: string): Promise<void> {
    const existing = this.entries.get(treeId);
    if (existing) {
      existing.sessionCount++;
      existing.lastUsed = new Date().toISOString();
      await this.save();
    }
  }

  /** Rebuild the index from the session store directory. Scans .jsonl files
   * to get treeIds and session counts. Preserves existing metadata where available. */
  async rebuild(storeDir: string): Promise<void> {
    if (!fs.existsSync(storeDir)) return;
    const files = await fs.promises.readdir(storeDir);
    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue;
      const treeId = file.slice(0, -'.jsonl'.length);
      const content = await fs.promises.readFile(
        path.join(storeDir, file),
        'utf-8',
      );
      const sessionCount = content.split('\n').filter((l) => l.trim()).length;
      await this.upsert({
        treeId,
        sessionCount,
        lastUsed: new Date().toISOString(),
      });
    }
  }
}

/** Lowercase, split on non-alpha, filter out stop words and short tokens. */
function tokenize(text: string): string[] {
  const stopWords = new Set(['the', 'a', 'an', 'is', 'to', 'for', 'and', 'or', 'in', 'of', 'with', 'this', 'that']);
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !stopWords.has(t));
}
