import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SessionStore } from '../persistence/SessionStore.js';
import { PersistentPathTracker } from '../persistence/PersistentPathTracker.js';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dp-test-'));
}


describe('PersistentPathTracker', () => {
  let dir: string;
  let store: SessionStore;

  beforeEach(() => {
    dir = tempDir();
    store = new SessionStore(dir);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('initializes with no prior sessions when file does not exist', async () => {
    const tracker = new PersistentPathTracker(store, 'fresh');
    await tracker.initialize();
    expect(tracker.getPriorSessionCount()).toBe(0);
    expect(tracker.getAllSessions()).toEqual([]);
  });

  it('persists a session when endSession is called', async () => {
    const tracker = new PersistentPathTracker(store, 'tree-1');
    await tracker.initialize();

    tracker.startSession();
    tracker.recordEnhancedVisit('a', 'success');
    tracker.recordEnhancedVisit('b', 'success');
    tracker.endSession();

    await tracker.lastPersistPromise;

    const persisted = await store.load('tree-1');
    expect(persisted).toHaveLength(1);
    expect(persisted[0]!.records.map((r) => r.nodeId)).toEqual(['a', 'b']);
    expect(persisted[0]!.stepCount).toBe(2);
    expect(persisted[0]!.finalStatus).toBe('success');
  });

  it('loads prior sessions on initialization', async () => {
    // First tracker: record one session
    const t1 = new PersistentPathTracker(store, 'shared');
    await t1.initialize();
    t1.startSession();
    t1.recordEnhancedVisit('x', 'success');
    t1.recordEnhancedVisit('y', 'success');
    t1.endSession();
    await t1.lastPersistPromise;

    // Second tracker: should see the prior session
    const t2 = new PersistentPathTracker(store, 'shared');
    await t2.initialize();
    expect(t2.getPriorSessionCount()).toBe(1);
    expect(t2.getAllSessions()).toHaveLength(1);
    expect(t2.getAllSessions()[0]!.map((r) => r.nodeId)).toEqual(['x', 'y']);
  });

  it('accumulates across multiple process restarts', async () => {
    for (let i = 0; i < 3; i++) {
      const t = new PersistentPathTracker(store, 'accum');
      await t.initialize();
      t.startSession();
      t.recordEnhancedVisit(`node-${i}`, 'success');
      t.endSession();
      await t.lastPersistPromise;
    }

    const final = new PersistentPathTracker(store, 'accum');
    await final.initialize();
    expect(final.getAllSessions()).toHaveLength(3);
  });

  it('initialize is idempotent', async () => {
    const tracker = new PersistentPathTracker(store, 'idem');
    await tracker.initialize();
    await tracker.initialize();
    await tracker.initialize();
    expect(tracker.getAllSessions()).toEqual([]);
  });

  it('records failure status correctly', async () => {
    const tracker = new PersistentPathTracker(store, 'fail');
    await tracker.initialize();
    tracker.startSession();
    tracker.recordEnhancedVisit('a', 'success');
    tracker.recordEnhancedVisit('b', 'failure');
    tracker.endSession();
    await tracker.lastPersistPromise;

    const persisted = await store.load('fail');
    expect(persisted[0]!.finalStatus).toBe('failure');
  });
});
