import { beforeEach, describe, expect, it } from 'vitest';
import { PathTracker } from '../tracking/PathTracker.js';

describe('PathTracker', () => {
  let tracker: PathTracker;

  beforeEach(() => {
    tracker = new PathTracker();
  });

  // --- Basic visit recording ---

  describe('recordVisit / getPath / getVisitedNodeIds', () => {
    it('records visits and returns them in order', () => {
      tracker.recordVisit('n1');
      tracker.recordVisit('n2');
      tracker.recordVisit('n3');

      const path = tracker.getPath();
      expect(path).toHaveLength(3);
      expect(path[0]?.nodeId).toBe('n1');
      expect(path[1]?.nodeId).toBe('n2');
      expect(path[2]?.nodeId).toBe('n3');
    });

    it('getVisitedNodeIds returns node ids in order', () => {
      tracker.recordVisit('a');
      tracker.recordVisit('b');
      expect(tracker.getVisitedNodeIds()).toEqual(['a', 'b']);
    });

    it('records visits with metadata', () => {
      tracker.recordVisit('n1', { key: 'value' });
      const path = tracker.getPath();
      expect(path[0]?.metadata).toEqual({ key: 'value' });
    });

    it('records visit with default pending status', () => {
      tracker.recordVisit('n1');
      const enhanced = tracker.getEnhancedPath();
      expect(enhanced[0]?.status).toBe('pending');
    });

    it('each visit has a timestamp', () => {
      tracker.recordVisit('n1');
      const path = tracker.getPath();
      expect(typeof path[0]?.timestamp).toBe('number');
      expect(path[0]?.timestamp).toBeGreaterThan(0);
    });
  });

  // --- Reset ---

  describe('reset', () => {
    it('clears all data', () => {
      tracker.recordVisit('n1');
      tracker.recordVisit('n2');
      tracker.startSession();
      tracker.recordVisit('n3');
      tracker.endSession();

      tracker.reset();

      expect(tracker.getPath()).toEqual([]);
      expect(tracker.getVisitedNodeIds()).toEqual([]);
      expect(tracker.getAllSessions()).toEqual([]);
    });
  });

  // --- Enhanced visits ---

  describe('recordEnhancedVisit', () => {
    it('records visit with status', () => {
      tracker.recordEnhancedVisit('n1', 'success');
      const path = tracker.getEnhancedPath();
      expect(path[0]?.status).toBe('success');
    });

    it('records visit with all optional fields', () => {
      tracker.recordEnhancedVisit('n1', 'failure', {
        duration: 150,
        toolOutput: { result: 'data' },
        searchResults: ['r1'],
        error: 'timeout',
        extra: 'info',
      });

      const record = tracker.getEnhancedPath()[0]!;
      expect(record.status).toBe('failure');
      expect(record.duration).toBe(150);
      expect(record.toolOutput).toEqual({ result: 'data' });
      expect(record.searchResults).toEqual(['r1']);
      expect(record.error).toBe('timeout');
      expect(record.metadata).toEqual({ extra: 'info' });
    });

    it('records visit without optional metadata', () => {
      tracker.recordEnhancedVisit('n1', 'skipped');
      const record = tracker.getEnhancedPath()[0]!;
      expect(record.status).toBe('skipped');
      expect(record.metadata).toEqual({});
    });
  });

  // --- Success rate ---

  describe('getSuccessRate', () => {
    it('returns 0 when no visits', () => {
      expect(tracker.getSuccessRate()).toBe(0);
    });

    it('calculates success rate correctly', () => {
      tracker.recordEnhancedVisit('n1', 'success');
      tracker.recordEnhancedVisit('n2', 'failure');
      tracker.recordEnhancedVisit('n3', 'success');
      tracker.recordEnhancedVisit('n4', 'pending');

      expect(tracker.getSuccessRate()).toBe(0.5); // 2 out of 4
    });

    it('returns 1 when all visits are successful', () => {
      tracker.recordEnhancedVisit('n1', 'success');
      tracker.recordEnhancedVisit('n2', 'success');
      expect(tracker.getSuccessRate()).toBe(1);
    });
  });

  // --- Failed nodes ---

  describe('getFailedNodes', () => {
    it('returns empty array when no failures', () => {
      tracker.recordEnhancedVisit('n1', 'success');
      expect(tracker.getFailedNodes()).toEqual([]);
    });

    it('returns only failed node ids', () => {
      tracker.recordEnhancedVisit('n1', 'success');
      tracker.recordEnhancedVisit('n2', 'failure');
      tracker.recordEnhancedVisit('n3', 'failure');
      tracker.recordEnhancedVisit('n4', 'pending');

      expect(tracker.getFailedNodes()).toEqual(['n2', 'n3']);
    });
  });

  // --- Visit count ---

  describe('getNodeVisitCount', () => {
    it('returns 0 for unvisited node', () => {
      expect(tracker.getNodeVisitCount('x')).toBe(0);
    });

    it('counts visits to the same node', () => {
      tracker.recordVisit('n1');
      tracker.recordVisit('n2');
      tracker.recordVisit('n1');
      tracker.recordVisit('n1');

      expect(tracker.getNodeVisitCount('n1')).toBe(3);
      expect(tracker.getNodeVisitCount('n2')).toBe(1);
    });
  });

  // --- Session management ---

  describe('startSession / endSession', () => {
    it('endSession saves the current path and clears it', () => {
      tracker.startSession();
      tracker.recordVisit('a');
      tracker.recordVisit('b');
      tracker.endSession();

      expect(tracker.getPath()).toEqual([]);
      const sessions = tracker.getAllSessions();
      expect(sessions).toHaveLength(1);
      expect(sessions[0]?.map((r) => r.nodeId)).toEqual(['a', 'b']);
    });

    it('startSession saves a previous active session', () => {
      tracker.startSession();
      tracker.recordVisit('a');

      // Starting a new session should archive the first one
      tracker.startSession();
      tracker.recordVisit('b');
      tracker.endSession();

      const sessions = tracker.getAllSessions();
      expect(sessions).toHaveLength(2);
      expect(sessions[0]?.map((r) => r.nodeId)).toEqual(['a']);
      expect(sessions[1]?.map((r) => r.nodeId)).toEqual(['b']);
    });

    it('getAllSessions includes current active path if non-empty', () => {
      tracker.recordVisit('x');
      const sessions = tracker.getAllSessions();
      expect(sessions).toHaveLength(1);
      expect(sessions[0]?.map((r) => r.nodeId)).toEqual(['x']);
    });

    it('getAllSessions returns separate copies', () => {
      tracker.startSession();
      tracker.recordVisit('a');
      tracker.endSession();

      const sessions = tracker.getAllSessions();
      sessions[0]?.push({
        nodeId: 'injected',
        timestamp: 0,
        metadata: {},
        status: 'pending',
      });

      // Original should be unaffected
      const sessionsAgain = tracker.getAllSessions();
      expect(sessionsAgain[0]).toHaveLength(1);
    });
  });

  // --- Average path length ---

  describe('getAveragePathLength', () => {
    it('returns 0 when no data', () => {
      expect(tracker.getAveragePathLength()).toBe(0);
    });

    it('calculates average across sessions', () => {
      tracker.startSession();
      tracker.recordVisit('a');
      tracker.recordVisit('b');
      tracker.endSession(); // session of length 2

      tracker.startSession();
      tracker.recordVisit('c');
      tracker.recordVisit('d');
      tracker.recordVisit('e');
      tracker.recordVisit('f');
      tracker.endSession(); // session of length 4

      // (2 + 4) / 2 = 3
      expect(tracker.getAveragePathLength()).toBe(3);
    });

    it('includes current active path in average', () => {
      tracker.startSession();
      tracker.recordVisit('a');
      tracker.recordVisit('b');
      tracker.endSession(); // length 2

      tracker.recordVisit('c'); // active path of length 1

      // (2 + 1) / 2 = 1.5
      expect(tracker.getAveragePathLength()).toBe(1.5);
    });
  });

  // --- length property ---

  describe('length', () => {
    it('reflects current path length', () => {
      expect(tracker.length).toBe(0);
      tracker.recordVisit('a');
      expect(tracker.length).toBe(1);
      tracker.recordVisit('b');
      expect(tracker.length).toBe(2);
    });
  });
});
