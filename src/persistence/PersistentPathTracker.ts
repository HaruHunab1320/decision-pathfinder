import { PathTracker } from '../tracking/PathTracker.js';
import type { SessionStore, PersistedSession, FinalStatus } from './SessionStore.js';
import type { EnhancedPathRecord } from '../core/interfaces.js';

/**
 * A PathTracker that persists completed sessions to disk and replays prior
 * sessions on initialization.
 *
 * Usage:
 *   const tracker = new PersistentPathTracker(store, 'deploy-gcp');
 *   await tracker.initialize();
 *   // tracker now has all prior sessions for 'deploy-gcp' loaded in-memory
 *   // any endSession() call will also append to the .jsonl file on disk
 */
export class PersistentPathTracker extends PathTracker {
  private store: SessionStore;
  private treeId: string;
  private initialized = false;

  constructor(store: SessionStore, treeId: string) {
    super();
    this.store = store;
    this.treeId = treeId;
  }

  /**
   * Load prior sessions from disk into the in-memory tracker state.
   * Safe to call multiple times — subsequent calls are no-ops.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;
    const prior = await this.store.load(this.treeId);
    for (const s of prior) {
      if (s.records.length > 0) {
        this.sessions.push([...s.records]);
      }
    }
    this.initialized = true;
  }

  getPriorSessionCount(): number {
    return this.sessions.length;
  }

  /**
   * Promise that resolves after the most recent endSession()'s append completes.
   * Tests can await this; production code can ignore it (fire-and-forget is fine).
   */
  public lastPersistPromise: Promise<void> = Promise.resolve();

  override endSession(): void {
    // Capture the just-ended path BEFORE super resets it
    const justEnded = [...this.path];
    super.endSession();

    if (justEnded.length > 0) {
      const finalStatus = this.deriveFinalStatus(justEnded);
      const persistedSession: PersistedSession = {
        timestamp: new Date().toISOString(),
        records: justEnded,
        finalStatus,
        stepCount: justEnded.length,
      };

      this.lastPersistPromise = this.store
        .append(this.treeId, persistedSession)
        .catch((err) => {
          console.error(
            `[PersistentPathTracker] Failed to persist session for "${this.treeId}":`,
            err,
          );
        });
    }
  }

  private deriveFinalStatus(records: EnhancedPathRecord[]): FinalStatus {
    if (records.length === 0) return 'pending';
    const last = records[records.length - 1]!;
    return last.status;
  }
}
