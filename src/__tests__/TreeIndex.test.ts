import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TreeIndex } from '../persistence/TreeIndex.js';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dp-idx-test-'));
}

describe('TreeIndex', () => {
  let dir: string;

  beforeEach(() => {
    dir = tempDir();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('starts empty when no index file exists', () => {
    const idx = new TreeIndex(dir);
    expect(idx.getAll()).toEqual([]);
  });

  it('upserts and persists entries', async () => {
    const idx = new TreeIndex(dir);
    await idx.upsert({
      treeId: 'deploy-web',
      family: 'deployment',
      tags: ['deploy', 'web'],
      taskName: 'Deploy Web App',
      sessionCount: 5,
      lastUsed: '2026-01-01T00:00:00.000Z',
    });

    const entry = idx.get('deploy-web');
    expect(entry).toBeDefined();
    expect(entry!.family).toBe('deployment');
    expect(entry!.tags).toEqual(['deploy', 'web']);
    expect(entry!.sessionCount).toBe(5);

    // Verify persistence — new instance reads from disk
    const idx2 = new TreeIndex(dir);
    expect(idx2.get('deploy-web')).toBeDefined();
    expect(idx2.get('deploy-web')!.family).toBe('deployment');
  });

  it('merges on upsert — undefined fields keep existing values', async () => {
    const idx = new TreeIndex(dir);
    await idx.upsert({
      treeId: 'test-tree',
      family: 'testing',
      tags: ['test'],
      description: 'original desc',
      sessionCount: 3,
      lastUsed: '2026-01-01T00:00:00.000Z',
    });

    // Upsert with only sessionCount — family/tags/description should survive
    await idx.upsert({
      treeId: 'test-tree',
      sessionCount: 10,
      lastUsed: '2026-02-01T00:00:00.000Z',
    });

    const entry = idx.get('test-tree')!;
    expect(entry.family).toBe('testing');
    expect(entry.tags).toEqual(['test']);
    expect(entry.description).toBe('original desc');
    expect(entry.sessionCount).toBe(10);
  });

  it('removes entries', async () => {
    const idx = new TreeIndex(dir);
    await idx.upsert({ treeId: 'a', tags: [], sessionCount: 0, lastUsed: '' });
    await idx.upsert({ treeId: 'b', tags: [], sessionCount: 0, lastUsed: '' });
    expect(idx.getAll()).toHaveLength(2);

    await idx.remove('a');
    expect(idx.getAll()).toHaveLength(1);
    expect(idx.get('a')).toBeUndefined();
  });

  describe('family queries', () => {
    it('getFamily returns entries in the same family', async () => {
      const idx = new TreeIndex(dir);
      await idx.upsert({
        treeId: 'deploy-web',
        family: 'deployment',
        tags: [],
        sessionCount: 5,
        lastUsed: '',
      });
      await idx.upsert({
        treeId: 'deploy-api',
        family: 'deployment',
        tags: [],
        sessionCount: 3,
        lastUsed: '',
      });
      await idx.upsert({
        treeId: 'fix-bug',
        family: 'bugfix',
        tags: [],
        sessionCount: 1,
        lastUsed: '',
      });

      const family = idx.getFamily('deployment');
      expect(family).toHaveLength(2);
      expect(family.map((e) => e.treeId).sort()).toEqual([
        'deploy-api',
        'deploy-web',
      ]);
    });

    it('getFamilySiblings excludes self', async () => {
      const idx = new TreeIndex(dir);
      await idx.upsert({
        treeId: 'deploy-web',
        family: 'deployment',
        tags: [],
        sessionCount: 0,
        lastUsed: '',
      });
      await idx.upsert({
        treeId: 'deploy-api',
        family: 'deployment',
        tags: [],
        sessionCount: 0,
        lastUsed: '',
      });

      const siblings = idx.getFamilySiblings('deploy-web');
      expect(siblings).toEqual(['deploy-api']);
    });

    it('getFamilySiblings returns empty for trees with no family', async () => {
      const idx = new TreeIndex(dir);
      await idx.upsert({
        treeId: 'lone-tree',
        tags: [],
        sessionCount: 0,
        lastUsed: '',
      });
      expect(idx.getFamilySiblings('lone-tree')).toEqual([]);
    });
  });

  describe('search', () => {
    async function populatedIndex(): Promise<TreeIndex> {
      const idx = new TreeIndex(dir);
      await idx.upsert({
        treeId: 'deploy-web-app',
        family: 'deployment',
        tags: ['deploy', 'web', 'docker'],
        taskName: 'Deploy Web App',
        description: 'Deploy the web frontend to production using Docker',
        sessionCount: 50,
        lastUsed: '',
      });
      await idx.upsert({
        treeId: 'deploy-api-app',
        family: 'deployment',
        tags: ['deploy', 'api', 'docker'],
        taskName: 'Deploy API App',
        description: 'Deploy the API backend to production',
        sessionCount: 30,
        lastUsed: '',
      });
      await idx.upsert({
        treeId: 'fix-auth-bug',
        family: 'bugfix',
        tags: ['auth', 'bug', 'security'],
        taskName: 'Fix Auth Bug',
        description: 'Fix authentication bypass in login flow',
        sessionCount: 5,
        lastUsed: '',
      });
      return idx;
    }

    it('ranks by tag match highest', async () => {
      const idx = await populatedIndex();
      const results = idx.search('deploy docker');
      expect(results.length).toBeGreaterThan(0);
      // Both deploy trees should rank above the bugfix
      expect(results[0]!.treeId).toMatch(/^deploy-/);
      expect(results[1]!.treeId).toMatch(/^deploy-/);
    });

    it('uses sessionCount as tiebreak', async () => {
      const idx = await populatedIndex();
      const results = idx.search('deploy');
      // deploy-web-app has 50 sessions, deploy-api-app has 30
      // Both should match on the "deploy" tag and name — web should rank first
      const deployResults = results.filter((r) => r.treeId.startsWith('deploy-'));
      expect(deployResults[0]!.treeId).toBe('deploy-web-app');
    });

    it('returns empty for no matches', async () => {
      const idx = await populatedIndex();
      const results = idx.search('zzz-nonexistent-xyz');
      expect(results).toEqual([]);
    });

    it('respects limit', async () => {
      const idx = await populatedIndex();
      const results = idx.search('deploy', 1);
      expect(results).toHaveLength(1);
    });

    it('includes match reasons', async () => {
      const idx = await populatedIndex();
      const results = idx.search('auth security');
      expect(results.length).toBeGreaterThan(0);
      const authResult = results.find((r) => r.treeId === 'fix-auth-bug');
      expect(authResult).toBeDefined();
      expect(authResult!.matchReasons.length).toBeGreaterThan(0);
    });
  });

  describe('recordSession', () => {
    it('increments session count', async () => {
      const idx = new TreeIndex(dir);
      await idx.upsert({
        treeId: 'test',
        tags: [],
        sessionCount: 0,
        lastUsed: '',
      });

      await idx.recordSession('test');
      expect(idx.get('test')!.sessionCount).toBe(1);

      await idx.recordSession('test');
      expect(idx.get('test')!.sessionCount).toBe(2);
    });
  });

  describe('rebuild', () => {
    it('rebuilds from session JSONL files', async () => {
      // Write fake JSONL files
      fs.writeFileSync(path.join(dir, 'tree-a.jsonl'), '{"a":1}\n{"a":2}\n');
      fs.writeFileSync(path.join(dir, 'tree-b.jsonl'), '{"b":1}\n');

      const idx = new TreeIndex(dir);
      await idx.rebuild(dir);

      expect(idx.get('tree-a')).toBeDefined();
      expect(idx.get('tree-a')!.sessionCount).toBe(2);
      expect(idx.get('tree-b')!.sessionCount).toBe(1);
    });
  });
});
