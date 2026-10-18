# 部署到固定公网地址

现在的访问方式是「本机 → 隧道 → 公网」，电脑一关就断。要固定地址、关机也能访问，
必须把站点放到一台 7×24 在线的服务器上。这个目录里的东西就是为这件事准备的。

## 你最终会得到

- 固定地址：`http://服务器IP:8787`（有域名的话可以再上 HTTPS）
- systemd 托管：开机自启、进程崩溃自动拉起
- 数据存在服务器磁盘：`/opt/student-site/data`
- 每天凌晨 3 点自动备份到 `/opt/student-site/backups`
- 管理密码沿用现在的，不用重新设置

---

## 方案 A：Oracle Cloud 永久免费（0 元，推荐）

### 1. 注册

打开 <https://www.oracle.com/cloud/free/>，点 Start for free。

- 需要：邮箱、手机号、一张信用卡或借记卡（只做身份验证，扣约 $1 后返还）
- **Home Region 只能选一次，之后不能改**。国内访问建议选：
  日本大阪（ap-osaka-1）、韩国首尔（ap-seoul-1）、新加坡（ap-singapore-1）
- 国内发行的卡有时验证不过，Visa / Mastercard 成功率高；失败就换个时间段或换张卡重试

### 2. 开一台机器

控制台 → Compute → Instances → Create instance：

| 项 | 选什么 |
|---|---|
| Image | Canonical Ubuntu 22.04（或 24.04） |
| Shape | `VM.Standard.A1.Flex`（ARM，4 OCPU / 24GB，在免费额度内）；提示没容量就换 `VM.Standard.E2.1.Micro`（AMD，1GB，永远有） |
| Boot volume | 默认 50GB 就够（免费额度 200GB） |
| SSH keys | 选 **Generate a key pair for me**，把私钥下载保存好；或粘贴你自己的公钥 |

创建完记下 **Public IP address**。

### 3. 放行端口（两层，缺一不可）

**云上安全列表**：VCN → Security Lists → Default Security List → Add Ingress Rules

- Source CIDR：`0.0.0.0/0`
- IP Protocol：`TCP`
- Destination Port Range：`8787`

**机器内防火墙**：`install.sh` 会自动处理（Oracle 的 Ubuntu 镜像默认 iptables 里有 REJECT 规则）。

### 4. 部署

把 **公网 IP** 和 **SSH 私钥文件** 发我，我来传包、安装、验证，然后把地址给你。
不方便给私钥的话，就自己跑下面三条命令（在本机 PowerShell 里）：

```powershell
scp -i 私钥文件 .\dist\student-site.tar.gz ubuntu@服务器IP:/tmp/
ssh -i 私钥文件 ubuntu@服务器IP "mkdir -p /tmp/pkg && tar -xzf /tmp/student-site.tar.gz -C /tmp/pkg && sudo bash /tmp/pkg/student-site/deploy/install.sh /tmp/student-site.tar.gz"
```

> Oracle 的 Ubuntu 镜像默认用户是 `ubuntu`，可以 sudo；如果你用的是 root 登录就把 `ubuntu@` 换掉。

装完浏览器打开 `http://服务器IP:8787`。

---

## 方案 B：国内轻量服务器（约 ¥10–40/月）

腾讯云 / 阿里云「轻量应用服务器」，选 Ubuntu 22.04、2 核 2G 就够。

- 香港 / 新加坡节点：免备案，直接 IP 访问
- 内地节点：不绑域名、只用 `IP:8787` 不需要备案；一旦要绑域名走 80/443 就必须备案

买好后同样把 IP + root 密码（或密钥）给我，走同一套 `install.sh`。

## 方案 C：任何有 Docker 的机器

```bash
docker compose up -d
```

`docker-compose.yml` 已经把 `./data` 挂进去了，重启容器数据不丢。

---

## 部署脚本做了什么

`install.sh`：

1. `apt` 装 curl / xz-utils / iptables
2. 从 npmmirror 装 Node 22（国内快，自动识别 x86_64 / arm64）
3. 解压到 `/opt/student-site`，建系统用户 `student`
4. 写 `/etc/systemd/system/student-site.service`，`enable --now`
5. 放行 8787（ufw + iptables，并持久化）
6. 打印访问地址

`backup.sh`：打包 `data/` 到 `backups/data-YYYY-MM-DD.tar.gz`，保留 14 天。
加到 cron：

```bash
( crontab -l 2>/dev/null; echo "0 3 * * * /opt/student-site/deploy/backup.sh >/dev/null 2>&1" ) | crontab -
```

## 域名 + 备案 + HTTPS（第二阶段）

服务器先用 IP 跑起来，域名和备案可以并行办。

> **备案主体是个坑，先确认再买域名。**
> 个人备案不能备案「单位/学校」性质的网站：网站名称里出现学校全称、内容以学校名义发布，
> 管局大概率驳回。以学校名义上线，需要学校作为主体备案（事业单位法人证书、负责人证件），
> 一般由信息老师或校办代办。个人只能在内容、名称都属个人的前提下备案。
> 如果学校不方便出主体，就别买域名，直接用 `http://服务器IP:8787`。

### 买域名

腾讯云/阿里云注册 `.top` / `.xyz`，首年 20–35 元，需要实名认证。
解析加一条 A 记录指向服务器公网 IP。

### 备案（学校主体）

腾讯云备案小程序提交：主体证件（事业单位法人证书等）、负责人身份证与手机号、
网站信息（名称、服务内容）、核验拍照。管局审核一般 7–20 天，免费。
备案期间网站用 `http://IP:8787` 正常跑。

### 切 HTTPS

备案通过、域名解析生效后，在服务器执行：

```bash
bash /opt/student-site/deploy/install-https.sh 你的域名 你的邮箱
```

脚本会装 nginx + certbot，反向代理到本机 8787，自动申请并续期证书，
并把 8787 收回成只监听本机（公网只能走 80/443）。

## 常见问题

**Oracle 注册被拒**：换一张卡、换个邮箱、隔几小时再试；也可以用国内轻量服务器先顶上。

**A1 提示 out of capacity**：换可用域（Availability Domain），或直接用 E2.1.Micro。

**浏览器打不开 IP:8787**：
1. 安全列表加了吗？
2. 机器内 `sudo iptables -L INPUT -n | head` 看有没有 8787 的 ACCEPT
3. `sudo systemctl status student-site` 看服务是否在跑

**想换端口**：改 `/etc/systemd/system/student-site.service` 里的 `PORT=`，再 `systemctl daemon-reload && systemctl restart student-site`，云上安全列表同步改。

**数据搬迁**：现在的作品是 0 个、帖子 0 个，只有 `data/config.json`（密码摘要）需要带，安装包里已经包含。
以后要迁移，整包拷 `data/` 目录即可。
