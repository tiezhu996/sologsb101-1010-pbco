/**
 * 补录测点编号重编。
 *
 * 规则：外业补录测点沿用其与装置 / 建筑物的引用关系（id 另行映射），但业务编号在并回时
 * 必须避让主档案已占用的编号。保留外业原编号的前缀（如 JD-OIL-），仅把尾部序号顺延，
 * 使同一装置的新旧测点编号连续、可读。
 */

/** 拆出编号尾部序号：JD-OIL-07 → { prefix: 'JD-OIL-', seq: 7, width: 2 }，无尾部数字返回 null */
export function splitCodeTail(code: string): { prefix: string; seq: number; width: number } | null {
  const match = /^(.*?)(\d+)\s*$/.exec(code.trim())
  if (!match) return null
  return { prefix: match[1], seq: Number(match[2]), width: match[2].length }
}

/**
 * 为一个补录测点分配主档案上不冲突的新编号。
 *
 * @param wantedCode 外业原编号
 * @param occupied   主档案当前已占用编号（含本批次先前已分配的编号）
 * @param fallbackPrefix 原编号解析不出尾部序号时使用的前缀
 */
export function renumberPointCode(wantedCode: string, occupied: Set<string>, fallbackPrefix = 'JD-'): string {
  const parts = splitCodeTail(wantedCode)
  const prefix = parts ? parts.prefix : wantedCode && wantedCode.length > 0 ? wantedCode : fallbackPrefix
  let seq = parts ? parts.seq : 1
  // 宽度保持原编号位数（01 / 02 不被压成 1 / 2），解析不出序号时默认两位
  const width = parts ? parts.width : 2
  let candidate = `${prefix}${String(seq).padStart(width, '0')}`
  while (occupied.has(candidate)) {
    seq += 1
    candidate = `${prefix}${String(seq).padStart(width, '0')}`
  }
  occupied.add(candidate)
  return candidate
}
