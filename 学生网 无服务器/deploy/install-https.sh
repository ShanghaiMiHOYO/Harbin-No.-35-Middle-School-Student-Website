#!/usr/bin/env bash
# 备案通过后，把站点切成 https://你的域名
#
# 用法（服务器上 root 执行）：
#   bash install-https.sh xsw35.top you@example.com
#
# 做的事：
#   1. 装 nginx + certbot（Ubuntu 官方源，国内镜像快）
#   2. 反向代理到 127.0.0.1:8787，放行 520MB 上传
#   3. 申请 Let's Encrypt 证书并自动续期
#   4. 把应用改成只监听本机，公网只能走 80/443

set -euo pipefail

DOMAIN="${1:-}"
EMAIL="${2:-}"

if [ -z "$DOMAIN" ]; then
  echo "用法：bash install-https.sh 你的域名 [邮箱]"
  echo "例如：bash install-https.sh xsw35.top admin@example.com"
  exit 1
fi

if [ "$(id -u)" -ne 0 ]; then
  echo "请用 root 运行"
  exit 1
fi

echo "==> 安装 nginx 和 certbot"
apt-get update -y
apt-get install -y nginx certbot python3-certbot-nginx

echo "==> 写 nginx 配置"
cat > /etc/nginx/sites-available/student-site <<NGINX
server {
    listen 80;
    listen [::]:80;
    server_name ${DOMAIN};

    # 视频最大 500MB，这里留点余量
    client_max_body_size 520m;

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;

        # 大文件上传别被 60 秒掐断
        proxy_connect_timeout 60s;
        proxy_send_timeout 600s;
        proxy_read_timeout 600s;
        proxy_request_buffering off;
    }
}
NGINX

ln -sf /etc/nginx/sites-available/student-site /etc/nginx/sites-enabled/student-site
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx

echo "==> 让应用只监听本机"
sed -i 's/^Environment=HOST=.*/Environment=HOST=127.0.0.1/' /etc/systemd/system/student-site.service
systemctl daemon-reload
systemctl restart student-site

echo "==> 放行 80 / 443"
if command -v ufw >/dev/null 2>&1; then
  ufw allow 80/tcp || true
  ufw allow 443/tcp || true
fi
iptables -I INPUT -p tcp --dport 80 -j ACCEPT || true
iptables -I INPUT -p tcp --dport 443 -j ACCEPT || true
if command -v netfilter-persistent >/dev/null 2>&1; then
  netfilter-persistent save || true
fi

echo "==> 申请证书"
CERT_ARGS="--nginx -d ${DOMAIN} --non-interactive --agree-tos --redirect"
if [ -n "$EMAIL" ]; then
  CERT_ARGS="$CERT_ARGS -m ${EMAIL}"
else
  CERT_ARGS="$CERT_ARGS --register-unsafely-without-email"
fi
certbot $CERT_ARGS

echo
echo "完成：https://${DOMAIN}"
echo "证书续期：systemctl list-timers | grep certbot"
echo "以后 8787 只对本机开放，公网入口统一走 80/443"
