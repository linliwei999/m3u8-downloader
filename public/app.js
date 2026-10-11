const form = document.getElementById("form");
const formError = document.getElementById("formError");
const activeList = document.getElementById("activeList");
const historyList = document.getElementById("historyList");
const activeEmpty = document.getElementById("activeEmpty");
const historyEmpty = document.getElementById("historyEmpty");
const activeCount = document.getElementById("activeCount");
const historyCount = document.getElementById("historyCount");

const ACTIVE = new Set(["running", "paused"]);

function formatBytes(n) {
  if (!n) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function formatTime(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function statusLabel(status) {
  return (
    {
      running: "下载中",
      paused: "已暂停",
      done: "已完成",
      error: "失败",
    }[status] || status
  );
}

function progressText(job) {
  const p = job.progress || {};
  const bits = [];
  if (p.total) bits.push(`${p.done || 0}/${p.total}`);
  if (p.selected?.resolution) bits.push(p.selected.resolution);
  const size = job.size || p.size;
  if (size) bits.push(formatBytes(size));
  if (job.error) bits.push(job.error);
  return bits.join(" · ");
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function jobCard(job) {
  const p = job.progress || {};
  const percent = Number(p.percent || 0);
  const phase = p.phase || statusLabel(job.status);
  const actions = [];

  if (job.status === "running") {
    actions.push(
      `<button type="button" class="btn ghost" data-action="pause" data-id="${job.id}">暂停</button>`
    );
  }
  if (job.status === "paused" || job.status === "error") {
    actions.push(
      `<button type="button" class="btn ghost" data-action="resume" data-id="${job.id}">继续</button>`
    );
  }
  if (job.downloadUrl) {
    actions.push(
      `<a class="btn solid" href="${job.downloadUrl}" download="${escapeHtml(job.filename)}">保存</a>`
    );
  }
  actions.push(
    `<button type="button" class="btn danger" data-action="delete" data-id="${job.id}">删除</button>`
  );

  return `
    <article class="job" data-id="${job.id}">
      <div class="job-top">
        <div>
          <p class="job-name">${escapeHtml(job.filename)}</p>
          <p class="job-url" title="${escapeHtml(job.url)}">${escapeHtml(job.url)}</p>
        </div>
        <div class="job-meta">
          <span class="badge ${job.status}">${statusLabel(job.status)}</span>
          <span class="pct">${percent}%</span>
        </div>
      </div>
      <div class="bar"><div class="bar-fill" style="width:${percent}%"></div></div>
      <div class="job-bottom">
        <p class="detail">${escapeHtml(phase)}${progressText(job) ? " · " + escapeHtml(progressText(job)) : ""}</p>
        <p class="time">${formatTime(job.updatedAt || job.createdAt)}</p>
      </div>
      <div class="job-actions">${actions.join("")}</div>
    </article>
  `;
}

function render(jobs) {
  const active = jobs.filter((j) => ACTIVE.has(j.status));
  const history = jobs.filter((j) => !ACTIVE.has(j.status));

  activeCount.textContent = String(active.length);
  historyCount.textContent = String(history.length);

  activeList.innerHTML = active.map(jobCard).join("");
  historyList.innerHTML = history.map(jobCard).join("");

  activeEmpty.hidden = active.length > 0;
  historyEmpty.hidden = history.length > 0;
}

async function fetchJobs() {
  const res = await fetch("/api/jobs");
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "加载失败");
  render(data.jobs || []);
  return data.jobs || [];
}

async function onAction(action, id) {
  if (action === "pause") {
    await fetch(`/api/jobs/${id}/pause`, { method: "POST" });
  } else if (action === "resume") {
    await fetch(`/api/jobs/${id}/resume`, { method: "POST" });
  } else if (action === "delete") {
    if (!confirm("删除该记录及已下载文件？")) return;
    await fetch(`/api/jobs/${id}`, { method: "DELETE" });
  }
  await fetchJobs();
}

document.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-action]");
  if (!btn) return;
  onAction(btn.dataset.action, btn.dataset.id).catch((err) => {
    alert(err.message || "操作失败");
  });
});

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  formError.hidden = true;
  const urls = document.getElementById("urls").value.trim();
  if (!urls) return;

  try {
    const res = await fetch("/api/download", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        urls,
        filename: document.getElementById("filename").value.trim(),
        referer: document.getElementById("referer").value.trim(),
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "创建失败");
    document.getElementById("urls").value = "";
    await fetchJobs();
  } catch (err) {
    formError.hidden = false;
    formError.textContent = err.message || "请求失败";
  }
});

fetchJobs().catch((err) => {
  formError.hidden = false;
  formError.textContent = err.message || "加载失败";
});

setInterval(() => {
  fetchJobs().catch(() => {});
}, 1000);
