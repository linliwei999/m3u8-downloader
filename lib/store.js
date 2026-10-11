const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const { randomUUID } = require("crypto");

const MAX_HISTORY = 200;

class JobStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.jobs = new Map();
    this._writeChain = Promise.resolve();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  }

  async load() {
    try {
      const raw = await fsp.readFile(this.filePath, "utf8");
      const list = JSON.parse(raw);
      if (Array.isArray(list)) {
        for (const item of list) {
          if (item?.id) this.jobs.set(item.id, item);
        }
      }
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
  }

  async _write() {
    await fsp.mkdir(path.dirname(this.filePath), { recursive: true });
    const list = [...this.jobs.values()]
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
      .slice(0, MAX_HISTORY);
    const keep = new Set(list.map((j) => j.id));
    for (const id of this.jobs.keys()) {
      if (!keep.has(id)) this.jobs.delete(id);
    }
    const tmp = `${this.filePath}.${randomUUID()}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(list, null, 2));
    await fsp.rename(tmp, this.filePath);
  }

  save() {
    this._writeChain = this._writeChain.then(
      () => this._write(),
      () => this._write()
    );
    return this._writeChain;
  }

  get(id) {
    return this.jobs.get(id);
  }

  list() {
    return [...this.jobs.values()].sort(
      (a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)
    );
  }

  upsert(job) {
    this.jobs.set(job.id, job);
    return this.save();
  }

  async remove(id) {
    this.jobs.delete(id);
    await this.save();
  }
}

module.exports = { JobStore };
