import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PersistedSession } from '../persistence/SessionStore.js';
import { SqliteSessionStore } from '../persistence/SqliteSessionStore.js';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dp-sqlite-test-'));
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

describe('SqliteSessionStore', () => {
  let dir: string;
  let store: SqliteSessionStore;

  beforeEach(() => {
    dir = tempDir();
    store = new SqliteSessionStore(dir);
  });

  afterEach(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('creates the database file', () => {
    expect(fs.existsSync(path.join(dir, 'sessions.db'))).toBe(true);
  });

  it('append + load round-trips a session', async () => {
    await store.append('tree-1', makeSession(3));
    const loaded = await store.load('tree-1');
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.stepCount).toBe(3);
    expect(loaded[0]!.records).toHaveLength(3);
  });

  it('appends multiple sessions in order', async () => {
    await store.append('t', makeSession(3));
    await store.append('t', makeSession(5));
    await store.append('t', makeSession(2));

    const loaded = await store.load('t');
    expect(loaded).toHaveLength(3);
    expect(loaded.map((s) => s.stepCount)).toEqual([3, 5, 2]);
  });

  it('returns empty for unknown treeId', async () => {
    expect(await store.load('nope')).toEqual([]);
  });

  it('keeps different treeIds separate', async () => {
    await store.append('a', makeSession(2));
    await store.append('b', makeSession(5));
    expect((await store.load('a'))[0]!.stepCount).toBe(2);
    expect((await store.load('b'))[0]!.stepCount).toBe(5);
  });

  it('count returns session count', async () => {
    await store.append('t', makeSession());
    await store.append('t', makeSession());
    expect(await store.count('t')).toBe(2);
  });

  it('clear removes sessions', async () => {
    await store.append('t', makeSession());
    await store.clear('t');
    expect(await store.count('t')).toBe(0);
  });

  it('listTreeIds returns all distinct tree IDs', async () => {
    await store.append('a', makeSession());
    await store.append('b', makeSession());
    await store.append('c', makeSession());
    expect((await store.listTreeIds()).sort()).toEqual(['a', 'b', 'c']);
  });

  it('persists failureReason', async () => {
    const session = makeSession(2, 'failure');
    session.failureReason = 'ECONNREFUSED';
    await store.append('t', session);
    const loaded = await store.load('t');
    expect(loaded[0]!.failureReason).toBe('ECONNREFUSED');
  });

  describe('compaction', () => {
    it('compacts and retains recent sessions', async () => {
      for (let i = 0; i < 10; i++) {
        await store.append('t', makeSession());
      }
      const { dropped, summary } = await store.compact('t', 3);
      expect(dropped).toBe(7);
      expect(summary).not.toBeNull();
      expect(await store.count('t')).toBe(3);
    });

    it('persists compaction summary', async () => {
      for (let i = 0; i < 10; i++) {
        await store.append('t', makeSession());
      }
      await store.compact('t', 3);
      const summary = await store.getCompactionSummary('t');
      expect(summary).not.toBeNull();
      expect(summary!.droppedSessions).toBe(7);
    });
  });

  describe('rotation', () => {
    it('exports to archive and clears DB', async () => {
      await store.append('t', makeSession());
      await store.append('t', makeSession());
      const archivePath = await store.rotate('t');
      expect(archivePath).not.toBeNull();
      expect(fs.existsSync(archivePath!)).toBe(true);
      expect(await store.count('t')).toBe(0);
    });
  });

  describe('auto-compact', () => {
    it('triggers when over threshold', async () => {
      const compactStore = new SqliteSessionStore(dir, {
        maxSessionsPerTree: 5,
        retainRecent: 3,
      });
      for (let i = 0; i < 8; i++) {
        await compactStore.append('t', makeSession());
      }
      const { sessions, compacted } =
        await compactStore.loadWithAutoCompact('t');
      expect(compacted).toBe(true);
      expect(sessions).toHaveLength(3);
      compactStore.close();
    });
  });
});
