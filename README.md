# dsh-file-download

给 **DSH（DeepSeek Harness）Web** 加一套「浏览器里管文件」的能力：浏览、下载、上传、新建文件夹、目录打包、永久删除，以及聊天产出卡片与右侧预览面板的一键下载。

DSH 的进程和文件都在宿主机上，而浏览器经常是从另一台设备远程打开的。聊天里的文件卡片、预览面板都只在宿主机上有意义——远程浏览器既打不开也拿不到。这个插件补一条同源、带登录态保护的 HTTP 通道，以及一个自带的文件管理页。

## 功能

| 入口 | 能力 |
|---|---|
| 侧边栏「文件管理」 | 两级页面：先列工作区，进入后才浏览目录；面包屑从工作区名开始，不暴露工作区以外的路径 |
| 目录页 | 上传（拖拽/选择）、新建文件夹、下载、复制链接、目录打包 zip、永久删除（二次确认） |
| 产出卡片 | 卡片右上角加下载按钮；`⋯` 菜单顶部插入「下载到本地」 |
| 右侧预览面板 | 标题栏加下载按钮，下载**当前正在预览**的文件（文本/代码/图片/PDF/Office 通用） |
| 聊天内链接 | 拦截 `/api/files.download`、`/api/files.zip`，就地下载，不换路由、不加历史记录 |

## 安装

假设 DSH 的插件目录是 `~/.dsh/plugins`，profile 是 `web`：

```bash
git clone https://github.com/<you>/dsh-file-download.git ~/.dsh/plugins/dsh-file-download
```

1. profile 依赖 `~/.dsh/profiles/web/package.json`：

```json
{ "dependencies": { "dsh-file-download": "file:$HOME/.dsh/plugins/dsh-file-download" } }
```

2. 挂载 `~/.dsh/profiles/web/cordis.patch.yml`：

```yaml
- insert:
    - id: dsh-file-download
      name: dsh-file-download
```

3. 让 `node_modules/dsh-file-download` 指向源码目录（软链即可，无需构建）：

```bash
ln -s ~/.dsh/plugins/dsh-file-download ~/.dsh/profiles/web/node_modules/dsh-file-download
```

4. 重启 DSH Web。之后**改宿主侧 `lib/` 需要重启，改 `client/client.js` 刷新页面即可**。

## 配置

```yaml
- id: dsh-file-download
  name: dsh-file-download
  config:
    roots:
      - /Users/me
      - /Volumes/Data/work
```

不配置时，可访问根目录取自 **DSH 工作区注册表**（界面上「工作区」里挂的那些目录）；注册表为空才退回进程工作目录。写了 `roots` 就以你的列表为准。

## 路由

| 路由 | 方法 | 说明 |
|---|---|---|
| `/api/files.download?path=<绝对路径>` | GET / HEAD | 流式下载，支持 `Range`、中文文件名（RFC 5987）、按扩展名给 `Content-Type` |
| `/api/files.list?path=<目录>` | GET | 目录列表 JSON，供 `/files` 页面使用 |
| `/api/files.roots` | GET | 可访问的工作区列表 `[{path,name}]` |
| `/api/files.zip?path=<目录>` | GET / HEAD | 目录打包：STORE 方式边读边写，内存只占一个 chunk，无第三方依赖 |
| `/api/files.upload?path=<目录>&name=<文件名>[&overwrite=1]` | POST | 流式写入临时文件后原子改名；同名默认 **409** |
| `/api/files.mkdir?path=<父目录>&name=<名称>` | POST | 新建文件夹；已存在 **409** |
| `/api/files.delete?path=<条目>` | POST | 永久删除（`rm -rf`），界面二次确认，拒绝删除根目录 |
| `/files` | GET | 自带文件管理页 |

`/api/*` 注册在 DSH 的 exact-Fetch 路由表上，继承浏览器 cookie 鉴权（仅 owner Peer 可用）；`/files` 通过 `ctx.connection.requestRejection` 做同样的 401/403 判定。

### 查询参数

- `path`（必填）：绝对路径，或相对进程工作目录的路径，内部走 `realpath`
- `inline=1`：`Content-Disposition: inline`，PDF/图片直接在浏览器里看
- `name=...`：覆盖下载保存的文件名

## 安全边界

1. 允许的根目录 = DSH 工作区注册表，默认不含 `$HOME`；`realpath` 之后必须落在其中，否则 **403**
2. 符号链接按真实路径判定，指向根外的一律拒绝
3. 上传/新建的名字只能是一个路径段（拒绝 `/`、`\`、`..`、空字节、超 255 字符）
4. 删除是永久删除，界面二次确认，且拒绝删除根目录本身
5. 上传先写 `<name>.part-<随机>` 再原子改名，失败不留半截文件
6. 所有路由都要求登录态，未登录 **401**
7. 文件操作全部走 `fs/promises`：某个目录在云端同步中卡住，只影响它自己的请求，不会拖死整个进程

## 客户端接入点

| 位置 | 方式 |
|---|---|
| 侧边栏入口 | 槽 `sidebar.panellist` + 主区 `main` 面板内嵌 `/files` iframe |
| 产出卡片 | 观察 `[data-presented-file]`，克隆同级按钮复用样式（不依赖 hash 类名） |
| 卡片菜单 | 卡片手势后抓 `[role="menu"]`，把「下载到本地」插到第一条 |
| 预览面板 | 槽 `sidebar.right.tab.document.actions`，入参 `{ absolutePath }` |
| 链接 | `window` 捕获阶段拦截，隐藏 `<a download>` 触发下载 |

> 卡片与菜单是**DOM 增强**（宿主没有开放对应槽）；DSH 改版时这里最可能需要跟着调。其余都是官方槽位。

## 兼容性

- 在 DSH `0.2.x`（Web）上开发并验证；用到 `slots`、`connection.requestRejection`、`workspaceRegistry`
- 无第三方依赖，`lib/zip.js` 是自己写的流式 STORE zip 写入器
- Node 侧只用 `node:fs/promises` 与 `node:path`

## 已知限制

- 不做缩略图/在线预览渲染，预览交给浏览器原生能力（`inline=1`）
- 上传是整文件单请求，没有分片/断点续传
- `Range` 每次独立，不保存断点状态

## License

MIT
