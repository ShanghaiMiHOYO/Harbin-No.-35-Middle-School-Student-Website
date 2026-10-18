#!/usr/bin/env bash
# 三十五中学生网 · 一键部署（Ubuntu 22.04 / 24.04，x86_64 或 arm64）
#
# 用法（在服务器上用 root 执行）：
#   bash install.sh /tmp/student-site.tar.gz
#
# 做的事：
#   1. 装 Node 22（走 npmmirror，国内快）
#   2. 解压到 /opt/student-site
#   3. 注册 systemd 服务，开机自启、崩溃自动拉起
#   4. 放行 8787 端口（ufw + Oracle 镜像的 iptables）

set -euo pipefail

TARBALL="${1:-/tmp/student-site.tar.gz}"
APP_DIR=/opt/student-site
SERVICE=student-site
NODE_VERSION=v22.11.0

if [ "$(id -u)" -ne 0 ]; then
  echo "请用 root 运行：sudo bash install.sh $TARBALL"
  exit 1
fi

if [ ! -f "$TARBALL" ]; then
  echo "找不到安装包：$TARBALL"
  exit 1
fi

echo "==> 安装依赖"
apt-get update -y
apt-get install -y curl ca-certificates xz-utils iptables

echo "==> 安装 Node $NODE_VERSION"
if ! command -v node >/dev/null 2>&1; then
  ARCH=$(uname -m)
  case "$ARCH" in
    aarch64|arm64) NODE_ARCH=arm64 ;;
    x86_64|amd64)  NODE_ARCH=x64 ;;
    *) echo "不支持的架构：$ARCH"; exit 1 ;;
  esac
  curl -fsSL "https://npmmirror.com/mirrors/node/${NODE_VERSION}/node-${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz" -o /tmp/node.tar.xz
  tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1
  rm -f /tmp/node.tar.xz
fi
node -v

echo "==> 解压到 $APP_DIR"
id -u student >/dev/null 2>&1 || useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin student
mkdir -p "$APP_DIR"
tar -xzf "$TARBALL" -C "$APP_DIR" --strip-components=1
chown -R student:student "$APP_DIR"

echo "==> 注册 systemd 服务"
cat > "/etc/systemd/system/${SERVICE}.service" <<'UNIT'
[Unit]
Description=Student Site (三十五中学生网)
After=network.target

[Service]
Type=simple
User=student
WorkingDirectory=/opt/student-site
Environment=NODE_ENV=production
Environment=PORT=8787
Environment=HOST=0.0.0.0
ExecStart=/usr/local/bin/node /opt/student-site/server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable "$SERVICE"
systemctl restart "$SERVICE"

echo "==> 放行 8787 端口"
if command -v ufw >/dev/null 2>&1; then
  ufw allow 8787/tcp || true
fi
# Oracle 的 Ubuntu 镜像自带 REJECT 规则，必须手动插到前面
iptables -I INPUT -p tcp --dport 8787 -j ACCEPT || true
if command -v netfilter-persistent >/dev/null 2>&1; then
  netfilter-persistent save || true
fi

sleep 1
if systemctl is-active --quiet "$SERVICE"; then
  IP=$(curl -s --max-time 5 https://api.ipify.org || echo "服务器IP")
  echo
  echo "部署完成：http://${IP}:8787"
  echo "服务状态：systemctl status ${SERVICE}"
  echo "日志查看：journalctl -u ${SERVICE} -f"
else
  echo "服务没起来，看看日志：journalctl -u ${SERVICE} -n 50 --no-pager"
  exit 1
fi
