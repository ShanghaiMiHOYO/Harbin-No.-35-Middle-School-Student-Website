'use strict';

/**
 * 公网隧道守护进程
 *
 * 用 OpenSSH 自带的端口转发，把本机 8787 映射到公网：
 *   公网地址形如 https://xxxxxxxx.lhr.life
 *
 * - 断线自动重连（指数退避，最长 60 秒）
 * - 拿到新地址后写入 data/public-url.txt，页面「关于」里会显示
 * - 日志同时输出到 data/tunnel.log
 *
 * 用法：node scripts/tunnel.js
 *
 * 备注：localhost.run 只有在分配了伪终端（-tt）时才会打印分配到的域名，
 * 所以这里必须带 -tt，否则拿不到地址。
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const URL_FILE = path.join(DATA_DIR, 'public-url.txt');
const KNOWN_HOSTS = path.join(DATA_DIR, 'known_hosts');

const SSH_TARGET = 'nokey@localhost.run';
const LOCAL_TARGET = '127.0.0.1:8787';

const ANSI = /\u001b\[[0-9;]*m/g;
const URL_PATTERN = /https:\/\/[a-z0-9.-]+(?:\.lhr\.life|\.serveousercontent\.com|\.serveo\.net)/i;

let child = null;
let currentUrl = '';
let backoff = 5000;
let stopping = false;

function log(...args) {
  console.log('[' + new Date().toLocaleTimeString('zh-CN', { hour12: false }) + ']', ...args);
}

function writeUrl(next) {
  if (!next || next === currentUrl) return;
  currentUrl = next;
  backoff = 5000;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(URL_FILE, next + '\n', 'utf8');
  } catch (error) {
    log('写入 public-url.txt 失败：' + error.message);
  }
  log('公网地址：' + next);
}

function start() {
  if (stopping) return;

  const args = [
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'UserKnownHostsFile=' + KNOWN_HOSTS,
    '-o', 'ServerAliveInterval=30',
    '-o', 'ServerAliveCountMax=3',
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ConnectTimeout=20',
    '-tt',
    '-R', '80:' + LOCAL_TARGET,
    SSH_TARGET
  ];

  log('建立隧道：ssh -R 80:' + LOCAL_TARGET + ' ' + SSH_TARGET);
  child = spawn('ssh', args, { windowsHide: true });

  const handle = (chunk) => {
    const text = String(chunk).replace(ANSI, '');
    process.stdout.write(text);
    const match = URL_PATTERN.exec(text);
    if (match) writeUrl(match[0]);
  };

  child.stdout.on('data', handle);
  child.stderr.on('data', handle);

  child.on('error', (error) => {
    log('隧道进程启动失败：' + error.message);
  });

  child.on('exit', (code, signal) => {
    child = null;
    if (stopping) return;
    const wait = Math.round(backoff / 1000);
    log('隧道断开（code=' + code + ', signal=' + signal + '），' + wait + ' 秒后重连');
    setTimeout(start, backoff);
    backoff = Math.min(backoff * 2, 60000);
  });
}

function stop() {
  stopping = true;
  log('收到停止信号，关闭隧道');
  if (child) child.kill();
  setTimeout(() => process.exit(0), 300);
}

process.on('SIGINT', stop);
process.on('SIGTERM', stop);

start();
