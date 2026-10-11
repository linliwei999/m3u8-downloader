const crypto = require("crypto");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");

function resolveUrl(base, relative) {
  try {
    return new URL(relative, base).href;
  } catch {
    return relative;
  }
}

function parseAttributes(line) {
  const attrs = {};
  const re = /([A-Z0-9-]+)=("(?:[^"]*)"|[^,]*)/gi;
  let match;
  while ((match = re.exec(line))) {
    let value = match[2];
    if (value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }
    attrs[match[1].toUpperCase()] = value;
  }
  return attrs;
}

function parsePlaylist(text, baseUrl) {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const isMaster = lines.some((l) => l.startsWith("#EXT-X-STREAM-INF"));
  if (isMaster) {
    const variants = [];
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith("#EXT-X-STREAM-INF")) {
        const attrs = parseAttributes(lines[i]);
        const uri = lines[i + 1];
        if (!uri || uri.startsWith("#")) continue;
        variants.push({
          bandwidth: Number(attrs.BANDWIDTH || 0),
          resolution: attrs.RESOLUTION || "",
          url: resolveUrl(baseUrl, uri),
        });
      }
    }
    variants.sort((a, b) => b.bandwidth - a.bandwidth);
    return { type: "master", variants };
  }

  let mediaSequence = 0;
  let encrypt = null;
  const segments = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("#EXT-X-MEDIA-SEQUENCE:")) {
      mediaSequence = Number(line.split(":")[1]) || 0;
    } else if (line.startsWith("#EXT-X-KEY:")) {
      const attrs = parseAttributes(line);
      if ((attrs.METHOD || "NONE").toUpperCase() === "NONE") {
        encrypt = null;
      } else {
        encrypt = {
          method: (attrs.METHOD || "").toUpperCase(),
          keyUrl: attrs.URI ? resolveUrl(baseUrl, attrs.URI) : null,
          ivHex: attrs.IV || null,
        };
      }
    } else if (line.startsWith("#EXTINF:")) {
      const uri = lines[i + 1];
      if (!uri || uri.startsWith("#")) continue;
      const seq = mediaSequence + segments.length;
      let iv = null;
      if (encrypt?.ivHex) {
        iv = Buffer.from(encrypt.ivHex.replace(/^0x/i, ""), "hex");
      } else if (encrypt) {
        iv = Buffer.alloc(16);
        iv.writeUInt32BE(seq, 12);
      }
      segments.push({
        url: resolveUrl(baseUrl, uri),
        encrypt: encrypt
          ? {
              method: encrypt.method,
              keyUrl: encrypt.keyUrl,
              iv: iv ? iv.toString("hex") : null,
            }
          : null,
      });
      i += 1;
    }
  }

  return { type: "media", segments };
}

async function fetchText(url, headers) {
  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new Error(`请求失败 ${res.status}: ${url}`);
  }
  return res.text();
}

async function fetchBuffer(url, headers) {
  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new Error(`请求失败 ${res.status}: ${url}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

async function resolveMediaPlaylist(url, headers) {
  const text = await fetchText(url, headers);
  const parsed = parsePlaylist(text, url);
  if (parsed.type === "media") {
    return { playlistUrl: url, segments: parsed.segments, variants: null };
  }
  if (!parsed.variants.length) {
    throw new Error("未找到可用的清晰度列表");
  }
  const best = parsed.variants[0];
  const mediaText = await fetchText(best.url, headers);
  const media = parsePlaylist(mediaText, best.url);
  if (media.type !== "media" || !media.segments.length) {
    throw new Error(
      "媒体播放列表为空（可能是 fMP4/CMAF 流，当前仅支持常见的 TS 分片 m3u8）"
    );
  }
  return {
    playlistUrl: best.url,
    segments: media.segments,
    variants: parsed.variants,
    selected: best,
  };
}

function decryptSegment(buf, key, ivHex, method) {
  if (!method || method === "NONE") return buf;
  if (method !== "AES-128") {
    throw new Error(`暂不支持加密方式: ${method}`);
  }
  const iv = Buffer.from(ivHex, "hex");
  const decipher = crypto.createDecipheriv("aes-128-cbc", key, iv);
  return Buffer.concat([decipher.update(buf), decipher.final()]);
}

function buildHeaders(referer) {
  const headers = {
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    Accept: "*/*",
  };
  if (referer) {
    headers.Referer = referer;
    try {
      headers.Origin = new URL(referer).origin;
    } catch {
      /* ignore */
    }
  }
  return headers;
}

function partPath(tmpDir, index) {
  return path.join(tmpDir, `${String(index).padStart(6, "0")}.ts`);
}

async function countExistingParts(tmpDir, total) {
  let done = 0;
  const missing = [];
  for (let i = 0; i < total; i++) {
    try {
      const st = await fsp.stat(partPath(tmpDir, i));
      if (st.size > 0) done += 1;
      else missing.push(i);
    } catch {
      missing.push(i);
    }
  }
  return { done, missing };
}

async function mergeParts(outPath, tmpDir, total) {
  await fsp.rm(outPath, { force: true });
  const writeStream = fs.createWriteStream(outPath);
  for (let i = 0; i < total; i++) {
    const chunk = await fsp.readFile(partPath(tmpDir, i));
    const ok = writeStream.write(chunk);
    if (!ok) {
      await new Promise((resolve) => writeStream.once("drain", resolve));
    }
  }
  await new Promise((resolve, reject) => {
    writeStream.end((err) => (err ? reject(err) : resolve()));
  });
}

async function downloadM3u8(options) {
  const {
    url,
    outPath,
    referer = "",
    onProgress = () => {},
    concurrency = 6,
    controller = null,
    resume = false,
  } = options;

  const headers = buildHeaders(referer);
  const tmpDir = `${outPath}.parts`;
  const metaPath = path.join(tmpDir, "meta.json");

  let segments;
  let selected = null;
  let variants = null;

  if (resume) {
    const raw = await fsp.readFile(metaPath, "utf8");
    const meta = JSON.parse(raw);
    segments = meta.segments;
    selected = meta.selected;
    variants = meta.variants;
  } else {
    onProgress({ phase: "解析播放列表", percent: 0, done: 0, total: 0 });
    const resolved = await resolveMediaPlaylist(url, headers);
    segments = resolved.segments;
    selected = resolved.selected || null;
    variants = resolved.variants;
    if (!segments.length) throw new Error("没有可下载的分片");

    await fsp.mkdir(path.dirname(outPath), { recursive: true });
    await fsp.rm(tmpDir, { recursive: true, force: true });
    await fsp.mkdir(tmpDir, { recursive: true });
    await fsp.writeFile(
      metaPath,
      JSON.stringify({ url, referer, segments, selected, variants }, null, 2)
    );
  }

  const total = segments.length;
  let { done, missing } = await countExistingParts(tmpDir, total);

  onProgress({
    phase: "下载分片",
    percent: Math.round((done / total) * 95),
    done,
    total,
    selected,
    variants,
  });

  if (missing.length === 0) {
    // already complete parts — merge
  } else {
    const queue = missing.slice();
    const keyCache = new Map();

    async function getKey(keyUrl) {
      if (!keyUrl) return null;
      if (keyCache.has(keyUrl)) return keyCache.get(keyUrl);
      const key = await fetchBuffer(keyUrl, headers);
      keyCache.set(keyUrl, key);
      return key;
    }

    async function worker() {
      while (queue.length) {
        if (controller) controller.throwIfStopped();
        const index = queue.shift();
        if (index === undefined) return;
        const seg = segments[index];
        let buf = await fetchBuffer(seg.url, headers);
        if (controller) controller.throwIfStopped();
        if (seg.encrypt) {
          const key = await getKey(seg.encrypt.keyUrl);
          buf = decryptSegment(
            buf,
            key,
            seg.encrypt.iv,
            seg.encrypt.method
          );
        }
        await fsp.writeFile(partPath(tmpDir, index), buf);
        done += 1;
        onProgress({
          phase: "下载分片",
          percent: Math.round((done / total) * 95),
          done,
          total,
          selected,
          variants,
        });
      }
    }

    const workers = Array.from(
      { length: Math.min(concurrency, queue.length) },
      () => worker()
    );

    const results = await Promise.allSettled(workers);
    const paused = results.some(
      (r) => r.status === "rejected" && r.reason?.code === "PAUSED"
    );
    const aborted = results.some(
      (r) => r.status === "rejected" && r.reason?.code === "ABORTED"
    );
    const other = results.find(
      (r) =>
        r.status === "rejected" &&
        r.reason?.code !== "PAUSED" &&
        r.reason?.code !== "ABORTED"
    );

    if (other) throw other.reason;
    if (aborted) {
      const err = new Error("已取消");
      err.code = "ABORTED";
      throw err;
    }
    if (paused || (controller && controller.paused)) {
      const counted = await countExistingParts(tmpDir, total);
      onProgress({
        phase: "已暂停",
        percent: Math.round((counted.done / total) * 95),
        done: counted.done,
        total,
        selected,
        variants,
      });
      const err = new Error("已暂停");
      err.code = "PAUSED";
      throw err;
    }
  }

  if (controller) controller.throwIfStopped();

  onProgress({
    phase: "合并文件",
    percent: 96,
    done: total,
    total,
    selected,
    variants,
  });

  await mergeParts(outPath, tmpDir, total);
  await fsp.rm(tmpDir, { recursive: true, force: true });

  const stat = await fsp.stat(outPath);
  onProgress({
    phase: "完成",
    percent: 100,
    done: total,
    total,
    selected,
    variants,
    size: stat.size,
  });

  return { outPath, size: stat.size, selected, variants, segments: total };
}

module.exports = { downloadM3u8, parsePlaylist, resolveUrl };
