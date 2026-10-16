// 后端入口：读取环境变量并启动服务
//
//   PORT            监听端口（默认 8787）
//   HOST            监听地址（默认 0.0.0.0）
//   DATA_DIR        数据目录，存放 SQLite 数据库（默认 ./data）
//   STATIC_DIR      前端构建产物目录（默认 ./dist），存在时同时托管前端
//   ADMIN_PASSWORD  后台密码；不设置时首次启动自动生成并打印一次
//   SESSION_SECRET  玩家令牌签名密钥；不设置时自动生成并保存到数据库
//   CORS_ORIGIN     前后端分开部署时，允许访问的前端域名
//   TRUST_PROXY     部署在反向代理（Nginx 等）之后时设为 1，用于获取真实 IP
//   MAX_ROOMS       最多同时存在的房间数（默认 500）

import { join } from 'node:path';
import { createApp } from './app';
import { log } from './log';

const env = process.env;
const dataDir = env.DATA_DIR || join(process.cwd(), 'data');

const app = await createApp({
  port: Number(env.PORT) || 8787,
  host: env.HOST || '0.0.0.0',
  dbFile: join(dataDir, 'poker.db'),
  staticDir: env.STATIC_DIR || join(process.cwd(), 'dist'),
  adminPassword: env.ADMIN_PASSWORD,
  sessionSecret: env.SESSION_SECRET,
  corsOrigin: env.CORS_ORIGIN,
  trustProxy: env.TRUST_PROXY === '1',
  maxRooms: Number(env.MAX_ROOMS) || 500,
});

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  log(`收到 ${signal}，正在保存房间并关闭…`);
  await app.close();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('uncaughtException', (e) => log('未捕获的异常', e));
process.on('unhandledRejection', (e) => log('未处理的 Promise 拒绝', e));
