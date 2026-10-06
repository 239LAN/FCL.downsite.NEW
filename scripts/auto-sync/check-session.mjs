// check-session.mjs — 会话 cookie 有效期巡检（在 probe job 中运行，只读）
// 运行：node scripts/auto-sync/check-session.mjs
//
// ============================ 为什么需要它 ============================
//
// 站点把**登录**改成交互式验证后，自动同步靠「人工登录一次拿到的会话 cookie」续命。
// 该 cookie **绝对 60 天过期、不滑动续期**，而用户住校期间无法人工干预。
// 所以需要每次运行都把「还剩多久」写进日志，临期时给足提示 —— 本脚本就干这个。
//
// ============================ 输出到哪 ============================
//
//   ① run 日志（每行都进 GitHub Actions 的运行页）
//   ② GHA 注解（::warning:: / ::error:: → 运行页顶部横幅）
//   ③ 汇总页（GITHUB_STEP_SUMMARY → 运行页顶部表格）
//
// ⚠ **剩余时间是固定输出的**：无论健康还是临期，都会
//   · 发一条 `::warning::` 注解写明「剩余 X 天（到期 …｜状态）」
//   · 在汇总页打一张固定字段的表（剩余 / 到期 / 签发 / 状态 / 验活）
//   这样每次跑完扫一眼运行页就能看到寿命，不必翻日志正文。
//   真正失效时注解会升级为 `::error::`（更醒目），并在汇总页追加「怎么解决」。
//
// ⚠ 不创建 Issue、不调用 GitHub API。原因：Issue 通道需要额外权限与去重逻辑，
//   而**GHA 注解与汇总页在运行页已经足够醒目**，且不会因为权限/去重出错而产生副作用。
//   （若将来想要邮件推送，再单独加，不要混在这里。）
//
// ============================ 全程只读 ============================
//
//   · 发一次 `GET /user/me` 验活（不修改任何数据）
//   · 不发任何写请求、不消耗验证挑战
//
// ============================ 环境变量 ============================
//
//   H1111_SESSION  —— 会话 cookie 值（GHA secret 注入）
//
// ============================ 退出码永远是 0 ============================
//
// ⚠ 这一点是刻意的：本脚本是 probe job 的一步，若返回非 0，GHA 会把 probe 判红，
//   而 probe 失败会导致 **sync job 被跳过** —— 那样即便真有新版本也不会同步。
//   巡检本身不该有这种权力，所以一切异常都只记录、不抛出。

import { ENV } from './config.mjs';
import { Logger, errText, fmtDur } from './logger.mjs';
import {
  sessionInfo, maskSession, fmtUnixCST, fmtRemaining, SESSION_BANDS,
} from './session.mjs';

const log = new Logger({ rootTitle: '线路1 会话巡检' });

/**
 * 实际打一次 `GET /user/me`，验证会话到底还活着没有。
 *
 * 为什么不能只靠离线推算：到期时间是「cookie 内嵌签发时间 + 硬编码的 60 天常量」算出来的。
 * 站点若改了会话时长（或提前作废会话），离线推算会给出**错误的乐观结论**。
 * 更隐蔽的是：站点对**匿名访问**也会签发新 cookie（实测每次请求都换新），
 * 所以「cookie 很新」根本不能证明已登录 —— 只有真问一次服务端才知道。
 *
 * @returns {Promise<{ok:boolean, code:number|string, who?:string, reason?:string}>}
 */
async function liveCheck() {
  // 超时保护：巡检不该把 probe job 拖住
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 20_000);
  try {
    const res = await fetch(ENV.HOST + '/api/v3/user/me', {
      headers: {
        Accept: 'application/json',
        // 缺此头会得到 41709，与登录态无关（见 docs/huang1111-api-notes.md §0.4b）
        'X-Cloudreve-Captcha-Protocol': '2',
        Cookie: `cloudreve-session=${ENV.SESSION}`,
      },
      redirect: 'manual',
      signal: ac.signal,
    });
    const json = await res.json().catch(() => null);
    const code = json?.code;
    if (code === 0) {
      return { ok: true, code, who: json?.data?.nickname || json?.data?.user_name || '' };
    }
    if (code === 401) {
      return { ok: false, code, reason: '服务端返回 401（登录态无效/已过期）' };
    }
    return { ok: false, code, reason: `服务端返回 code=${code} ${json?.msg || ''}` };
  } catch (e) {
    // 网络异常不等于会话失效 —— 区分开，避免误报「请重新登录」
    return { ok: false, code: 'ERR', reason: `请求失败：${e.name === 'AbortError' ? '超时' : e.message}` };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const t0 = Date.now();
  const phase = log.child('会话有效期检查');
  const info = sessionInfo(ENV.SESSION);

  // ---------------- 情况 A：压根没配会话 ----------------
  // 没配 = 同步必然失败（登录被交互式验证挡住），必须显眼地喊出来
  if (!info.present) {
    phase.line('未配置 H1111_SESSION');
    phase.line('⚠ 同步脚本会回退到账号密码登录，而站点已启用交互式验证（人眼点选/输入/拖滑块）');
    phase.line('   → **预计失败**，所有软件都不会同步');
    phase.line('   取会话的方法见 scripts/auto-sync/README.md「会话 cookie」一节：');
    phase.line('     node scripts/auto-sync/tools/refresh-session.mjs');
    phase.close('❌ 未配置会话 cookie', { kind: 'fail' });

    log.annotate('error', '线路1会话巡检：未配置 H1111_SESSION —— 自动同步必定失败，请立即配置');
    log.summary([
      '### 线路1 会话巡检',
      '',
      '| 项目 | 值 |',
      '|---|---|',
      '| 状态 | ❌ **未配置 `H1111_SESSION`** |',
      '| 影响 | 同步脚本回退到账号密码登录，而站点已启用交互式验证 → **必定失败** |',
      '| 处理 | 在已登录网盘的机器上运行 `node scripts/auto-sync/tools/refresh-session.mjs`，'
        + '把值存入 secret `H1111_SESSION` |',
      '',
      '> 详见 `scripts/auto-sync/README.md`「会话 cookie」一节。',
      '',
    ]);
    log.line(`巡检结束：❌ 未配置｜用时 ${fmtDur(Date.now() - t0)}`);
    log.flushSummary();
    return;
  }

  // ---------------- 汇报寿命（健康时也要打，方便确认）----------------
  phase.line(`cookie：${maskSession(ENV.SESSION)}`);

  if (!info.parseable) {
    phase.line(`⚠ 无法解析签发时间：${info.reason}`);
    phase.line('  会话值可能被截断、含多余空白，或不是 cloudreve-session 的值。');
    phase.line('  请用 node scripts/auto-sync/tools/refresh-session.mjs 重新提取并完整粘贴。');
    phase.close('⚠️ 无法解析会话值', { kind: 'warn' });

    log.annotate('warning', `线路1会话巡检：无法解析 H1111_SESSION —— ${info.reason}`);
    log.summary([
      '### 线路1 会话巡检',
      '',
      '| 项目 | 值 |',
      '|---|---|',
      '| 状态 | ⚠️ **无法解析 `H1111_SESSION`** |',
      `| 原因 | ${info.reason} |`,
      `| cookie 指纹 | \`${maskSession(ENV.SESSION)}\` |`,
      '',
      '> 请用 `node scripts/auto-sync/tools/refresh-session.mjs` 重新提取并**完整**粘贴。',
      '',
    ]);
    log.line(`巡检结束：⚠️ 无法解析｜用时 ${fmtDur(Date.now() - t0)}`);
    log.flushSummary();
    return;
  }

  phase.line(`签发于 ${fmtUnixCST(info.issuedAt)}｜到期于 ${fmtUnixCST(info.expiresAt)}（按实测 60 天有效期推算）`);
  phase.line(`剩余 ${fmtRemaining(info.secondsLeft)}`);

  // ---------------- 实际验活（不信离线推算）----------------
  const live = await liveCheck();
  phase.line(live.ok
    ? `服务端验活：✅ 会话有效${live.who ? `（${live.who}）` : ''}`
    : `服务端验活：❌ ${live.reason}`);

  // 冲突提示：离线说还早、服务端却说无效 → 多半是站点调了会话时长
  if (!live.ok && live.code === 401 && info.valid) {
    phase.warn('⚠ 离线推算显示未到期，但服务端已拒绝该会话 —— 站点可能调整了会话时长');
    phase.warn('  请以实际失效为准。若确认站点改了时长，可用 H1111_SESSION_TTL（秒）覆盖常量，');
    phase.warn('  或直接改 scripts/auto-sync/session.mjs 里的 SESSION_TTL_SECONDS。');
  }
  // 网络异常（非 401）不该判定会话失效 —— 避免让人白跑一趟
  const networkOnly = !live.ok && live.code === 'ERR';
  if (networkOnly) {
    phase.warn('（这是网络问题，不代表会话失效 —— 未按失效处理）');
  }

  // ---------------- 判定等级 ----------------
  const liveDead = live.ok === false && live.code === 401;
  const expired = info.band === 0 || liveDead;
  const band = expired ? 0 : info.band; // null = 健康（>30 天）

  // ---------------- 无条件输出「剩余时间」到注解 + 汇总页 ----------------
  // 用户要求：不管健康还是临期，这条剩余时间都要在运行页顶部（注解）与概览（汇总页）里能看到，
  // 这样每次跑完扫一眼就知道寿命，不必翻日志正文。
  // 等级固定为 warning —— notice 太容易被忽略；真正失效时下面还会再补一条 error。
  const verdictText = expired ? '❌ 已失效'
    : band !== null ? `⚠️ 临期（${band} 天档）`
      : '✅ 健康';
  // 汇总页里的状态加粗（表格里醒目）；注解是纯文本，用不加粗的那份（否则星号会原样显示）
  const verdictMd = expired ? '❌ **已失效**'
    : band !== null ? `⚠️ **临期（${band} 天档）**`
      : '✅ **健康**';
  log.annotate(
    expired ? 'error' : 'warning',
    `线路1会话巡检：会话 cookie 剩余 ${fmtRemaining(info.secondsLeft)}`
    + `（到期 ${fmtUnixCST(info.expiresAt)}｜${verdictText}）`,
  );

  // 汇总页表格：无论什么状态都打同一张表，字段固定，便于逐日对照
  log.summary([
    '### 线路1 会话巡检',
    '',
    '| 项目 | 值 |',
    '|---|---|',
    `| **剩余** | **${fmtRemaining(info.secondsLeft)}** |`,
    `| 到期时间 | ${fmtUnixCST(info.expiresAt)}（按实测 60 天推算） |`,
    `| 签发时间 | ${fmtUnixCST(info.issuedAt)} |`,
    `| 状态 | ${verdictMd} |`,
    `| 服务端验活 | ${live.ok ? `✅ 通过${live.who ? `（${live.who}）` : ''}` : `❌ ${live.reason || ''}`} |`,
    `| cookie 指纹 | \`${maskSession(ENV.SESSION)}\` |`,
    '',
  ]);

  // ---------------- 按等级补充细节 ----------------
  if (expired) {
    phase.line('→ 同步脚本**无法登录**，所有软件都不会同步，直到更新 H1111_SESSION');
    phase.line('   取新会话：在已登录网盘的机器上运行');
    phase.line('     node scripts/auto-sync/tools/refresh-session.mjs');
    phase.close('❌ 会话已失效', { kind: 'fail' });

    log.summary([
      '### 怎么解决',
      '',
      '在已登录网盘的机器上运行：',
      '',
      '```powershell',
      'node scripts/auto-sync/tools/refresh-session.mjs',
      '```',
      '',
      '把输出的值存入仓库 secret `H1111_SESSION`。详见 `scripts/auto-sync/README.md`。',
      '',
    ]);
  } else if (band !== null) {
    // 30 / 10 / 1 天档
    phase.line(`→ 距失效还有 ${fmtRemaining(info.secondsLeft)}，建议尽快更新 H1111_SESSION`);
    phase.line('   取新会话：node scripts/auto-sync/tools/refresh-session.mjs');
    phase.close(`⚠️ 会话临期（${band} 天档，剩余 ${fmtRemaining(info.secondsLeft)}）`,
      { kind: 'warn' });

    log.summary([
      `> ⚠️ 距失效还有 ${fmtRemaining(info.secondsLeft)}（${band} 天档）—— 建议尽快更新。`,
      '> 取新会话：`node scripts/auto-sync/tools/refresh-session.mjs`（在已登录网盘的机器上）',
      '',
    ]);
  } else {
    // 健康
    phase.line('✅ 会话有效期充裕（> 30 天）');
    phase.close('✅ 会话健康', { body: false });

    log.summary([
      '> 到期时间 = cookie 内嵌签发时间 + 实测的 60 天常量（cookie 本身不含过期时间）。',
      '> 权威结论以「服务端验活」为准。',
      '',
    ]);
  }

  const verdict = expired ? '❌ 已失效' : band !== null ? `⚠️ 临期（${band} 天档）` : '✅ 健康';
  log.line(`巡检结束：${verdict}｜用时 ${fmtDur(Date.now() - t0)}`);
  log.flushSummary();
}

main().catch((e) => {
  // 巡检绝不阻断 probe（见文件头「退出码永远是 0」）
  const msg = errText(e);
  process.stderr.write(`会话巡检异常：${e.stack || msg}\n`);
  log.annotate('warning', `线路1会话巡检异常（不影响同步）：${msg}`);
  log.flushSummary();
});
