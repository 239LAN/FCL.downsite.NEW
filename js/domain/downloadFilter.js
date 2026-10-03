/**
 * 下载表格筛选模块。
 * 所有筛选逻辑集中在这里处理：类别定义、文件归类、可见性计算。
 * 视图只负责渲染勾选框并把用户的选择传回来，与选择器的自动选择模块
 * （autoSelect.js）一样，调用方无需关心筛选策略的细节。
 *
 * 类别（按优先级从高到低）：
 * - dataSource：命中数据源配置的 URL 正则白名单（detail.json 的 filter，如 "\\.apk$"）；
 * - system：命中当前系统安装包表达式（systemInfo.js 提供，如 Windows 的 `\.(?:exe|msi)$`
 *   与名称含 windows 的 `(^|[-_.])windows(?![a-z])`）；
 * - archive：压缩包（由 ARCHIVE_EXTENSIONS 编译出 `\.(?:zip|7z)$`）；
 * - source：源码包（由 SOURCE_EXTENSIONS 编译出 `\.(?:tar\.gz|tar\.xz|tgz|txz)$`）。
 *
 * 四类条件统一按正则处理（均大小写不敏感），筛选面板的标签也统一展示正则本身
 * （而非"后缀列表"），好让用户看到的条件与实际生效的匹配规则完全一致。
 * 匹配对象是完整的下载 URL（含 query string），不是单独的 pathname。
 * 其中 dataSource 是唯一由站点作者手写的正则，其余三类由本模块与 systemInfo.js 生成。
 *
 * 可见性按优先级管线计算，与 autoSelect.js 的步骤管道同构：
 * 每个勾选的类别从"上一个筛剩下的"文件中领取自己的命中项，未命中则继续传给下一个；
 * 文件被第一个（优先级最高）勾选类别命中即显示，未被任何勾选类别命中的文件隐藏。
 * "显示全部"优先级最高，勾选时直接领取全部文件；它与类别勾选互斥，
 * 该互斥由视图维护，本模块只负责按 state 判定可见性。
 *
 * 首屏默认勾选"数据源"与"当前系统"（如可用），压缩包/源码包默认隐藏；
 * 两者都不可用时回退为勾选"显示全部"，避免首屏被筛成空表。
 */

import { logWarn } from '../common/logger.js';
import { t } from '../common/i18n.js';

/** 压缩包扩展名（不含点/带点均可，编译为"以该扩展名结尾"的正则片段）。 */
export const ARCHIVE_EXTENSIONS = ['zip', '7z'];

/** 源码包扩展名（tar.gz 等复合扩展名整体匹配，编译为"以该扩展名结尾"的正则片段）。 */
export const SOURCE_EXTENSIONS = ['tar.gz', 'tar.xz', 'tgz', 'txz'];

/** 类别的优先级顺序（从高到低）；"显示全部"隐含为最高优先级，先于所有类别。 */
const CATEGORY_ORDER = ['dataSource', 'system', 'archive', 'source'];

/**
 * 判断下载 URL 是否命中表达式列表。
 * 表达式是作用于下载地址的正则片段（大小写不敏感）：系统类别由 systemInfo.js 给出，
 * 既含要求扩展名结尾的 `\.(?:exe|msi)$`，也含命中名称中段的 `(^|[-_.])windows(?![a-z])`，
 * 从而覆盖 xxx-windows-v1.2.3.zip、app-win64.zip 这类名称含系统（含 win32/win64 数字粘连）的包；
 * 压缩包/源码包类别传入扩展名，由下方按后缀编译。
 * 非法正则必须 try/catch 防护，避免配置错误导致渲染崩溃。
 * @param {string} url 下载地址
 * @param {Array<string>} patterns 正则片段列表
 * @returns {boolean} 命中返回 true
 */
function matchesPatterns(url, patterns) {
  return patterns.some((pattern) => {
    try {
      return new RegExp(pattern, 'i').test(url);
    } catch (error) {
      logWarn(error, t('logger.context.invalidFilterRegex', { pattern }));
      return false;
    }
  });
}

/**
 * 把扩展名列表编译为"以该扩展名结尾"的正则片段。
 * 同时兼容带点（`.tar.gz`）与不带点（`zip`）两种写法，点号一律转义，
 * 使 .zipx、.7z.001 之类的长扩展名不会被误判为命中。
 * @param {Array<string>} extensions 扩展名列表
 * @returns {Array<string>} 正则片段列表
 */
function compileSuffixPatterns(extensions) {
  return extensions.map((ext) => `\\.${String(ext).replace(/^\.+/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
}

/**
 * 构建筛选配置：类别列表（含标签、是否启用与默认勾选）、
 * 默认勾选状态、文件归类函数与可见性判定。
 * @param {object} [options]
 * @param {Array<string>} [options.filter] 数据源配置的 URL 正则白名单（detail.json 的 filter）；
 *   手写正则，作用于完整下载 URL，大小写不敏感，非法表达式会被跳过并记录日志
 * @param {Array<string>} [options.osPatterns] 当前系统安装包正则片段（systemInfo.js 提供）
 * @param {string} [options.osName] 当前系统显示名（UAParser os.name，如 "Windows"）
 * @returns {{categories: Array<{key: string, label: string, enabled: boolean, defaultChecked: boolean}>, createDefaultState: () => {showAll: boolean, checked: Record<string, boolean>}, classify: (item: object) => Set<string>, isVisible: (categoryKeys: Set<string>, state: object) => boolean}}
 */
export function createFilterConfig({ filter, osPatterns = [], osName = '' } = {}) {
  const patterns = Array.isArray(filter)
    ? filter.filter((pattern) => typeof pattern === 'string' && pattern)
    : [];
  // 系统类别用的是正则片段（可为空），压缩包/源码包类别用的是扩展名，各自编译一次复用。
  const systemPatterns = osPatterns.filter((pattern) => typeof pattern === 'string' && pattern);
  const archivePatterns = compileSuffixPatterns(ARCHIVE_EXTENSIONS);
  const sourcePatterns = compileSuffixPatterns(SOURCE_EXTENSIONS);
  // 类别顺序即面板中勾选框的展示顺序，也即优先级顺序；enabled 为 false 的类别在面板中不渲染。
  // defaultChecked 为 true 的类别在首屏默认勾选。
  const none = t('common.filterCategory.none');
  const categories = [
    {
      key: 'dataSource',
      label: t('common.filterCategory.dataSource', { items: patterns.join(', ') || none }),
      enabled: patterns.length > 0,
      defaultChecked: true,
    },
    {
      key: 'system',
      label: t('common.filterCategory.system', {
        osName,
        items: systemPatterns.join(', ') || none,
      }),
      enabled: systemPatterns.length > 0,
      defaultChecked: true,
    },
    {
      key: 'archive',
      label: t('common.filterCategory.archive', { items: archivePatterns.join(', ') }),
      enabled: true,
      defaultChecked: false,
    },
    {
      key: 'source',
      label: t('common.filterCategory.source', { items: sourcePatterns.join(', ') }),
      enabled: true,
      defaultChecked: false,
    },
  ];

  /**
   * 生成首屏默认勾选状态：默认勾选"数据源"与"当前系统"（如可用）。
   * 两者都不可用时（如无法识别系统且数据源未配置筛选）回退为勾选"显示全部"，
   * 避免首屏被筛成空表。
   * @returns {{showAll: boolean, checked: Record<string, boolean>}} 默认勾选状态
   */
  function createDefaultState() {
    const checked = {};
    let defaultCheckedCount = 0;
    for (const category of categories) {
      if (!category.enabled) continue;
      checked[category.key] = category.defaultChecked;
      if (category.defaultChecked) defaultCheckedCount += 1;
    }
    return { showAll: defaultCheckedCount === 0, checked };
  }

  /**
   * 判定下载项命中的类别。
   * @param {{downloadUrl?: string}} item 统一下载叶子节点
   * @returns {Set<string>} 命中的类别 key 集合（可为多个；全未命中时为空集合）
   */
  function classify(item) {
    const url = item?.downloadUrl || '';
    const keys = new Set();
    // 数据源 filter 是作用在"完整下载 URL"上的正则白名单（含 query string），
    // 由用户在 detail.json 里手写，因此：
    // - 大小写不敏感（与 system/archive/source 三类一致），".apk" 同样能命中 .APK；
    // - 非法的正则必须 try/catch 防护，避免配置写错导致整个表格渲染崩溃。
    // 注意 filter 里写 ".apk" 时点号是"任意字符"，要严格后缀请写成 "\\.apk$"。
    if (patterns.some((pattern) => {
      try {
        return new RegExp(pattern, 'i').test(url);
      } catch (error) {
        logWarn(error, t('logger.context.invalidFilterRegex', { pattern }));
        return false;
      }
    })) keys.add('dataSource');
    if (matchesPatterns(url, systemPatterns)) keys.add('system');
    if (matchesPatterns(url, archivePatterns)) keys.add('archive');
    if (matchesPatterns(url, sourcePatterns)) keys.add('source');
    return keys;
  }

  /**
   * 判定下载项在给定勾选状态下是否可见（按优先级管线）。
   * "显示全部"勾选时无条件可见；否则从最高优先级类别开始，
   * 第一个勾选且命中该文件的类别将其领取并显示，未被任何勾选类别领取的文件隐藏。
   * @param {Set<string>} categoryKeys classify 返回的类别集合
   * @param {{showAll: boolean, checked: Record<string, boolean>}} state 勾选状态
   * @returns {boolean} 可见返回 true
   */
  function isVisible(categoryKeys, state) {
    if (state?.showAll) return true;
    for (const key of CATEGORY_ORDER) {
      if (state?.checked?.[key] && categoryKeys.has(key)) return true;
    }
    return false;
  }

  return { categories, createDefaultState, classify, isVisible };
}
