class DownloadController {
  constructor() {
    this._paused = false;
    this._aborted = false;
  }

  pause() {
    this._paused = true;
  }

  resume() {
    this._paused = false;
  }

  abort() {
    this._aborted = true;
    this._paused = false;
  }

  get paused() {
    return this._paused;
  }

  get aborted() {
    return this._aborted;
  }

  throwIfStopped() {
    if (this._aborted) {
      const err = new Error("已取消");
      err.code = "ABORTED";
      throw err;
    }
    if (this._paused) {
      const err = new Error("已暂停");
      err.code = "PAUSED";
      throw err;
    }
  }
}

module.exports = { DownloadController };
