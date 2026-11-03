// bridge/fuse.mjs — 融合层：RRF（Reciprocal Rank Fusion）+ 候选准入/排序。
//
// 为什么单独一层：recall.mjs 里 searchIndex() 之后、assemble() 之前只有「准入 + 排序」这一收口，
// 融合必须落在它前面，否则语义命中会因为 topic>0 门槛被直接丢掉。
//
// 关键约束：**没有向量输入时，排序键必须和改造前逐字节一致**
// （channel desc → topic desc → updated_at desc → path asc），这样 eval 的「仅 FTS5」列才是基线。

export const DEFAULT_RRF_K = 60;
export const DEFAULT_MAX_DISTANCE = 0.35;

/**
 * Reciprocal Rank Fusion：score = Σ 1/(k + rank)，rank 从 1 开始。
 * 同一列表内重复 id 只按第一次出现计分；空列表/空 id 直接跳过。
 */
export function rrf(lists, k = DEFAULT_RRF_K) {
  const scores = new Map();
  const safeK = Number.isFinite(Number(k)) && Number(k) >= 0 ? Number(k) : DEFAULT_RRF_K;
  for (const list of lists || []) {
    if (!Array.isArray(list)) continue;
    const seen = new Set();
    let rank = 0;
    for (const raw of list) {
      if (raw === null || raw === undefined) continue;
      const id = String(raw);
      if (seen.has(id)) continue;
      seen.add(id);
      rank += 1;
      scores.set(id, (scores.get(id) || 0) + 1 / (safeK + rank));
    }
  }
  return scores;
}

const byUpdated = (a, b) => String(b.row.updated_at || '').localeCompare(String(a.row.updated_at || ''));
const byPath = (a, b) => (a.row.path < b.row.path ? -1 : 1);

/** 改造前的排序键（channel → topic → updated_at → path），一字不改地保留 */
function legacyOrder(a, b) {
  return (b.row.channel - a.row.channel) || (b.topic - a.topic) || byUpdated(a, b) || byPath(a, b);
}

/** 有向量时：通道优先（避免配额被语义结果挤爆）→ RRF → 词面分兜底 */
function fusedOrder(a, b) {
  return (b.row.channel - a.row.channel) || (b.rrf - a.rrf) || (b.topic - a.topic) || byUpdated(a, b) || byPath(a, b);
}

/**
 * 合并候选 + 准入 + 排序。
 *
 * @param rows        FTS 侧有序候选（searchIndex 的输出；调用方需把向量命中的回填行并进尾部）
 * @param options.scoreTopic  词面分函数（由 recall.mjs 传入，避免模块循环依赖）
 * @param options.vectorHits  向量命中 [{id, distance}]（已按距离升序）；null/[] 时完全走旧排序
 * @param options.maxDistance 向量-only 命中的准入门槛（cosine distance）
 */
export function rankCandidates(rows, {
  terms = [],
  scoreTopic,
  vectorHits = null,
  maxDistance = DEFAULT_MAX_DISTANCE,
  includeHistory = false,
  k = DEFAULT_RRF_K,
} = {}) {
  if (typeof scoreTopic !== 'function') throw new TypeError('rankCandidates 需要 scoreTopic 函数');
  const source = Array.isArray(rows) ? rows : [];
  const thresholds = Number.isFinite(Number(maxDistance)) ? Number(maxDistance) : DEFAULT_MAX_DISTANCE;

  const distances = new Map();
  for (const hit of Array.isArray(vectorHits) ? vectorHits : []) {
    if (!hit || hit.id === null || hit.id === undefined) continue;
    const value = Number(hit.distance);
    if (!Number.isFinite(value)) continue;
    const id = String(hit.id);
    if (!distances.has(id) || value < distances.get(id)) distances.set(id, value);
  }
  const hasVector = distances.size > 0;
  const fused = hasVector ? rrf([source.map((row) => row.id), [...distances.keys()]], k) : null;

  const scored = [];
  for (const row of source) {
    // history/inbox 平时通道为 0；只有显式问"以前"时才按事实通道参与
    const channel = Number(row.channel) || (includeHistory ? 3 : 0);
    if (!channel) continue;
    const id = String(row.id);
    const topic = scoreTopic(row, terms);
    const distance = distances.has(id) ? distances.get(id) : null;
    const vectorAdmitted = distance !== null && distance <= thresholds;
    // 准入：词面有重叠，或向量命中且距离在阈值内
    if (!(topic > 0 || vectorAdmitted)) continue;
    scored.push({
      row: { ...row, channel },
      topic,
      rrf: fused ? (fused.get(id) || 0) : 0,
      distance,
      vector: distance !== null && distance <= thresholds,
    });
  }
  scored.sort(hasVector ? fusedOrder : legacyOrder);
  return scored;
}
