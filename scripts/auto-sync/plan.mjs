// plan.mjs — 线路1 自动同步：候选版本探测（probe 与 sync 共用的唯一实现）
//
// 背景：重构前 probe.mjs 与 sync.mjs 各写了一遍「读基线 → 拉 Release → 算落后版本」，
// 两边口径一旦漂移就会出现「probe 说不用同步、sync 却认为有候选」这种自相矛盾的结果。
// 本文件把这段逻辑收成一处，两个入口都用它，日志也只维护一份。
//
// 检测逻辑（用户确认，未改动）：
//   1. 取数据源内最新版本（data/down/{id}/index.json 中可解析的版本条目）
//   2. 若数据源没有版本 → 只取 Release 最新一个
//   3. 否则 → 落后 Release 多少版本，就把落后的全部下载

import {
  compareVersionsDescending, versionFromTag,
  entrySortKey, isPinnedEntry, parseDataSourceIndex,
  fetchReleasesPage,
} from './lib.mjs';
import { errText } from './logger.mjs';

// 一页 100 条：与 GitHub API 上限一致，一次调用就能覆盖绝大多数仓库
const PER_PAGE = 100;

/**
 * 探测单个软件的候选版本。
 * @param {object} sw          softwares.json 条目
 * @param {object} scope       logger 作用域（负责输出本次探测的所有日志行）
 * @param {object} row         汇总表行（就地填充事实，供 run 日志与汇总页共用）
 * @returns {Promise<{candidates: Array, entries: Array, dsLatest: string|null, releaseCount: number, versionTotal: number, notes: string[]}>}
 */
export async function planSoftware(sw, scope, row = null) {
  const notes = [];

  // ---- 1) 数据源基线 ----
  const { latest: dsLatest, entries, versionCount } = parseDataSourceIndex(sw.softwareId);
  scope.line(`数据源基线：data/down/${sw.softwareId}/index.json`);
  scope.line(`数据源最新版本：${dsLatest ?? '（无）'}`);
  scope.line(`数据源版本条目：${versionCount} 个（不含置顶/无法解析版本的条目）`);
  if (row) { row.sourceLatest = dsLatest ?? '（无）'; row.sourceCount = versionCount; }

  // ---- 2) GitHub Releases ----
  const { releases, hasNext } = await fetchReleasesPage(
    sw.githubRepo, !!sw.includePrerelease, 1, (m) => scope.line(m),
  );
  const filterDesc = `非 draft${sw.includePrerelease ? '、含 prerelease' : '、非 prerelease'}、tag 含数字`;
  scope.line(`GitHub Releases：${releases.length} 个（${filterDesc}）${hasNext ? '｜另有更早的页，未拉取' : ''}`);
  if (row) row.releaseCount = releases.length;
  if (hasNext) notes.push('Release 超过 100 个，只比对了第一页');

  if (!releases.length) {
    scope.close('⏭️ 该仓库没有可用 Release，跳过');
    if (row) row.result = '⏭️ 无 Release';
    return { candidates: [], entries, dsLatest, releaseCount: 0, versionTotal: 0, notes };
  }

  // ---- 3) tag → 归一化版本名（去重，保留最新出现的那个 Release）----
  const versioned = [];
  const seen = new Set();
  for (const r of releases) {
    const version = versionFromTag(r.tag_name);
    if (!/^[vV]?[0-9]/.test(version)) continue;   // tag 不以数字开头 → 不是版本号
    if (seen.has(version)) continue;              // 归一化后重名（v1.0 与 "v1.0"）只留第一个
    seen.add(version);
    versioned.push({ version, release: r });
  }
  scope.line(`可解析版本号：${versioned.length} 个（其余 tag 不以数字开头，已排除）`);
  if (versioned.length && versioned[0] !== releases[0]) {
    scope.line(`最新版本：${versioned[0].version}（tag ${versioned[0].release.tag_name}，发布于 ${versioned[0].release.published_at?.slice(0, 10) ?? '?'}）`);
  }

  // ---- 4) 算候选 ----
  let candidates;
  if (!dsLatest) {
    candidates = versioned.slice(0, 1);
    scope.line(`数据源没有版本 → 只取最新一个：${candidates[0]?.version ?? '（无）'}`);
  } else {
    candidates = versioned.filter((x) => compareVersionsDescending(dsLatest, x.version) > 0);
    scope.line(
      candidates.length
        ? `落后 ${candidates.length} 个版本：${candidates.map((c) => c.version).join('、')}`
        : `已是最新（数据源 ${dsLatest} ≥ Release 最新 ${versioned[0]?.version ?? '?'}）`,
    );
  }
  // 由旧到新处理：先把老的补上，中途失败也不会留下"新的有、老的没有"的空洞
  candidates.sort((a, b) => compareVersionsDescending(b.version, a.version));

  if (row) row.candidates = candidates.map((c) => c.version);

  if (!candidates.length) {
    scope.close('✅ 已是最新，无需同步');
    if (row) row.result = '✅ 已是最新';
  } else {
    scope.close(`✅ 需同步 ${candidates.length} 个版本`);
  }
  return {
    candidates, entries, dsLatest,
    releaseCount: releases.length,
    versionTotal: versioned.length,
    notes,
  };
}

/**
 * 依次探测全部软件。单个软件失败不影响其余软件（记 ❌ 后继续）。
 * @returns {Promise<{plans: Array, rows: Array, hasCandidates: boolean, failed: number}>}
 */
export async function planAll(softwares, rootScope, makeRow) {
  const plans = [];
  const rows = [];
  let failed = 0;

  for (const sw of softwares) {
    const row = makeRow(sw);
    rows.push(row);
    const scope = rootScope.child(`资源 id=${sw.softwareId}（${sw.githubRepo}）`);
    try {
      const plan = await planSoftware(sw, scope, row);
      if (plan.candidates.length) plans.push({ sw, ...plan });
    } catch (e) {
      failed += 1;
      const msg = errText(e);
      scope.close(`❌ 探测失败：${msg}`, { kind: 'fail' });
      row.result = `❌ ${msg}`;
      rootScope.logger.annotate('error', `资源 id=${sw.softwareId} 探测失败：${msg}`);
    } finally {
      row.endedAt = Date.now();
    }
  }

  return { plans, rows, hasCandidates: plans.length > 0, failed };
}
