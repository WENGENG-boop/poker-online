// 邀请码：前端模拟模式与后端共用

// 去掉容易混淆的字符（0/O、1/I/L）
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function generateInviteCode(exists: (code: string) => boolean, length = 6): string {
  for (;;) {
    let code = '';
    for (let i = 0; i < length; i++) code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
    if (!exists(code)) return code;
  }
}

export function normalizeCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, '');
}
