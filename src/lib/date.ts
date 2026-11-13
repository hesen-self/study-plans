// 统一按北京时间（UTC+8）生成日期字符串，避免 toISOString() 在 00:00~08:00 算成前一天。
const CN_OFFSET_MS = 8 * 60 * 60 * 1000

function cnNow(): Date {
  return new Date(Date.now() + CN_OFFSET_MS)
}

export function cnToday(): string {
  return cnNow().toISOString().slice(0, 10)
}

export function cnShift(days: number): string {
  return new Date(Date.now() + CN_OFFSET_MS + days * 864e5).toISOString().slice(0, 10)
}

export function cnMonth(): string {
  return cnToday().slice(0, 7)
}

/** 'YYYY-MM' → 该月首末日期 */
export function monthRange(month: string): { from: string; to: string } {
  const [y, m] = month.split('-').map(Number)
  if (!y || !m || m < 1 || m > 12) {
    const now = cnMonth()
    return { from: `${now}-01`, to: `${now}-31` }
  }
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate()
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, '0')}` }
}

/** 本周一至今天（周一为一周起点） */
export function weekRange(): { from: string; to: string } {
  const dow = cnNow().getUTCDay()
  const diff = dow === 0 ? 6 : dow - 1
  return { from: cnShift(-diff), to: cnToday() }
}
