import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PersistedSession } from '../persistence/SessionStore.js';
import { SessionStore } from '../persistence/SessionStore.js';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dp-test-'));
}

function makeSession(
  stepCount = 3,
  status: 'success' | 'failure' = 'success',
): PersistedSession {
  const records = Array.from({ length: stepCount }, (_, i) => ({
    nodeId: `n${i}`,
    timestamp: Date.now() + i,
    metadata: {},
    status: i === stepCount - 1 ? status : ('pending' as const),
  }));
  return {
    timestamp: new Date().toISOString(),
    records,
    finalStatus: status,
    stepCount,
  };
}

describe('SessionStore', () => {
  let dir: string;
  let store: SessionStore;

  beforeEach(() => {
    dir = tempDir();
    store = new SessionStore(dir);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('creates the store directory if it does not exist', () => {
    const nested = path.join(dir, 'a', 'b', 'c');
    const s = new SessionStore(nested);
    expect(fs.existsSync(nested)).toBe(true);
    expect(s.getStoreDir()).toBe(nested);
  });

  it('append + load round-trips a single session', async () => {
    const session = makeSession(3);
    await store.append('tree-1', session);

    const loaded = await store.load('tree-1');
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.stepCount).toBe(3);
    expect(loaded[0]!.finalStatus).toBe('success');
    expect(loaded[0]!.records).toHaveLength(3);
  });

  it('appends multiple sessions in order', async () => {
    await store.append('tree-1', makeSession(3));
    await store.append('tree-1', makeSession(5));
    await store.append('tree-1', makeSession(2));

    const loaded = await store.load('tree-1');
    expect(loaded).toHaveLength(3);
    expect(loaded.map((s) => s.stepCount)).toEqual([3, 5, 2]);
  });

  it('returns empty array for unknown treeId', async () => {
    const loaded = await store.load('does-not-exist');
    expect(loaded).toEqual([]);
  });

  it('keeps sessions for different treeIds separate', async () => {
    await store.append('tree-a', makeSession(2));
    await store.append('tree-b', makeSession(5));

    expect(await store.load('tree-a')).toHaveLength(1);
    expect(await store.load('tree-b')).toHaveLength(1);
    expect((await store.load('tree-a'))[0]!.stepCount).toBe(2);
    expect((await store.load('tree-b'))[0]!.stepCount).toBe(5);
  });

  it('sanitizes treeIds with special characters', async () => {
    await store.append('my/weird:tree', makeSession(1));
    const files = fs.readdirSync(dir);
    expect(files.some((f) => f.endsWith('.jsonl'))).toBe(true);
    // Filename should not contain slashes or colons
    expect(files.every((f) => !f.includes('/') && !f.includes(':'))).toBe(true);
  });

  it('clear removes sessions for a treeId', async () => {
    await store.append('tree-1', makeSession());
    expect(await store.count('tree-1')).toBe(1);
    await store.clear('tree-1');
    expect(await store.count('tree-1')).toBe(0);
  });

  it('count returns the number of sessions', async () => {
    await store.append('t', makeSession());
    await store.append('t', makeSession());
    expect(await store.count('t')).toBe(2);
  });

  it('listTreeIds returns all tree files', async () => {
    await store.append('a', makeSession());
    await store.append('b', makeSession());
    await store.append('c', makeSession());

    const ids = await store.listTreeIds();
    expect(ids.sort()).toEqual(['a', 'b', 'c']);
  });

  it('skips malformed lines rather than failing', async () => {
    const safeId = 'tree-1';
    const filePath = path.join(dir, `${safeId}.jsonl`);
    fs.writeFileSync(
      filePath,
      'not-json\n{"valid":true,"timestamp":"x","records":[],"finalStatus":"success","stepCount":0}\nalso-bad\n',
    );

    const loaded = await store.load(safeId);
    expect(loaded).toHaveLength(1);
  });

  describe('compaction', () => {
    it('compacts old sessions and keeps recent ones', async () => {
      const compactStore = new SessionStore(dir, {
        maxSessionsPerTree: 100,
        retainRecent: 3,
      });

      for (let i = 0; i < 10; i++) {
        await compactStore.append('tree-1', makeSession(3, i < 7 ? 'success' : 'failure'));
      }

      const result = await compactStore.compact('tree-1', 3);
      expect(result.dropped).toBe(7);
      expect(result.summary).not.toBeNull();
      expect(result.summary!.droppedSessions).toBe(7);
      expect(result.summary!.successCount).toBe(7);
      expect(result.summary!.failureCount).toBe(0);

      const remaining = await compactStore.load('tree-1');
      expect(remaining).toHaveLength(3);
    });

    it('does nothing when session count is below retain threshold', async () => {
      for (let i = 0; i < 5; i++) {
        await store.append('tree-1', makeSession());
      }

      const result = await store.compact('tree-1', 10);
      expect(result.dropped).toBe(0);
      expect(result.summary).toBeNull();

      const loaded = await store.load('tree-1');
      expect(loaded).toHaveLength(5);
    });

    it('merges compaction summaries across multiple compactions', async () => {
      for (let i = 0; i < 10; i++) {
        await store.append('tree-1', makeSession());
      }
      await store.compact('tree-1', 5); // drop 5

      for (let i = 0; i < 10; i++) {
        await store.append('tree-1', makeSession());
      }
      const result = await store.compact('tree-1', 5); // drop 10 more

      expect(result.summary!.droppedSessions).toBe(15); // 5 + 10
    });

    it('writes compaction summary to sidecar file', async () => {
      for (let i = 0; i < 10; i++) {
        await store.append('tree-1', makeSession());
      }
      await store.compact('tree-1', 3);

      const summary = await store.getCompactionSummary('tree-1');
      expect(summary).not.toBeNull();
      expect(summary!.droppedSessions).toBe(7);
    });
  });

  describe('rotation', () => {
    it('moves the session file to a timestamped archive', async () => {
      await store.append('tree-1', makeSession());
      await store.append('tree-1', makeSession());

      const archivePath = await store.rotate('tree-1');
      expect(archivePath).not.toBeNull();
      expect(fs.existsSync(archivePath!)).toBe(true);
      expect(archivePath!).toContain('.archive.jsonl');

      // Original file should be gone
      const loaded = await store.load('tree-1');
      expect(loaded).toHaveLength(0);
    });

    it('returns null when no file exists', async () => {
      const result = await store.rotate('nonexistent');
      expect(result).toBeNull();
    });
  });

  describe('loadWithAutoCompact', () => {
    it('auto-compacts when session count exceeds threshold', async () => {
      const compactStore = new SessionStore(dir, {
        maxSessionsPerTree: 5,
        retainRecent: 3,
      });

      for (let i = 0; i < 8; i++) {
        await compactStore.append('tree-1', makeSession());
      }

      const { sessions, compacted } =
        await compactStore.loadWithAutoCompact('tree-1');
      expect(compacted).toBe(true);
      expect(sessions).toHaveLength(3);
    });

    it('skips compaction when under threshold', async () => {
      const compactStore = new SessionStore(dir, {
        maxSessionsPerTree: 100,
        retainRecent: 50,
      });

      for (let i = 0; i < 5; i++) {
        await compactStore.append('tree-1', makeSession());
      }

      const { sessions, compacted } =
        await compactStore.loadWithAutoCompact('tree-1');
      expect(compacted).toBe(false);
      expect(sessions).toHaveLength(5);
    });
  });
});
