/**
 * 下载适配器共用工具。
 * adapter 的职责是把上游任意结构变为两类节点：
 * 1. 分组节点：{ name, default?, children, publishedAt? }；
 * 2. 下载叶子：{ name, version, architecture, size, description, downloadUrl, available, source }
 *    以及可选的扩展元数据 sha256 / prerelease / contentType / assetId / tagName / launcher。
 *
 * 扩展元数据是「线路 API 提供了才显示」的附加信息：上游缺省一律为空字符串，
 * 由 selectorView 按「整列为空则删除该列」的既有规则决定是否成列，
 * 因此新增字段不需要各线路逐一适配，也不会给未提供该信息的线路增加空列。
 */

// 不假设版本一定遵循严格 SemVer；提取连续数字可覆盖常见的 v1.2.3、2024.01 等命名。
const VERSION_NUMBER = /\d+/g;

/**
 * 归一化校验值：只保留十六进制主体，统一转为小写。
 * 各上游前缀不一（枫源为 `sha256:xxxx`，柠泽为裸 `xxxx`），这里剥掉算法前缀与空白，
 * 使不同线路的同一文件展示成同一个值；不是十六进制字符串时原样返回，避免误伤未来格式。
 * @param {unknown} value 上游校验值
 * @returns {string} 归一化后的校验值，缺省为空字符串
 */
function normalizeSha256(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  // 大小写不敏感地剥掉 `sha256:` / `sha-256=` 之类前缀，只保留摘要本体。
  const body = trimmed.replace(/^sha-?256\s*[:=]\s*/i, '') || trimmed;
  return /^[0-9a-f]+$/i.test(body) ? body.toLowerCase() : body;
}

/**
 * 提取可选的扩展元数据。
 * 各线路字段名不同，只有这里允许读取其原始字段；缺省统一为 ''，
 * 使 view 可以直接按「空字符串 = 无此项」处理，无需区分 undefined / null。
 * @param {object} item 上游原始项
 * @param {object} [release] 该项所属的 release/版本级对象（提供 tag_name、launcher、published_at 等）
 * @returns {{sha256: string, prerelease: boolean|null, contentType: string, assetId: string, tagName: string, launcher: string, publishedAt: string}}
 */
export function normalizeExtraMetadata(item, release = {}) {
  return {
    // 枫源的 digest_sha256 带 `sha256:` 前缀，柠泽的 sha256 是裸摘要。
    sha256: normalizeSha256(item.sha256 ?? item.digest_sha256 ?? item.digest ?? ''),
    // 三态：true=预发布、false=正式发布、null=上游没提供（此时该列整列为空而自动隐藏）。
    prerelease: typeof (item.prerelease ?? release.prerelease) === 'boolean'
      ? (item.prerelease ?? release.prerelease)
      : null,
    contentType: item.content_type || item.contentType || '',
    // asset_id 是枫源这类上游的稳定条目主键，仅作标识展示，不参与任何逻辑。
    assetId: item.asset_id || item.assetId || item.id || '',
    // 版本 Tag：Linkong 用 version/title 而非 tag_name，缺 tag_name 时回退到它，
    // 避免「有版本号却整列为空」导致该列在该线路上凭空消失。
    tagName: release.tag_name || release.tagName || item.tag_name || release.version || release.title || '',
    launcher: release.launcher || item.launcher || '',
    // 发布时间是 release 级信息，同一版本每行都相同；这里逐行重复以便成列展示。
    publishedAt: formatPublishedAt(item.published_at ?? release.published_at ?? ''),
  };
}

/**
 * 把上游的发布时间转为可展示文本。
 * 时间字符串解析失败（或上游根本没给）时返回 ''，使调用方按「无此项」处理，
 * 避免 Invalid Date 之类的字样出现在版本描述区。
 * @param {unknown} value 上游时间字符串，如 "2026-09-30T01:42:04Z"
 * @returns {string} 本地化时间文本，无法解析时为空字符串
 */
export function formatPublishedAt(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  try {
    return date.toLocaleString();
  } catch (error) {
    // 极少数环境可能缺少 locale 数据；退回 ISO 日期，仍然比什么都不显示好。
    return date.toISOString();
  }
}

/**
 * 按版本从新到旧排序，供按版本分组的镜像选择默认项。
 * @param {string|number} left 版本字符串
 * @param {string|number} right 版本字符串
 * @returns {number} 负数表示 left 更新，正数表示 right 更新，0 表示相同
 */
export function compareVersionsDescending(left, right) {
  const leftParts = String(left).match(VERSION_NUMBER)?.map(Number) || [];
  const rightParts = String(right).match(VERSION_NUMBER)?.map(Number) || [];
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const difference = (rightParts[index] || 0) - (leftParts[index] || 0);
    if (difference) return difference;
  }
  return 0;
}

/**
 * 抽取不同上游的同义字段，构造唯一允许交给 view 的下载叶子结构。
 * source 是人类可读线路名称；version 由父级分组传入，供后续展示/分析扩展。
 * 末尾的扩展元数据来自 normalizeExtraMetadata，上游未提供时为空值。
 * @param {object} item 上游原始项
 * @param {string} source 线路显示名
 * @param {string} [version=''] 版本号
 * @param {object} [release] 该项所属的 release/版本级对象（用于 tag_name、launcher、prerelease）
 * @returns {{name: string, version: string, architecture: string, size: number|null, description: string, downloadUrl: string, available: boolean, source: string, sha256: string, prerelease: boolean|null, contentType: string, assetId: string, tagName: string, launcher: string}}
 */
export function normalizeDownloadItem(item, source, version = '', release = {}) {
  // 各镜像字段名不同，只有这里允许读取其原始字段；后续 controller/view 只认识统一模型。
  const downloadUrl = item.downloadUrl || item.url || item.link || item.download_link || '';
  return {
    name: item.name || item.file_name || '',
    version,
    architecture: item.architecture || item.arch || '',
    size: item.size ?? item.size_bytes ?? null,
    description: item.description || item.unavailable_reason || '',
    downloadUrl,
    available: item.available !== false,
    source,
    ...normalizeExtraMetadata(item, release),
  };
}
