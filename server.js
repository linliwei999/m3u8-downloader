const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const fsp = require("fs/promises");
const { randomUUID } = require("crypto");
const { downloadM3u8 } = require("./lib/m3u8");
const { DownloadController } = require("./lib/controller");
const { JobStore } = require("./lib/store");

const app = express();
const PORT = process.env.PORT || 3456;
const DOWNLOAD_DIR = path.join(__dirname, "downloads");
const DATA_DIR = path.join(__dirname, "data");
const store = new JobStore(path.join(DATA_DIR, "history.json"));

/** @type {Map<string, { controller: import('./lib/controller').DownloadController, running: boolean }>} */
const runtime = new Map();

fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
fs.mkdirSync(DATA_DIR, { recursive: true });

app.use(cors());
app.use(express.json({ limit: "64kb" }));
app.use(express.static(path.join(__dirname, "public")));

function sanitizeName(name) {
  const base = (name || "video")
    .replace(/[^\w\u4e00-\u9fa5.-]+/g, "_")
    .slice(0, 80);
  return base || "video";
}

function publicJob(job) {
  const fileReady = job.status === "done" && job.outPath;
  return {
    id: job.id,
    url: job.url,
    referer: job.referer || "",
    filename: job.filename,
    status: job.status,
    progress: job.progress,
    error: job.error,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    size: job.size || job.progress?.size || null,
    downloadUrl: fileReady ? `/api/files/${job.id}` : null,
  };
}

async function persist(job) {
  job.updatedAt = Date.now();
  await store.upsert(job);
}

async function startDownload(job, { resume = false } = {}) {
  let rt = runtime.get(job.id);
  if (!rt) {
    rt = { controller: new DownloadController(), running: false };
    runtime.set(job.id, rt);
  }
  if (rt.running) return;

  rt.controller = new DownloadController();
  rt.running = true;
  job.status = "running";
  job.error = null;
  job.progress = {
    ...(job.progress || {}),
    phase: resume ? "继续下载" : "排队中",
    percent: job.progress?.percent || 0,
  };
  await persist(job);

  downloadM3u8({
    url: job.url,
    outPath: job.outPath,
    referer: job.referer || "",
    resume,
    controller: rt.controller,
    onProgress: (progress) => {
      job.progress = progress;
      if (progress.size) job.size = progress.size;
      job.updatedAt = Date.now();
      const now = Date.now();
      if (!job._lastPersist || now - job._lastPersist > 800) {
        job._lastPersist = now;
        store.upsert(job).catch(() => {});
      }
    },
  })
    .then(async (result) => {
      job.status = "done";
      job.size = result.size;
      job.progress = {
        ...(job.progress || {}),
        phase: "完成",
        percent: 100,
        size: result.size,
      };
      job.error = null;
      await persist(job);
    })
    .catch(async (err) => {
      if (err?.code === "PAUSED") {
        job.status = "paused";
        job.error = null;
        job.progress = {
          ...(job.progress || {}),
          phase: "已暂停",
        };
        await persist(job);
        return;
      }
      if (err?.code === "ABORTED") {
        job.status = "error";
        job.error = "已取消";
        await persist(job);
        return;
      }
      job.status = "error";
      job.error = err.message || String(err);
      job.progress = {
        ...(job.progress || {}),
        phase: "失败",
      };
      await persist(job);
      // keep parts for possible manual retry on pause-like failures; wipe on hard fail
      if (!resume) {
        /* keep parts if any partial for retry via resume of error? skip */
      }
    })
    .finally(() => {
      const current = runtime.get(job.id);
      if (current) current.running = false;
    });
}

function parseUrls(input) {
  if (Array.isArray(input)) {
    return input.map((u) => String(u).trim()).filter(Boolean);
  }
  if (typeof input !== "string") return [];
  return input
    .split(/[\n\r]+/)
    .map((u) => u.trim())
    .filter(Boolean);
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/api/jobs", (_req, res) => {
  res.json({ jobs: store.list().map(publicJob) });
});

app.get("/api/jobs/:id", (req, res) => {
  const job = store.get(req.params.id);
  if (!job) return res.status(404).json({ error: "任务不存在" });
  res.json(publicJob(job));
});

app.get("/api/files/:id", async (req, res) => {
  const job = store.get(req.params.id);
  if (!job?.outPath) return res.status(404).json({ error: "文件不存在" });
  try {
    await fsp.access(job.outPath);
  } catch {
    return res.status(404).json({ error: "文件已丢失" });
  }
  res.download(job.outPath, job.filename);
});

app.post("/api/download", async (req, res) => {
  const { filename, referer } = req.body || {};
  const urls = parseUrls(req.body?.urls ?? req.body?.url);
  if (!urls.length) {
    return res.status(400).json({ error: "请提供至少一个 m3u8 地址" });
  }

  const created = [];
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    try {
      new URL(url);
    } catch {
      return res.status(400).json({ error: `URL 格式不正确: ${url}` });
    }

    const id = randomUUID();
    const baseName = sanitizeName(filename);
    const name =
      urls.length > 1 && baseName
        ? `${baseName}-${i + 1}`
        : baseName || `video-${i + 1}`;
    const outName = `${name}.ts`;
    const outPath = path.join(DOWNLOAD_DIR, `${id}-${outName}`);
    const now = Date.now();

    const job = {
      id,
      url,
      referer: typeof referer === "string" ? referer : "",
      filename: outName,
      outPath,
      status: "running",
      progress: { phase: "排队中", percent: 0, done: 0, total: 0 },
      error: null,
      size: null,
      createdAt: now,
      updatedAt: now,
    };
    await store.upsert(job);
    created.push(publicJob(job));
    startDownload(job, { resume: false });
  }

  res.json({ jobs: created });
});

app.post("/api/jobs/:id/pause", async (req, res) => {
  const job = store.get(req.params.id);
  if (!job) return res.status(404).json({ error: "任务不存在" });
  if (job.status !== "running") {
    return res.status(400).json({ error: "仅运行中的任务可暂停" });
  }
  const rt = runtime.get(job.id);
  if (!rt?.running) {
    return res.status(400).json({ error: "任务未在运行" });
  }
  rt.controller.pause();
  job.progress = { ...(job.progress || {}), phase: "暂停中…" };
  await persist(job);
  res.json(publicJob(job));
});

app.post("/api/jobs/:id/resume", async (req, res) => {
  const job = store.get(req.params.id);
  if (!job) return res.status(404).json({ error: "任务不存在" });
  if (job.status !== "paused" && job.status !== "error") {
    return res.status(400).json({ error: "仅暂停或失败的任务可继续" });
  }
  const partsDir = `${job.outPath}.parts`;
  let canResume = false;
  try {
    await fsp.access(path.join(partsDir, "meta.json"));
    canResume = true;
  } catch {
    canResume = false;
  }
  startDownload(job, { resume: canResume });
  res.json(publicJob(job));
});

app.delete("/api/jobs/:id", async (req, res) => {
  const job = store.get(req.params.id);
  if (!job) return res.status(404).json({ error: "任务不存在" });

  const rt = runtime.get(job.id);
  if (rt?.running) {
    rt.controller.abort();
  }

  const removeFile = req.query.file !== "0";
  if (removeFile) {
    if (job.outPath) await fsp.rm(job.outPath, { force: true });
    if (job.outPath) {
      await fsp.rm(`${job.outPath}.parts`, { recursive: true, force: true });
    }
  }

  runtime.delete(job.id);
  await store.remove(job.id);
  res.json({ ok: true });
});

async function boot() {
  await store.load();
  // mark previously running jobs as paused so user can resume
  for (const job of store.list()) {
    if (job.status === "running") {
      job.status = "paused";
      job.progress = {
        ...(job.progress || {}),
        phase: "已暂停",
      };
      await persist(job);
    }
  }

  app.listen(PORT, () => {
    console.log(`m3u8 下载工具已启动: http://localhost:${PORT}`);
  });
}

boot().catch((err) => {
  console.error(err);
  process.exit(1);
});
