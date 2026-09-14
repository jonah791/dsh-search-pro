# 语义文档：dsh-search-pro（深度搜索 · 三层检索 / 23 工具）

> 能力名：`dsh-search-pro` · 主副本路径：`self-plugins/dsh-search-pro/docs/semantic.md`
> 实现落点：`self-plugins/dsh-search-pro/src/index.ts`（+ `src/engines.ts` `src/deep.ts` `src/robust.ts` `src/share.ts` `src/osint.ts` `src/store.ts` `src/fetch.ts` `src/archive.ts` `src/buildQuery.ts` `src/util.ts`）
> 版本：v0.1.0（package.json） · 2026-09-14 · 作者：爱丽丝 · 状态：**draft**
> 开发方式：语义文档优先（先写清「是什么/什么关系/怎么裁决」，再让实现逼近，最后用实践回修）

---

## 1 · 定位与反定位

**定位**：给我一套「检索 + 抓取」工具面（23 个 `search_*` / `fetch_*` / `archive_*` / `lookup_*` / `enum_*` 工具），
覆盖三层——L1 表层多引擎、L2 深网与 OSINT、L3 Tor/反爬抓取——并统一输出外壳 `{ ok, count, results, error?, note? }`。

**反定位（本文不管什么）**：
- 不管**内容判断**（结果该不该信、够不够用）——那是调用者（我）的裁决，本插件只做**取回与结构化**
- 不管**凭据的生命周期**（key 的签发/轮换/落盘）——`config` 与 `.credentials.yaml` 只是**读取方**
- 不管**红队渗透流程**（目录爆破/CVE 匹配/敏感路径）——那属于 `dsh-red-team`（8 个 `red_*` 工具）
- **不是**搜索引擎本体（无自有索引；全是第三方公开端点/HTML 解析的组合）
- **不是**沙箱：工具面 = 能力面，不是权限边界（见 §5）

## 2 · 术语表

| 术语 | 含义 |
|------|------|
| 三层（L1/L2/L3） | L1 表层多引擎；L2 深网/OSINT（学术/专利/GitHub/社区/WHOIS/子域）；L3 Tor + 反爬降级抓取 |
| 通道（channel） | 反爬抓取的一次尝试路径：`fingerprint` → `prewarm` → `retry` → `headless`；命中即停 |
| 反爬类型（challenge） | `detectChallenge()` 的分类：`none`/`ip-block`/`js-challenge`/`rate-limit`/`waf`/`unknown` |
| 缓存键（ck） | 各工具自拼的字符串键，仅 7 条路径有缓存（见 §4.1） |
| 配额计数（bump） | 每通道调用次数累加，`search_quota` 读出；**仅内存** |
| 输出外壳 | `resultsSchema()` 声明的对象：`ok`(必填)/`count`/`results`/`error`/`note`（**额外属性一律 false**） |

## 3 · 概念模型

```
cordis 组合(.dsh/profiles/web/cordis.patch.yml)
   └─ agent-search-pro → apply(ctx, config)          [src/index.ts:89]
        ├─ 凭据兜底：读 $DSH_HOME/.credentials.yaml   [src/index.ts:92-98]
        ├─ new SearchStore(ttlMs)  ← 内存 Map（无落盘） [src/store.ts:8]
        └─ reg() ×23 → ctx.tools.register(defineTool)  [src/index.ts:100]
                          │
   我(模型) 调工具 ──────► execute(args) ─ safe() ─► 模块函数（engines/deep/robust/share/osint/archive/fetch）
                                    │                        │
                                    ├─ store.get/set(ck)  ◄──┘  (7 路径)
                                    └─ store.bump(通道) → search_quota 可读
```

不变量（invariants）：
1. **I1 工具数恒为 23**：`src/index.ts` 内 `reg({...})` 调用点计数 = 23；`apply-test.mjs` 打印 `REGISTERED: 23` 可判真假。
2. **I2 execute 不向外抛**：所有 `execute` 经 `safe()` 包裹，失败恒返回 `{ ok:false, error:string }`（`search_quota` 内部 `torStatus().catch` 同款兜底）。
3. **I3 全量内存态**：缓存与配额不落盘——重启 web 后 `search_cache action=list` 必为空（可用一次重启判真假）。
4. **I4 输出必过 schema**：每个工具 `output.schema` 的 `additionalProperties:false` 生效，多字段即校验失败（`schema-test.mjs` 输出 `validate violations: NONE` 可判）。
5. **I5 缺配置即显式拒绝**：`search_serp`(tavily/serper)、`lookup_dns_history`、`search_shodan` 在无 key 时返回固定文案 `未配置 <key>（Config）`，不静默降级。

## 4 · 契约

### 4.1 数据结构与落盘
- **缓存/配额**：`src/store.ts:SearchStore`——`cache: Map<string,{value,expiresAt}>`、`counts: Map<string,number>`；TTL = `config.cacheTtlMinutes`（默认 60）分 × 60_000；`set()` 在 `size > 500` 时清除**已过期**条目。
- **有缓存的键（7）**：`web:<query>:<engines>:<pages>:<timeRange>`、`site:<site>:<query>:<engines>`、`academic:<query>:<source>:<limit>`、`robust:<url>:<skipHeadless>`、`share:<query>:<kind>`、`code:<query>:<limit>`、`darkweb:<query>:<limit>`。其余 16 工具**不缓存**。
- **落盘（2026-09-14 批次 S4-A 更新）**：**新增自证侧车** `<DSH_HOME>/search-trace.jsonl`（§4.4，一行一工具调用，
  全部 IO 失败吞错）——这是本插件**唯一的自有状态落盘**。此前的状态是「不写任何自有状态文件」，
  而代价已实测：headless 临时 profile 泄漏 ~180MB 时**日志一片干净**（§9 第一条）。
  另一处外部写动作仍是 headless 通道的 Chrome 临时 profile（`%TEMP%\dsh-robust-<ts>`）。
- **读取的外部状态**：`$DSH_HOME/.credentials.yaml` 的 `TAVILY_API_KEY`（仅 `config.tavilyKey` 为空时兜底）。
- **失败面**：写失败——本插件无自有落盘；读失败（凭据文件缺失）→ `catch{}` 静默跳过（视为未配置）；网络失败/超时 → 抛错被 `safe()` 收成 `error` 字符串返回。

### 4.2 裁决（纯函数优先）
- `buildQueries({intent,keywords,lang,grammarBoost,site,filetype}) → string[]`：关键词为空 → `[]`；否则输出「原词/短语/核心词/问题式(+grammarBoost 语法变体)」去重后 **≤8** 条。
- `detectChallenge(html, status) → ChallengeType`：`429→rate-limit`；强特征词（`verifying your browser`/`just a moment`/`challenge-platform`/`不是机器人`/`拖动滑块` 等）全文命中 → `js-challenge`；`unusual traffic` 类 → `ip-block`；`security checkpoint` → `waf`；`403/202/503` 且头部含 captcha → `js-challenge`、含 `access denied` → `waf`；`≥400` 其余 → `unknown`；否则 `none`。
- `fetchRobust(url,{skipHeadless})`：命中条件 = `challenge === 'none' && text.length > 100`；四通道全失败 → `channel='failed'`（仍返回正文与轨迹，不抛）。

| 输入状态 | 裁决 | 理由 | 语义依据 |
|---------|------|------|---------|
| 无 tavilyKey/serperKey | `{ok:false,error:'未配置 X（Config）'}` | 显式拒绝优于静默空结果 | I5 |
| torStatus 不可达 | `fetch_tor` 抛「Tor 网络不可达（url）：请确认 WSL 内 tor 已启动」 | 失败必须说清**下一步动作** | §5 失败面 |
| 结果全空 | `{ok:true,count:0,results:[]}`（render 显示 `note/无结果`） | 空 ≠ 错 | I2 |

### 4.3 调用点清单 `[MUST]`

| 调用方 | 调用点（文件:符号） | 时机 |
|-------|------------------|------|
| cordis 组合 | `.dsh/profiles/web/cordis.patch.yml:166`（`id: agent-search-pro` / `name: dsh-search-pro` / `config.tavilyKey`，值不落文档） | web 启动装配 |
| cordis 装配 | `src/index.ts:apply(ctx, config)`（`export const inject = ['tools']`） | 插件挂载时 |
| 工具注册 | `src/index.ts:reg()` → `ctx.tools.register(defineTool(tool))` | `apply()` 内同步 23 次 |
| 我（模型/会话） | 23 个 `execute(args)`（`search_build_query` … `search_cache`） | 每次工具调用 |
| 缓存/配额 | `src/index.ts` 各 execute → `store.get/set/bump`（`src/store.ts:SearchStore`） | 每次工具调用 |
| 凭据兜底 | `src/index.ts:apply` → `readFileSync(join($DSH_HOME ?? ~/.dsh, '.credentials.yaml'))` 正则 `TAVILY_API_KEY` | 仅当 `config.tavilyKey` 为空 |
| WSL + Tor | `src/fetch.ts:fetchTor` / `src/fetch.ts:torStatus`（`wsl.exe -d Ubuntu -- bash -lc curl --socks5-hostname 127.0.0.1:9050`） | `fetch_tor` / `search_quota` |
| WSL curl（BTDig） | `src/share.ts:curlGet`（`-A 'Mozilla/5.0'`，绕 JA3 限流） | `search_share`（kind=magnet/all） |
| headless Chrome | `src/robust.ts:fetchHeadless`（`chrome.exe --headless=new --dump-dom --virtual-time-budget=10000`） | `fetch_robust` 前三通道均未命中时 |
| 密钥消费 | `src/index.ts` → `searchTavily/searchSerper/searchPatent/searchGithub/lookupDnsHistory/searchShodan` | 对应工具执行时 |
| **观测收口** | **`src/index.ts:reg()` 内层 `tracedExecute(tool)`** —— **23 个工具的唯一观测落笔点**（一个包装器覆盖全部工具面，见 §4.4） | 每次工具调用 |
| **轨迹落盘** | `src/index.ts:searchTrace(composeSearchEntry(…))` → `<DSH_HOME>/search-trace.jsonl`（boot 行 + 每调用一行） | `apply()` 装载 + 每次工具调用 |

### 4.4 自证轨迹契约（`<DSH_HOME>/search-trace.jsonl`）`[MUST]`

**动机**：本插件有 **23 个工具**，而每次调用的真实经过（走了哪个引擎 / **反爬通道链走到哪一级** /
聚合去重后剩多少条 / 耗时 / 断在哪一段）此前**只写 `ctx.logger`**，宿主 logger **不落盘**。
代价已实测：headless 清理缺陷泄漏 ~180MB **而日志全干净**（§9）——「降级到哪一级、哪一级失败了」当时完全不可见。

- **落盘路径**：`<DSH_HOME>/search-trace.jsonl`（`DSH_HOME` 环境变量优先，缺省 `<homedir>/.dsh`；
  解析走 `src/trace.ts:resolveHome` **单一真源**）。追加式 JSONL，一行一事件。
- **阶段枚举**（`SearchTracePhase`，闭集）：`boot`（`apply()` 进程级构建自报）→ `call`（任一工具的一次调用）。
- **行 schema**（字段固定，`boot` 行用中性值填充，`tail` 后可直接读列）：

  | 字段 | 含义 | 回答哪一问 |
  |------|------|-----------|
  | `atMs` | 写入时刻（ms epoch） | 时间线 join |
  | `phase` | `boot` / `call` | Q2 谁发起 |
  | `build` | `<version>@<模块 mtime ms>` | **Q1 线上跑的是哪个构建** |
  | `op` | 23 个工具名之一（boot 行为 `apply`） | **Q2 哪个工具** |
  | `params` | 参数摘要（**白名单 + 黑名单 + 脱敏 + 截断 200**） | Q2 输入侧 |
  | `count` | **聚合去重后的结果条数**（显式 `count` 优先） | **Q4 结果质量** |
  | `channel` | 反爬通道链**命中的级别**（`fetchRobust` 的 `channel`；未走该链为空串） | **Q3 降级到哪一级** |
  | `attempts` | 反爬通道尝试次数（走到了第几级） | **Q3** |
  | `durationMs` | 调用耗时（ms） | Q5 |
  | `ok` | 成功与否（`ok===false` 或非空 `error` 或抛错 → false） | Q3 |
  | `error?` | 工具 error 文案（**脱敏 + 截断 500**） | Q3 |

- **隐私红线（两层闸 + 一层脱敏）**：
  ① **白名单**（`SUBJECT_KEYS`：query/keywords/url/domain/term/site/board/channel/…）——
     **不在清单里的键根本不进摘要**（如 `pages`、`skipHeadless`）；这是**正面清单**，不是黑名单；
  ② **键名黑名单**（`SECRET_KEY_RE` = `/pass|secret|token|key|cookie|auth|credential|session|nonce|signature/i`）——
     即使白名单里日后加了敏感名也整键丢弃（**双保险**）；
  ③ 值再过 `redactText`（`Bearer`/`sk-`/`ghp_`/`AKIA`/≥32 位高熵串）。
  ⇒ **`search_leaks` 的 `password` 参数永不落盘**（§7 A16 尸体测试端到端验证）。
- **不变量**：① **`count` 不得被元数据数组污染**——`attempts`/`warnings`/`errors`/`queries`/`engines`
  等是元数据数组（`META_ARRAY_KEYS`），不是结果条数（**本批单测首跑抓到的真缺陷**，见 §9）；
  ② **观测绝不反噬主流程**：`appendTraceEntry` 全部 IO 失败吞错并返回 `false`；
     业务异常**原样重抛**；返回值**原样透出**（output.schema 是 `additionalProperties:false`，混入新字段即校验失败）；
  ③ **`channel` 取不到就空串**——不猜（该工具没走反爬链就是没走）。
- **调用点清单**：`src/index.ts:reg()` 内层 `tracedExecute(tool)` —— **唯一收口**。
  `reg` 是 23 个工具的唯一注册入口，故**一个包装器覆盖整个工具面**（不在 N 处手改——漏一处就是新盲区）。
  **新增工具只要走 `reg()` 就自动被观测**；绕过 `reg()` = 制造新的观测盲区。
  合成走 `src/trace.ts:composeSearchEntry`（纯函数，**实现与单测共用同一真源**）。
- **查询方式**：`tail -3 <DSH_HOME>/search-trace.jsonl`（最近三次调用的五问）。

## 5 · 边界与信任

- **能力边界 ≠ 沙箱**：工具面只声明「能做什么」；**不防**越权抓取、不防目标站封禁本机 IP、不防把不该搜的内容搜出来——授权与合规由调用者（我）承担。
- **不越界清单**：不绕过付费墙/登录认证（README 与 `fetch_robust`/`search_darkweb`/`search_code` 描述均写明）；`search_leaks` 只查单条密码、只传 SHA-1 前 5 位；`fetch_tor` 只读文本。
- **运行期外部依赖（非 npm 依赖）**：WSL2 Ubuntu + tor daemon（SOCKS5 `127.0.0.1:9050`）、Chrome/Edge 可执行文件（headless 通道）、`$DSH_HOME/.credentials.yaml`。——README 的「零运行时依赖」仅指 Node 包依赖，**不含**这三项。
- **失败面**：`safe()` 统一收口为 `{ok:false,error}`；凭据缺失静默跳过；Tor/headless 缺失给「怎么做」的提示；`SearchStore` 无上限保护（只清过期项）。

## 6 · 与既有机制的关系

- **组合变更纪律（AGENTS.md §5.11）**：改本插件源码 = 改组合 → 重启前必须 `preflight_check`（判据：产物 mtime vs web 进程启动时间）。
- **热重载/守护**：`plugin-mount` → 哨兵 `.hot-reload-flag` → 守护预检 → kill+重启 → 唤醒；重启原语 `daemon_restart`（watch 侧归主人）。
- **语义文档系统（§5.20）**：本文是该能力的主副本；§7 的 `pending` 计入注册表 `acceptance.pending`（`semantic_check` D1–D6）。
- **与 `dsh-red-team` 的关系**：两者共用「crt.sh 子域枚举」语义但**各自实现**（`dsh-search-pro/src/deep.ts:enumSubdomains` 有 certspotter 兜底；`dsh-red-team/src/enum.ts:enumSubdomains` 无）——**不是同语义副本**，无主副本归属问题，但结论可能不一致。

## 7 · 可证伪验收清单

| # | 可证伪命题 | 证据（单测名/命令/日志行/HTTP） | 状态 |
|---|-----------|------------------------------|------|
| A1 | 工具面恰为 23 个 | `Select-String src/index.ts -Pattern "^\s*name: '(search\|fetch\|archive\|lookup\|enum)_"` 计数 = 23 | 已实测（2026-09-14） |
| A2 | `apply()` 不抛且注册 23 工具 | `node scripts/apply-test.mjs` 输出 `REGISTERED: 23` | 待验收 |
| A3 | 真实 execute 返回值过 schema | `node scripts/schema-test.mjs` 输出 `validate violations: NONE` | 待验收 |
| A4 | 缺 key 时显式拒绝（非静默） | 无 key 调 `search_shodan` → `{ok:false,error:'未配置 shodanKey（Config）'}` | 待验收（源码判据 §4.2） |
| A5 | 缓存命中不重复出网 | 同参二次 `search_web` → `search_quota` 同名通道计数不增 | 待验收 |
| A6 | 缓存/配额不落盘（重启即清） | 重启 web 后 `search_cache action=list` → 0 条 | 待验收 |
| A7 | 反爬轨迹可读 | `fetch_robust` 结果 note 含 `通道: <channel> · 反爬诊断: <type>` 且 `尝试: fingerprint=… → prewarm=…` | 待验收 |
| A8 | Tor 不可达时显式报错且不挂起 | `fetch_tor` 返回含 `Tor 网络不可达（`；`search_quota` 显示 `Tor ❌` | 待验收 |
| A9 | 线上跑的是当前构建 | `(Get-Item lib/index.js).LastWriteTime = 2026-09-06T18:14:31` 晚于 `src/index.ts`（18:14:21），早于 web 进程启动（2026-09-14 10:05:47） | 已实测（2026-09-14） |
| A10 | 产物无裸 `require(`（ESM 契约） | `npm test` → `tests/esm-contract.test.mjs` 断言 `lib/**/*.js` 无裸 `require(` 调用；**已取得尸体**：未重建的旧产物上该测试失败 | 已实测（2026-09-14，20/20 pass） |
| A11 | 纯函数与失败路径有守卫 | `npm test` → `tests/util.test.mjs` 20 例全过；含非法编码/非法 URL/空值/类型不符等退化输入 | 已实测（2026-09-14） |
| A12 | 每次工具调用落一行自证轨迹（五问可一条命令答） | `npm test` → `tests/trace.test.mjs:离线组合` 真写出三行；线上：`tail -3 $DSH_HOME/search-trace.jsonl` 可读 `build/op/params/count/channel/attempts/durationMs/ok` | **待线上验收**（离线已锁；本批不部署，由派发者统一部署） |
| A13 | **反爬通道链走到哪一级可查**（A7 的机器版） | `npm test` → `channelOf`/`attemptsOf` 直取与嵌 `results[]` 两级 + 取不到→空串（不猜）；离线组合断言 `channel='headless'`、`attempts=3` | **已实测（离线）** |
| A14 | **`count` = 聚合去重后条数，不被元数据数组污染** | `npm test` → `resultCount`：显式 `count` 优先；**`{attempts:[a,b,c]}` → 0**（真缺陷回归，实证样本 = `fetch_robust` 返回体）；`warnings` 跳过；`NaN` 不算合法 count | **已实测** |
| A15 | 观测绝不反噬主流程（IO 失败不抛） | `npm test` → `尸体测试：父路径是普通文件 → 返回 false 且不抛`（`assert.doesNotThrow` + `=== false`） | **已实测** |
| A16 | **`search_leaks` 的 `password` 永不落盘**（隐私红线端到端） | `npm test` → `隐私尸体测试端到端`：喂 `{password:'hunter2secret'}` → 断言 `params === ''`；喂 `apiKey`/`token` → 断言摘要里不含键名；喂 error 含 `Bearer <32位>` → 断言落盘原文 `includes(secret) === false`（逐个）；且 `[redacted]` 确实出现、非敏感参数 `query=爱丽丝` 仍可读 | **已实测** |
| A17 | 观测覆盖全部 23 工具（无旁路） | 收口在 `reg()` 内层——**23 个工具的唯一注册入口**，故覆盖率为工具数本身；新增工具只要走 `reg()` 即被观测（§4.4 调用点清单） | **待线上验收**（覆盖率由构造保证，非逐点登记） |

**生效判据**：① `pnpm build`（`tsc -p tsconfig.json`）后 `lib/*.js` mtime 必须晚于对应 `src/*.ts`；② web 进程启动时间必须晚于 `lib/index.js` mtime（旧实例跑旧代码 = 未生效）；③ 行为判据：`search_quota` 能答且工具出现在工具面即装配成功。
**回退**：① 源码级——`git -C self-plugins/dsh-search-pro revert <commit>`（当前 HEAD `b5c5a20`）后重新 build + `preflight_check` + `daemon_restart`；② 配置级——`plugin_stop dsh-search-pro` / 从 cordis.patch.yml 移除 `agent-search-pro` 行 → 哨兵重启；③ 运行期——`search_cache action=clear` 清缓存（不涉及代码回退）。

## 8 · 与实现的关系

- **主实现与模块职责**：`src/index.ts`（装配 + 23 工具 + 渲染器 `renderList/renderContent/renderShare`）；`engines.ts` 多引擎与聚合｜`deep.ts` 学术/专利/GitHub/社区/WHOIS/子域/DNS/Shodan｜`robust.ts` 四通道反爬 + `detectChallenge`｜`share.ts` 网盘 + 磁力三源｜`osint.ts` Sourcegraph/Ahmia/HIBP｜`archive.ts` Wayback CDX/还原/archive.today｜`fetch.ts` Jina→自抓降级 + Tor｜`buildQuery.ts` 查询改写｜`store.ts` 内存缓存/配额｜`util.ts` HTTP/HTML/URL/去重｜**`trace.ts` 自证轨迹层**（`resolveHome`/`paramsDigest`/`resultCount`/`resultOk`/`channelOf`/`attemptsOf`/`errorOf`/**`composeSearchEntry`**（合成单一真源）+ 薄 IO，2026-09-14 批次 S4-A 新增）。
- **测试**：`tests/util.test.mjs`（20）+ `tests/esm-contract.test.mjs`（既有 ESM 契约守卫）+ `tests/trace.test.mjs`（**20**，批次 S4-A 新增）= **40 例**，`npm test` 一条命令复跑。
- **同语义副本**：无（无跨仓平行语义）。
- **未实现/未验证**：`archive.ts:archiveTodayLookup` **已实现但未接入任何工具**（死代码）；README 提到的 SearXNG 增强**未实现**；`community` 的 `tieba` 平台仅在类型里（`CommunityPlatform`），`COMMUNITY_PLATFORMS` 与工具 enum 均只含 `reddit/hn/4chan`。

## 9 · 实践修订记录

- **2026-09-14 · ESM 契约缺陷（headless 临时 profile 泄漏 ~180MB，已修 + 加机器守卫）**
  - **症状**：headless 通道每次调用泄漏一个 `%TEMP%\dsh-robust-<ts>` 目录（实测 **15 个**，每个约 **12MB**），日志毫无异常。
  - **根因**：本包 `type=module` + tsconfig `module:NodeNext` ⇒ 产物是纯 ESM，但 `src/robust.ts` 的清理写了 `require('node:fs')`——ESM 下 `require` 未定义 → 抛错被 `catch { /* 忽略 */ }` **静默吞掉**。**「清理失败的静默」伪装成了「已清理」。**
  - **修复**：改顶部静态 `import { rmSync } from 'node:fs'`；§10 的 U1 由此闭环。
  - **语义被补充（新不变量）**：**产物不得出现裸 `require(` 调用**——本包是 ESM，任何历史 CJS 写法都会在运行期抛错并被自身 try/catch 吞掉。由 `tests/esm-contract.test.mjs` 机器守卫；**尸体测试**：未重建的旧产物上该测试确实失败（已实测），重建后通过。
  - **语义被补充（测试面）**：`tests/util.test.mjs` 20 例覆盖 `stripTags`/`htmlToText`/`decodeDdgUrl`/`decodeBingUrl`/`normalizeUrl`/`dedupe`/`str`/`num` 的正常路径 + **失败/退化路径**（非法百分号编码、非法 URL、空值、类型不符）。
  - **教训一（写测试的纪律）**：首版把 `decodeDdgUrl` 的失败路径断言成「原串原样返回」——实测是「非法编码 → `decodeURIComponent` 抛错 → 落入协议补全分支 → `//` 补成 `https://`」。**测试必须编码意图行为，不是猜测行为**；断言失败先判「代码错还是预期错」。
  - **教训二（回写技能 `plugin-maintainability`）**：`catch { /* 忽略 */ }` 是缺陷温床——**静默兜底必须配一条「它真的兜住了吗」的观测**，否则失败被伪装成成功。

- **2026-09-14 · 批次 S4-A：自证轨迹层（观测层新增，业务行为零变更）+ 抓到 1 个真缺陷**
  - **语义被补充（新不变量 ①）**：**元数据数组不是结果条数**。`fetch_robust` 的返回体带 `attempts[]`
    （通道尝试记录）却**没有** `results`；「取第一个数组属性」的朴素实现会把「4 次通道尝试」报成
    「4 条结果」——**Q4 读数被污染，而且它看起来完全合理**（这正是这类缺陷危险的地方）。
    修法：`META_ARRAY_KEYS = attempts/warnings/errors/notes/queries/engines/logs/trace` 显式排除。
    **发现方式**：单测首跑红（`composeSearchEntry` 的 `count` 期望 0、实际 2）⇒ 判为**代码错**（不是预期错），
    修代码 + 留回归用例（A14）。**这就是「测试抓到真缺陷」而不是「测试迎合实现」的样子。**
  - **语义被补充（新不变量 ②）**：**观测覆盖必须由构造保证，不靠逐点登记**。23 个工具的收口在
    `reg()` 内层——一个包装器覆盖整个工具面。反面教训来自本仓 §4.3 那种「逐点列调用点」的写法：
    漏一处就是新盲区，而**漏掉的那一处永远不会自己报错**。
  - **语义被补充（隐私两层闸）**：把「凭据不落盘」从承诺升级为**双闸构造**——白名单（正面清单）+
    键名黑名单（`/pass|secret|token|key|cookie|auth|…/i`，即使日后误加进白名单也整键丢弃）+ 值脱敏。
    直接回应 **U4**（`search_leaks` 明文口令）：**轨迹侧已确认永不落盘**（A16 端到端尸体测试）；
    会话事件流侧仍是开放的（那是「模型可见 ⟺ 已记录」的范畴，见 §10 U4 更新）。
  - **语义被修正（原文档的判据升级）**：A7「反爬轨迹可读」原先只能靠**读结果 note 文本**（人眼）；
    现在 `channel`/`attempts` 成了**结构化字段**，可 `grep`/聚合（「哪一级最常命中」「哪一级最常失败」）。
  - **行为变更清单**：**无**——`reg()` 只把每个工具对象**浅拷贝 + 替换 `execute`**；
    包装器返回值原样透出、业务异常原样重抛。`git diff` 核对：`src/index.ts` 的改动仅「导入 + `reg` 定义替换」，
    **23 个工具定义体一行未动**。

- **2026-09-14 补课：本插件此前无语义文档（可维护性工程）**
  - 语义**被确认**：23 工具、`inject=['tools']`、`SearchStore` 全内存态、输出外壳 `{ok,count,results}`。
  - 语义**被补充**：7 条有缓存的键清单、`.credentials.yaml` 兜底路径与匹配式、WSL/Tor/Chrome 三个运行期外部依赖、`archiveTodayLookup` 为未接入死代码。
  - 语义**被修正**：README「零运行时依赖（Node 原生 fetch + WSL curl）」易被误读为「无外部依赖」——本插件**强依赖** WSL2 curl / tor daemon / Chrome（headless），已在本节与 §5 显式化。
  - 教训（回写技能 `semantic-doc-first`）：文档的「依赖」一节必须区分 **npm 依赖** 与 **运行期外部依赖**（进程/守护/可执行文件），否则语义文档会给出「能跑」的错误信心。

## 10 · 未决问题

- **U2 缓存淘汰只清过期项**：`set()` 在 `size > 500` 时仅删 `expiresAt` 已过的键；高活跃会话可超 500 条常驻。
- **U3 `SearchStore` 作用域**：实例在 `apply()` 内创建——单 web 进程内多会话是否共享同一实例（→ 缓存/配额是否跨会话串味）待实测确认；确认后回写本节。
- **U4 `search_leaks` 与「凭据不落盘」纪律的张力（2026-09-14 批次 S4-A 部分闭环）**：明文密码作为工具参数
  必然进入会话事件流（模型可见 ⟺ 已记录）。**轨迹侧已闭环**：`password` 既不在 `SUBJECT_KEYS` 白名单、
  又命中 `SECRET_KEY_RE` 黑名单，**永不落盘**（§7 A16 端到端尸体测试）。
  **仍未闭环的是会话事件流侧**——那是 append-only 记录的固有属性，不由本插件控制。
  倾向：文档明示「只查一次性的自查口令，禁止查主人真实在用的口令」。
- **U5（新，2026-09-14 批次 S4-A）缓存命中在轨迹里不可见**：`search_web` 等 7 个工具的缓存
  `store.get(ck)` **藏在各自 `execute` 内部**，而观测收口在 `execute` **外层**——命中时 `count` 有值、
  `durationMs` 极小，但**没有 `cacheHit` 字段**（要靠「耗时异常小」推断，属间接证据）。
  为何不修：加字段需在 7 处 execute 内部埋点（违反「单点收口」），或给缓存返回值加标记
  （**改业务返回形状**，output.schema 是 `additionalProperties:false`，会被校验拒收）。
  倾向：若日后确需，用「`store` 暴露 `hits` 计数、包装器前后取差」实现——**零业务改动且仍是单点**。
  需裁决是否本轮补。
- **U6（新，2026-09-14 批次 S4-A）轨迹文件无轮转**：`search-trace.jsonl` 为纯追加，无上界。
  本插件调用频率**最高**（23 工具 + 多引擎翻页，单轮可达数十次），是四个 S4-A 插件里最需要上限的一个。
  倾向：按 `dsh-plugin-bootreport` 的「有界裁剪（`keepLines + 50`）」加上限，断言写「有界」而非「恰好等于」。
  需裁决是否本轮补。

## 附 · 快速取证命令

```bash
# Q1–Q5 一条命令（最近三次调用）
tail -3 "$DSH_HOME/search-trace.jsonl"
# 反爬链：各通道命中分布（哪一级最常兜住）
grep -o '"channel":"[a-z]*"' "$DSH_HOME/search-trace.jsonl" | sort | uniq -c | sort -rn
# 失败笔次（Q3 断点 + 原事故的可观测面：日志干净但轨迹不干净）
grep '"ok":false' "$DSH_HOME/search-trace.jsonl" | tail -5
# 按工具聚合耗时（Q5：哪个工具最贵）
grep -o '"op":"[a-z_]*"\|"durationMs":[0-9]*' "$DSH_HOME/search-trace.jsonl" | paste - - | sort -t: -k3 -rn | head -5
```
