# 三十五中学生网 · 局域网版

零依赖 Node 服务（不需要 npm install），本机存数据，同一局域网内的设备都能访问。
包含作品库（上传 + 审核）和校园论坛。

## 访问地址（当前：局域网模式）

| 场景 | 地址 |
|---|---|
| 本机 | http://127.0.0.1:8787 |
| 同局域网（手机、同学电脑） | http://192.168.1.9:8787 |

局域网地址以网站「关于」页或启动日志里的为准——IP 由路由器 DHCP 分配，重启后可能变。
手机要连**同一个 Wi-Fi / 路由器**才能打开；学校网络如果开了终端隔离（AP isolation），设备之间可能互访不了。

开机自启：启动项里的 `三十五中学生网.lnk` 只拉起服务，不启动公网隧道。桌面快捷方式指向本机地址。

管理员密码：见交付说明。修改后要重启服务才生效。

### 想临时开公网访问

```bat
wscript scripts\start-hidden.vbs      :: 只起服务
scripts\run-tunnel.cmd                :: 需要时再起隧道
```

隧道会申请一个随机域名 `https://xxxxxxxx.lhr.life`，写入 `data/public-url.txt`。
免费隧道每次重连都会换域名，旧地址直接失效，所以只适合临时演示。

## 功能

### 作品库

- 上传是独立页面（导航「上传作品」），不再挤在首页
- 上传图片 / 视频，文件落 `data/files/`，元数据进 `data/items.json`
- 审核通过才在「视频库」公开；待审核内容只有管理员能看
- 支持视频拖动进度条（HTTP Range）
- 上限：图片 20MB、视频 500MB、总量 20GB

### 论坛

- 四个板块：校园生活 / 学习交流 / 社团活动 / 意见建议
- 不用注册，填昵称即可发帖、回复；帖子按「置顶 → 最后回复时间」排序
- 发帖可带 **最多 3 张配图**（单张 ≤ 8MB），存在 `data/forum-files/`
- 标题 1–60 字，不强制长标题
- 管理员可把帖子设为**热点**，首页「今日热点」展示热点帖和已通过作品
- 列表显示标题、板块、作者、回复数、浏览数、最后回复时间
- 帖子可分享：地址是 `#forum/<帖子id>`，刷新 / 直接打开都能定位
- 管理员可以置顶、设热点、删帖、删回复
- 限速：每个浏览器每小时 5 帖、30 条回复、30 张图

### 界面

- 首页：横幅、校园掠影、今日热点
- 免责声明放在「关于我们」页
- 图片放在 `public/img/`，要换成学校自己拍的，直接覆盖同名文件即可

## 目录

```
server.js                 服务端：页面 + API + 文件读写
public/index.html         页面
public/app.js             前端（全部走 /api）
public/img/               校门、升旗仪式照片
public/logo.png           校徽（圆形透明 PNG），页头直接用它
data/config.json          管理员密码摘要（scrypt + 随机盐）
data/items.json           作品元数据
data/forum.json           论坛帖子与回复
data/forum-files/<uuid>   帖子配图
data/files/<uuid>         作品原始文件
data/public-url.txt       当前公网地址（隧道写入）
data/server.log           服务日志
data/tunnel.log           隧道日志
scripts/run-server.cmd    启动服务
scripts/run-tunnel.cmd    启动隧道守护
scripts/tunnel.js         隧道守护逻辑
scripts/start-hidden.vbs  隐藏窗口启动服务和隧道（开机自启用）
```

## 常用操作

```bat
:: 前台看服务日志
node server.js

:: 后台启动（服务 + 隧道）
wscript scripts\start-hidden.vbs

:: 只重启隧道（地址会变）
Get-Process ssh | Stop-Process -Force
```

停止全部：

```powershell
Get-NetTCPConnection -LocalPort 8787 -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
Get-Process ssh -ErrorAction SilentlyContinue | Stop-Process -Force
```

看日志：

```powershell
Get-Content .\data\server.log -Encoding UTF8 -Tail 40 -Wait
Get-Content .\data\tunnel.log -Encoding UTF8 -Tail 20
```

## 接口

### 作品

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/items?status=passed` | 已通过作品（公开） |
| GET | `/api/items?status=pending` | 待审核（需管理员） |
| POST | `/api/items?name=&author=` | 上传：body 为文件原始字节 |
| POST | `/api/items/:id/approve` | 放行（管理员） |
| POST | `/api/items/:id/reject` | 拒绝并删除（管理员） |
| DELETE | `/api/items/:id` | 删除（管理员） |
| POST | `/api/library/clear` | 清空已通过作品（管理员） |
| GET | `/files/:id` | 读文件，支持 Range |

### 论坛

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/forum?category=&page=` | 帖子列表（分页，每页 15） |
| POST | `/api/forum` | 发帖：`{title, content, author, category, images:[id]}` |
| POST | `/api/forum/images` | 上传帖子配图：body 为图片字节，返回 `{id, url}` |
| GET | `/forum-images/:id` | 读取帖子配图 |
| GET | `/api/forum/:id` | 帖子详情 + 回复 + 配图，浏览数 +1 |
| DELETE | `/api/forum/:id` | 删帖（管理员，连带删除配图） |
| POST | `/api/forum/:id/replies` | 回复：`{content, author}` |
| DELETE | `/api/forum/:id/replies/:postId` | 删回复（管理员） |
| POST | `/api/forum/:id/pin` | 置顶 / 取消置顶（管理员） |
| POST | `/api/forum/:id/hot` | 设为 / 取消热点（管理员） |

### 其他

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/session` | 当前是否管理员 |
| POST | `/api/login` | `{"password":"..."}`，成功下发 HttpOnly Cookie |
| POST | `/api/logout` | 退出 |
| GET | `/api/stats` | 数量与占用；`pending`、`bytes` 仅管理员可见 |
| GET | `/api/hot` | 首页今日热点：热点帖 + 已通过作品 |
| GET | `/api/network` | 当前局域网地址 |
| GET | `/api/public-url` | 当前公网地址 |
| GET | `/api/health` | 存活检查 |

## 公网暴露后的安全设置

- 管理员密码是 16 位随机串，服务端只存 scrypt 摘要；登录失败同一来源 5 分钟内 8 次会被限速。
- 上传按**客户端 ID** 限速（每个浏览器 10 分钟 20 个），另有全局 300 个 / 10 分钟兜底。
  走 `X-Client-Id` 而不是 IP，是因为隧道把所有请求来源都变成 127.0.0.1。
- 论坛发帖 / 回复也按客户端 ID 限速（5 帖 / 30 回复 每小时）。
- 只接受 JPG/PNG/WebP/GIF/AVIF 与 MP4/WebM/MOV，并核对文件头；不支持 SVG。
- 待审核文件只有管理员能读；帖子内容一律 `textContent` 渲染，不会被注入脚本。
- 页面带 CSP、`X-Frame-Options: DENY`、`Referrer-Policy: no-referrer` 等响应头。

## 图片来源

- `public/logo.png`：学校校徽，白底抠成圆形透明 PNG，页头 104px 圆框直接用。
- `public/img/school-gate.jpg`：校门照片，来自百度百科「哈尔滨市第三十五中学校」词条的公开照片。
- `public/img/school-march.jpg`：升旗仪式，来自学校公众号「哈尔滨市第三十五中学」配图。

都是学校自己的影像素材，用于校内展示；要换直接覆盖同名文件即可。页头没有 `logo.png` 时会退回「35」占位。

## 已知限制（重要）

1. **域名不固定**：localhost.run 免费模式每次重连换一个随机域名。要固定地址，需要自己的域名
   托管到 Cloudflare 走命名隧道，或者一台 VPS。
2. **第三方可见流量**：TLS 在 localhost.run 侧终止，理论上它能看见明文请求（含管理员密码）。
   校内用可接受，别放敏感信息。
3. **无 SLA**：免费隧道可能限速、断线、被回收；本机必须开机联网。
4. 论坛是匿名发言，只有管理员能删。公开前最好在免责声明里补一条论坛发言规范。

## 备份

备份 `data\` 整个目录（`config.json` + `items.json` + `forum.json` + `files\`）即可，要一起备。
