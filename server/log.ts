// 简单的带时间戳日志
export function log(...args: unknown[]) {
  console.log(new Date().toISOString(), ...args);
}
