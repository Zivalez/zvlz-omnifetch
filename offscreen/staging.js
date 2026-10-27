/*
 * Segment staging: memory for small jobs, chunked OPFS for large jobs.
 * Writing is always in order; no media bytes enter the Downloads folder from here.
 */
let opfsRoot = null;
async function root() {
  if (opfsRoot === null) {
    try { opfsRoot = await navigator.storage.getDirectory(); } catch { opfsRoot = false; }
  }
  return opfsRoot || null;
}

export class TrackStaging {
  constructor({ memoryLimit = 96e6, name = 'track' } = {}) {
    this.memoryLimit = memoryLimit;
    this.name = name;
    this.parts = [];
    this.size = 0;
    this.handle = null;
    this.writable = null;
    this.mode = 'memory';
    this.closed = false;
  }

  async #toOpfs() {
    const dir = await root();
    if (!dir) return false;
    try {
      const fname = `md-${Date.now().toString(36)}-${this.name}-${Math.random().toString(36).slice(2, 8)}`;
      this.handle = await dir.getFileHandle(fname, { create: true });
      this.writable = await this.handle.createWritable();
      for (const p of this.parts) await this.writable.write(p);
      this.parts = [];
      this.mode = 'opfs';
      return true;
    } catch {
      this.handle = null; this.writable = null;
      return false;
    }
  }

  async append(bytes) {
    if (this.closed) throw new Error('staging_closed');
    if (this.mode === 'memory' && this.size + bytes.length > this.memoryLimit) {
      await this.#toOpfs();
    }
    if (this.mode === 'opfs' && this.writable) {
      await this.writable.write(bytes);
    } else {
      this.parts.push(bytes);
    }
    this.size += bytes.length;
  }

  async blob(type = 'application/octet-stream') {
    if (this.mode === 'opfs' && this.handle) {
      if (this.writable) { await this.writable.close(); this.writable = null; }
      const file = await this.handle.getFile();
      return new Blob([file], { type });
    }
    const b = new Blob(this.parts, { type });
    return b;
  }

  async clear() {
    this.closed = true;
    this.parts = [];
    if (this.writable) { try { await this.writable.close(); } catch { /* noop */ } this.writable = null; }
    if (this.handle) {
      try {
        const dir = await root();
        if (dir) await dir.removeEntry(this.handle.name);
      } catch { /* noop */ }
      this.handle = null;
    }
  }
}

/** Delete all leftover staging files (privacy feature: truly deletes them). */
export async function clearAllStaging() {
  const dir = await root();
  if (!dir) return { removed: 0 };
  let removed = 0;
  for await (const [name, handle] of dir.entries()) {
    if (handle.kind === 'file' && name.startsWith('md-')) {
      try { await dir.removeEntry(name); removed++; } catch { /* noop */ }
    }
  }
  return { removed };
}
