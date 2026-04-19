import * as fs from 'node:fs';

/**
 * Simple advisory file lock using exclusive file creation.
 *
 * Uses `fs.writeFileSync(path, pid, { flag: 'wx' })` which atomically
 * creates the file and fails if it already exists. This is safe for
 * single-machine concurrency (multiple MCP server processes).
 *
 * Not suitable for NFS or other networked filesystems.
 */
export class FileLock {
  private lockPath: string;
  private acquired = false;

  constructor(targetPath: string) {
    this.lockPath = `${targetPath}.lock`;
  }

  /**
   * Try to acquire the lock. Retries with exponential backoff.
   * Throws after maxRetries if the lock cannot be acquired.
   */
  async acquire(maxRetries = 10, baseDelayMs = 50): Promise<void> {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        fs.writeFileSync(this.lockPath, `${process.pid}`, { flag: 'wx' });
        this.acquired = true;
        return;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== 'EEXIST') throw err;

        // Check if the holding process is still alive (stale lock detection)
        if (this.isStale()) {
          this.forceRelease();
          continue; // retry immediately
        }

        if (attempt === maxRetries) {
          throw new Error(
            `Failed to acquire lock on "${this.lockPath}" after ${maxRetries} retries`,
          );
        }

        const delay = baseDelayMs * Math.pow(2, attempt) * (0.5 + Math.random());
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  /** Release the lock. Safe to call even if not acquired. */
  release(): void {
    if (this.acquired) {
      try {
        fs.unlinkSync(this.lockPath);
      } catch {
        // Lock file may have been cleaned up externally
      }
      this.acquired = false;
    }
  }

  /** Check if an existing lock file is stale (holding process no longer running). */
  private isStale(): boolean {
    try {
      const content = fs.readFileSync(this.lockPath, 'utf-8');
      const pid = parseInt(content, 10);
      if (isNaN(pid)) return true;
      // Check if process is alive — kill(pid, 0) throws if not
      process.kill(pid, 0);
      return false; // process is alive
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ESRCH') return true; // no such process — stale
      if (code === 'ENOENT') return true; // lock file gone
      return false; // EPERM means process exists but we can't signal it
    }
  }

  /** Force-remove a lock file regardless of who holds it. */
  private forceRelease(): void {
    try {
      fs.unlinkSync(this.lockPath);
    } catch {
      // ignore
    }
  }
}

/**
 * Execute a function while holding a file lock.
 * The lock is always released, even if the function throws.
 */
export async function withLock<T>(
  targetPath: string,
  fn: () => Promise<T>,
): Promise<T> {
  const lock = new FileLock(targetPath);
  await lock.acquire();
  try {
    return await fn();
  } finally {
    lock.release();
  }
}
