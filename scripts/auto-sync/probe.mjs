// probe.mjs — 线路1 预探测（在独立 GHA job 中运行，无候选则跳过整个同步 job）
// 运行：node scripts/auto-sync/probe.mjs
// 输出：若存在待同步版本，向 $GITHUB_OUTPUT 写入 needs_sync=true；否则 needs_sync=false
// 本脚本不读 H1111_USER / H1111_PASSWORD，不触碰网盘、不写文件、不跑 git

import { logger } from './logger.mjs';
import {
  SOFTWARES,
  compareVersionsDescending, versionFromTag, formatCst,
  entrySortKey, isPinnedEntry, parseDataSourceIndex,
  fetchReleases,
} from './lib.mjs';

// GITHUB_STEP_SUMMARY 汇总行（markdown 表格）；备注里的竖线/换行做转义
const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
const probeRow = (sw, dsLatest, versions, note = '—') =>
  `| ${sw.softwareId} | ${sw.githubRepo} | ${dsLatest || '（无）'} | ${versions.length} | ${versions.join('<br>') || '—'} | ${note} |`;

async function main() {
  logger.banner(`线路1 预探测 · ${SOFTWARES.length} 个软件`);
  let hasCandidates = false;
  let overallFailed = false;

  // 汇总页表头（行在各软件探测时追加）
  logger.sum('## 线路1 预探测汇总');
  logger.sum('| 软件 | 仓库 | 数据源最新 | 待同步数 | 待同步版本 | 备注 |');
  logger.sum('|---|---|---|---|---|---|');

  logger.phase(`逐软件探测（${SOFTWARES.length} 个）`);
  for (const sw of SOFTWARES) {
    logger.scope(`软件 id=${sw.softwareId}（${sw.githubRepo}）`);
    logger.start('probe-' + sw.softwareId);
    try {
      const { latest: dsLatest, entries: origEntries } = parseDataSourceIndex(sw.softwareId);
      const knownCount = origEntries.filter((e) => !isPinnedEntry(e) && entrySortKey(e) != null).length;
      logger.log(`数据源基线：最新 ${dsLatest || '（无）'}｜可解析版本 ${knownCount} 个｜index.json 条目 ${origEntries.length} 个`);

      logger.log(`拉取 GitHub Releases：${sw.githubRepo} …`);
      const releases = await fetchReleases(sw.githubRepo, !!sw.includePrerelease);
      logger.log(`Release 总数（非 draft${sw.includePrerelease ? '' : '、非 prerelease'}）：${releases.length}`);
      if (!releases.length) {
        logger.warn('无 Release，跳过');
        logger.sum(probeRow(sw, null, [], '无 Release'));
        continue;
      }

      const versioned = releases
        .map((r) => ({ version: versionFromTag(r.tag_name), release: r }))
        .filter((x) => /^[vV]?[0-9]/.test(x.version))
        .filter((x, i, arr) => arr.findIndex((y) => y.version === x.version) === i);

      let candidates;
      if (!dsLatest) {
        candidates = versioned.slice(0, 1);
        logger.log(`数据源无版本 → 只取最新 Release：${candidates[0]?.version || ''}`);
      } else {
        candidates = versioned.filter((x) => compareVersionsDescending(dsLatest, x.version) > 0);
        logger.log(`数据源落后于 Release ${candidates.length} 个版本`);
      }
      candidates.sort((a, b) => compareVersionsDescending(b.version, a.version));

      logger.sum(probeRow(sw, dsLatest, candidates.map((c) => c.version)));
      if (!candidates.length) {
        logger.ok('已是最新');
        continue;
      }
      logger.ok(`需同步 ${candidates.length} 个版本（新→旧）：`);
      for (const c of candidates) logger.log(`· ${c.version}（发布于 ${formatCst(c.release.published_at)}）`);
      hasCandidates = true;
    } catch (e) {
      overallFailed = true;
      logger.error(`探测失败：${e.message}`);
      logger.sum(probeRow(sw, null, [], `❌ ${cell(e.message)}`));
    } finally {
      logger.log(`耗时 ${logger.end('probe-' + sw.softwareId)}ms`);
      logger.endScope();
    }
  }
  logger.endScope();

  // 汇总页结尾
  logger.sum('---');
  logger.sum(`- 软件总数：${SOFTWARES.length}｜判定结果：${hasCandidates ? '**有候选 → 调度同步 job**' : '全部最新 → 跳过同步 job'}${overallFailed ? '（存在探测错误 ⚠）' : ''}`);

  // 写入 GHA job 输出
  const ghOutput = process.env.GITHUB_OUTPUT;
  const needsSync = hasCandidates ? 'true' : 'false';
  if (ghOutput) {
    const { appendFileSync } = await import('node:fs');
    appendFileSync(ghOutput, `needs_sync=${needsSync}\n`);
    logger.log(`已写入 GITHUB_OUTPUT：needs_sync=${needsSync}`);
  }

  // GHA 告警：有探测错误时在 Actions UI 显示黄色警告，但仍以 exit 0 完成 job，
  // 确保 sync job 的 if 条件（needs.probe.outputs.needs_sync == 'true'）能正常评估
  if (overallFailed) logger.warn('预探测存在错误（详见上方日志），但仍将根据 needs_sync 决定是否调度 sync job');
  logger.banner(`预探测结束 · needs_sync=${needsSync}${overallFailed ? '（存在探测错误）' : ''}`);
  await logger.flushSummary();
  // 永远 exit 0：GHA 将 exit ≠ 0 视为 job 失败，失败的 probe 会导致 sync job 被跳过，
  // 即便 needs_sync=true 也无济于事；因此错误通过 ::warning:: 告警，退出码保持 0
  process.exitCode = 0;
}

main().catch(async (e) => {
  // 异常也不 exit 1：避免因 probe 崩溃导致 sync job 被跳过；通过 ::error:: 在 GHA UI 显示红色错误标记
  logger.error(`预探测发生严重异常：${e.message}（已默认写入 needs_sync=true）`);
  // 异常时默认有候选（宁可多跑一次同步 job，也不要漏掉）
  const ghOutput = process.env.GITHUB_OUTPUT;
  if (ghOutput) {
    const { appendFileSync } = await import('node:fs');
    try { appendFileSync(ghOutput, 'needs_sync=true\n'); } catch { /* ignore */ }
  }
  logger.sum('## 线路1 预探测汇总');
  logger.sum('> 预探测脚本发生严重异常，无法输出逐软件结果');
  logger.sum(`> ❌ ${String(e.message || '').replace(/\n/g, ' ')}`);
  await logger.flushSummary();
  process.exitCode = 0;
});
