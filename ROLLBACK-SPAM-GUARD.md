# 回退文档 · 反刷屏守卫（Spam Guard）

> 改动前基线：`506d80d`（2026-09-22，`feat: switch AI gateway to OpenAI-compatible endpoint...`）
> 改动时间：2026-10-31
> 项目：`discord-mod-tracker`（本地目录 `~/WorkBuddy/Juliet-s-assistant`）

---

## 一、这次改了什么

### 新增文件（2 个）

| 文件 | 作用 |
|---|---|
| `src/guard.js` | 守卫主体：判定、处置、私信报告 |
| `scripts/guard-test.js` | 离线自检，52 项断言，不连 Discord |

### 修改文件（3 个，均为纯增量）

| 文件 | 改动位置 | 内容 |
|---|---|---|
| `src/config.js` | 文件中部 | 新增 `listOr()` 辅助函数、守卫默认值常量、`config.guard` 配置块 |
| `src/config.js` | `printConfigSummary()` | 多打印一行「反刷屏守卫」配置 |
| `src/index.js` | 顶部 import | 多一行 `import { handleGuardMessage } from './guard.js';` |
| `src/index.js` | `COMMAND_HANDLERS` 之前 | 新增一段独立 `MessageCreate` 监听器（约 10 行，含注释块） |
| `package.json` | `scripts` | `syntax` 增加 2 个文件的语法检查；新增 `guard-test` 命令 |

**既有逻辑零改动**：原来的消息记录监听器、`/check` 等 5 个命令、HTTP 服务、清理任务全部未动。

---

## 二、三层回退

### 第 1 层：紧急关闭（秒级，最推荐）

在 Render 的 Environment 里加一个变量：

```
GUARD_ENABLED=off
```

保存后 Render 会自动重启，守卫立刻停止工作，**其他功能完全不受影响**。
想恢复就删掉这个变量，或者改成 `on`。

判别方法：启动日志里那行会变成
`反刷屏守卫    : 关（GUARD_ENABLED=off）`

---

### 第 2 层：代码移除（彻底干净）

```bash
cd ~/WorkBuddy/Juliet-s-assistant

# 1) 删两个新增文件
rm src/guard.js scripts/guard-test.js

# 2) 删 index.js 里的 import 行
#    搜索 "handleGuardMessage" 会命中两处，都删掉：
#    - 顶部 import
#    - "反刷屏守卫（新增，独立监听器）" 那段监听器整块

# 3) 删 config.js 里的守卫配置
#    - listOr() 函数
#    - GUARD_DEFAULT_* 三个常量
#    - config.guard { ... } 整块
#    - printConfigSummary 里那行「反刷屏守卫」

# 4) package.json 里去掉 syntax 的两个 --check 和 guard-test 命令

# 5) 验证
npm run syntax && npm start
```

---

### 第 3 层：Git 层面回退（如果已经 commit）

```bash
cd ~/WorkBuddy/Juliet-s-assistant

# 还没 push：
git reset --hard 506d80d

# 已经 push：
git revert <这次提交的 hash>     # 生成一个反向提交，历史保留
git push origin main
```

---

## 三、部署后验证清单

| 步骤 | 做什么 | 预期 |
|---|---|---|
| 1 | 看启动日志 | 出现「反刷屏守卫 : 开 · 频道 … · 阈值 >=500 字符」 |
| 2 | 用**普通测试号**在监控频道发 500 个字符 | Juliet 收到 2 条私信；该账号被**禁言 7 天**、这条消息被删，**不封禁** |
| 3 | 发**正好 499 个字符** | 无任何动作（阈值含等于，500 才触发） |
| 4 | 用**管理员**发 2000 个字符 | 无任何动作（豁免） |
| 5 | 在**非监控频道**发长文 | 无任何动作 |
| 6 | 用**普通测试号**在 5 分钟内发 3 条各 340 字符（合计 1020） | 第 3 条触发刷屏规则；**这 3 条全部被删** + 禁言 7 天；Juliet 收到 2 条私信 |
| 7 | 同上但只发 2 条各 480 字符（合计 960） | 无任何动作（条数必须 >2 才触发） |
| 8 | 用**带 premium 角色的账号**发 500 个字符 | 与普通成员完全一样：禁言 7 天 + 删消息，**不再特殊处理** |

日志关键字：`[守卫] 触发：`、`[守卫] 已禁言`、`[守卫] 私信报告人 ... 失败`。

---

## 四、上线前必须确认的权限

机器人角色需要：**Moderate Members**、**Manage Messages**，
且**角色位置高于被处置成员**。缺任何一项，处置会失败，但不会静默
—— 私信里会明确写 `FAILED (manual action needed)`，日志里也有 `[守卫] 禁言 xxx 失败`。

> **Ban Members 已不再需要**：本功能不再封禁任何人。

---

## 五、已知行为与限制

1. **窗口存在内存里**，重启即清空 → 只会漏判，不会误判。
2. **禁言可撤销，封禁不可**：本版只禁言 7 天，不封禁；被删的那批消息**不可恢复**（Discord 无回收站）。
3. **禁言不等于踢出**：成员仍在服务器里，只是 7 天内不能发言；**若他在这期间主动退出再重新加入，禁言会失效**（这是禁言相较封禁的固有弱点）。
4. **`mod` 角色不豁免**：只豁免服务器所有者、Administrator 权限、`GUARD_ADMIN_ROLE_IDS`。
   如果希望 mod 也豁免，把角色 ID 填进 `GUARD_ADMIN_ROLE_IDS` 即可，无需改代码。
5. **冷却 10 分钟**：处置后（含处置失败）该成员在冷却期内不再被处置，避免刷爆报告人私信。
6. 报告私信为**英文**（与该仓库「命令 UI 一律英文」的既有约定保持一致）。
