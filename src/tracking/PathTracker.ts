import type {
  EnhancedPathRecord,
  IEnhancedPathTracker,
  NodeId,
  NodeMetadata,
  PathRecord,
  VisitStatus,
} from '../core/interfaces.js';

export class PathTracker implements IEnhancedPathTracker {
  private path: EnhancedPathRecord[] = [];
  private sessions: EnhancedPathRecord[][] = [];
  private inSession = false;

  recordVisit(nodeId: NodeId, metadata?: NodeMetadata): void {
    const record: EnhancedPathRecord = {
      nodeId,
      timestamp: Date.now(),
      metadata: metadata ?? {},
      status: 'pending',
    };
    this.path.push(record);
  }

  recordEnhancedVisit(
    nodeId: NodeId,
    status: VisitStatus,
    metadata?: NodeMetadata & {
      duration?: number;
      toolOutput?: unknown;
      searchResults?: unknown;
      error?: string;
    },
  ): void {
    const { duration, toolOutput, searchResults, error, ...rest } =
      metadata ?? {};
    const record: EnhancedPathRecord = {
      nodeId,
      timestamp: Date.now(),
      metadata: rest,
      status,
    };
    if (duration !== undefined) record.duration = duration;
    if (toolOutput !== undefined) record.toolOutput = toolOutput;
    if (searchResults !== undefined) record.searchResults = searchResults;
    if (error !== undefined) record.error = error;
    this.path.push(record);
  }

  getPath(): PathRecord[] {
    return [...this.path];
  }

  getEnhancedPath(): EnhancedPathRecord[] {
    return [...this.path];
  }

  getVisitedNodeIds(): NodeId[] {
    return this.path.map((r) => r.nodeId);
  }

  getSuccessRate(): number {
    if (this.path.length === 0) return 0;
    const successes = this.path.filter((r) => r.status === 'success').length;
    return successes / this.path.length;
  }

  getFailedNodes(): NodeId[] {
    return this.path.filter((r) => r.status === 'failure').map((r) => r.nodeId);
  }

  getNodeVisitCount(nodeId: NodeId): number {
    return this.path.filter((r) => r.nodeId === nodeId).length;
  }

  getAveragePathLength(): number {
    const allSessions = [...this.sessions];
    if (this.path.length > 0) {
      allSessions.push(this.path);
    }
    if (allSessions.length === 0) return 0;
    const total = allSessions.reduce((sum, session) => sum + session.length, 0);
    return total / allSessions.length;
  }

  startSession(): void {
    if (this.inSession && this.path.length > 0) {
      this.sessions.push([...this.path]);
    }
    this.path = [];
    this.inSession = true;
  }

  endSession(): void {
    if (this.path.length > 0) {
      this.sessions.push([...this.path]);
    }
    this.path = [];
    this.inSession = false;
  }

  getAllSessions(): EnhancedPathRecord[][] {
    const result = [...this.sessions.map((s) => [...s])];
    if (this.path.length > 0) {
      result.push([...this.path]);
    }
    return result;
  }

  reset(): void {
    this.path = [];
    this.sessions = [];
    this.inSession = false;
  }

  get length(): number {
    return this.path.length;
  }
}
