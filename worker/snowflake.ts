// 雪花算法（Snowflake）ID 生成器 —— 输出 64 位无符号整数的十进制字符串
//
// 结构（64 bit 无符号）：
//   1 bit 符号位（恒 0，保证无符号）
//   41 bit 时间戳（毫秒，自自定义纪元起）
//   10 bit 机器/工作节点 id（0-1023，多实例部署时用于区分）
//   12 bit 同毫秒内序列号（0-4095）
//
// 为什么用字符串：64 位无符号最大值约 1.8e19，超出 JS 安全整数（2^53-1）
// 和 SQLite INTEGER 有符号上限（约 9.2e18），必须用 BigInt 计算、以字符串
// 形式存储/传输，避免精度丢失。这也与现有 user_id TEXT 列天然兼容。

const EPOCH = 1700000000000n // 自定义纪元：2023-11-14，减少位数占用
const WORKER_ID_BITS = 10n
const SEQUENCE_BITS = 12n
const MAX_WORKER_ID = (1n << WORKER_ID_BITS) - 1n
const MAX_SEQUENCE = (1n << SEQUENCE_BITS) - 1n

let lastTimestamp = -1n
let sequence = 0n

/**
 * 生成一个雪花 ID（十进制字符串）。
 * @param workerId 工作节点 id（0-1023）。多实例部署时需为每个实例配置唯一值；
 *                 单实例默认 1 即可。
 */
export function nextSnowflakeId(workerId = 1): string {
  const wid = BigInt(workerId) & MAX_WORKER_ID
  let ts = BigInt(Date.now()) - EPOCH

  if (ts < lastTimestamp) {
    // 时钟回拨：简单处理为沿用上次时间戳（避免生成重复/回退 ID）
    ts = lastTimestamp
  }

  if (ts === lastTimestamp) {
    sequence = (sequence + 1n) & MAX_SEQUENCE
    if (sequence === 0n) {
      // 同毫秒序列号耗尽，等待下一毫秒
      ts = waitNextMillis(lastTimestamp)
    }
  } else {
    sequence = 0n
  }

  lastTimestamp = ts

  const id = (ts << (WORKER_ID_BITS + SEQUENCE_BITS)) | (wid << SEQUENCE_BITS) | sequence
  return id.toString()
}

function waitNextMillis(last: bigint): bigint {
  let ts = BigInt(Date.now()) - EPOCH
  while (ts <= last) ts = BigInt(Date.now()) - EPOCH
  return ts
}
