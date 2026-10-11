# m3u8-downloader

轻量本地 Web 工具，用于下载 HLS（`.m3u8`）视频。

支持多任务并行、暂停续传、历史记录；纯 Node.js 实现，无需 ffmpeg / yt-dlp。

## Features

- **多任务并行** — 一次粘贴多个地址，或连续添加任务同时下载
- **自动选清晰度** — Master Playlist 自动选取最高带宽
- **AES-128** — 常见加密分片自动解密
- **暂停 / 继续** — 保留已下分片，支持断点续传
- **历史记录** — 本地持久化，重启不丢失
- **输出 `.ts`** — VLC、IINA、PotPlayer 等可直接播放

## Requirements

- Node.js **18+**（依赖内置 `fetch`）

## Quick Start

```bash
git clone https://github.com/linliwei999/m3u8-downloader.git
cd m3u8-downloader
npm install
npm start
```

浏览器打开 [http://localhost:3456](http://localhost:3456)

```bash
# 开发模式（文件变更自动重启）
npm run dev

# 自定义端口
PORT=4000 npm start
```

## Usage

1. 打开视频页 → `F12` → **Network**，筛选 `m3u8`
2. 播放视频，复制目标 `.m3u8` 链接
3. 粘贴到本工具（多个地址换行分隔）
4. 可选填写文件名、Referer（防盗链时填原网页）
5. 点击「添加到下载」，完成后在历史记录中保存文件

### 暂停与继续

- 下载中可随时暂停，分片缓存在 `downloads/*.parts`
- 「继续」从断点接着下
- 服务异常退出后，未完成任务会标记为「已暂停」，可手动恢复

### 常见问题

| 情况 | 处理 |
|------|------|
| 403 / 无法下载 | 补全 Referer，或重新从浏览器复制带签名的链接 |
| 链接很快失效 | 多数站点有时效 token，过期后需重新抓取 |
| 提示 fMP4 / 列表为空 | 当前主要支持 MPEG-TS 分片，暂不支持 fMP4/CMAF |

## Project Structure

```
m3u8-downloader/
├── server.js           # Express 服务与 API
├── lib/
│   ├── m3u8.js         # 解析、下载、合并
│   ├── controller.js   # 暂停 / 取消
│   └── store.js        # 历史记录
├── public/             # 前端页面
├── downloads/          # 成品与临时分片（gitignore）
└── data/               # history.json（gitignore）
```

## API

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/health` | 健康检查 |
| `GET` | `/api/jobs` | 任务列表 |
| `GET` | `/api/jobs/:id` | 单个任务 |
| `POST` | `/api/download` | 创建下载 |
| `POST` | `/api/jobs/:id/pause` | 暂停 |
| `POST` | `/api/jobs/:id/resume` | 继续 |
| `GET` | `/api/files/:id` | 下载成品文件 |
| `DELETE` | `/api/jobs/:id` | 删除记录（默认同时删文件；`?file=0` 仅删记录） |

### 创建下载

```http
POST /api/download
Content-Type: application/json
```

```json
{
  "urls": "https://example.com/a.m3u8\nhttps://example.com/b.m3u8",
  "filename": "video",
  "referer": "https://example.com/"
}
```

单个地址也可使用 `"url": "https://example.com/a.m3u8"`。

## Disclaimer

请仅下载你有权保存的内容，并遵守版权法与目标站点的服务条款。本项目仅供学习与个人合法使用。

## License

MIT
