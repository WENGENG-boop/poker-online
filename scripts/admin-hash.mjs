// 生成后台密码的 SHA-256 哈希：npm run admin-hash -- 你的密码
// 然后在 .env.local 中设置 VITE_ADMIN_PASSWORD_HASH=<输出的哈希>
import { createHash } from 'node:crypto';

const pwd = process.argv[2];
if (!pwd) {
  console.error('用法：npm run admin-hash -- <密码>');
  process.exit(1);
}
console.log(createHash('sha256').update('poker-admin:' + pwd).digest('hex'));
