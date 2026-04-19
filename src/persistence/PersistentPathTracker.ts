import type { EnhancedPathRecord } from '../core/interfaces.js';
import { PathTracker } from '../tracking/PathTracker.js';
import type {
  FinalStatus,
  ISessionStore,
  PersistedSession,
} from './SessionStore.js';

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
  private store: ISessionStore;
  private treeId: string;
  private initialized = false;

  constructor(store: ISessionStore, treeId: string) {
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
      const failureReason = this.extractFailureReason(justEnded, finalStatus);
      const persistedSession: PersistedSession = {
        timestamp: new Date().toISOString(),
        records: justEnded,
        finalStatus,
        stepCount: justEnded.length,
      };
      if (failureReason !== undefined) {
        persistedSession.failureReason = failureReason;
      }

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

  /**
   * Extract a human-readable failure reason from a session's records.
   * Looks for the last record with an error field, or the terminal failure node.
   */
  private extractFailureReason(
    records: EnhancedPathRecord[],
    finalStatus: FinalStatus,
  ): string | undefined {
    if (finalStatus !== 'failure' && finalStatus !== 'error') return undefined;
    // Walk backwards to find the most specific error
    for (let i = records.length - 1; i >= 0; i--) {
      const record = records[i]!;
      if (record.error) return record.error;
    }
    return undefined;
  }
}
