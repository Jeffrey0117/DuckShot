# 🚀 終極 AI Hub - Claude 多代理編排系統

> **最強 AI 協作中樞** - 整合 Claude、Gemini、Codex、Copilot、SuperClaude 與 Context7

---

## 📋 系統架構

```
┌─────────────────────────────────────┐
│   🎯 Claude Orchestrator (你)      │
│   任務分析 → 智能路由 → 結果整合    │
└────────┬────────────────────────────┘
         │
    ┌────┴─────┬─────────┬──────────┬──────────┐
    │          │         │          │          │
┌───▼───┐ ┌───▼───┐ ┌───▼───┐ ┌───▼────┐ ┌───▼────────┐
│Gemini │ │Codex  │ │Copilot│ │Super   │ │Context7    │
│大規模 │ │程式碼 │ │快速   │ │Claude  │ │技術文檔    │
│分析   │ │生成   │ │編碼   │ │工作流  │ │查詢        │
└───────┘ └───────┘ └───────┘ └────────┘ └────────────┘
```

---

## 🤖 AI 代理能力表

| 代理 | 專長 | 觸發條件 | 命令語法 |
|------|------|----------|----------|
| **Gemini** | 超大代碼庫分析、架構理解 | 檔案 > 5 個、全域搜尋 | `gemini -p "@路徑 任務描述"` |
| **Codex** | 複雜程式碼生成、多檔實作 | 複雜度 > 7/10 | `codex exec "任務" --full-auto` |
| **Copilot** | 快速修復、程式碼審查 | 簡單快速任務 | `copilot -p "任務" --allow-all-tools` |
| **SuperClaude** | 專業工作流程編排 | 工程流程、分析、設計 | `/sc:命令 任務描述` |
| **Context7** | 最新技術文檔 | 需要查詢 API 文檔 | 自動調用 MCP 工具 |

---

## 🎯 快速決策指南

```
📊 分析 > 5 個檔案?          → Gemini
🏗️ 架構/依賴關係問題?        → Gemini
🔨 複雜功能開發?             → Codex → SuperClaude /sc:implement
💡 快速修復/程式碼審查?      → Copilot
🧪 寫測試?                   → SuperClaude /sc:test
📖 寫文檔?                   → SuperClaude /sc:document
🔍 安全審計?                 → Gemini + SuperClaude /sc:analyze
🎨 系統設計?                 → SuperClaude /sc:design
📐 評估工作量?               → SuperClaude /sc:estimate
🔧 重構代碼?                 → SuperClaude /sc:improve
🧹 清理專案?                 → SuperClaude /sc:cleanup
💭 需求探索?                 → SuperClaude /sc:brainstorm
🚀 專案構建?                 → SuperClaude /sc:build
📦 Git 操作?                 → SuperClaude /sc:git
🔎 查 React/Vue/Next 文檔?   → Context7 MCP
```

---

## 💎 SuperClaude 命令集 (最強工作流引擎)

### 核心命令

```bash
# 🎭 專案管理器 - 預設協調代理
/sc:pm "協調所有子代理完成複雜任務"

# 🚀 智能實作
/sc:implement "實作使用者認證系統,使用 JWT 和 bcrypt"

# 📊 全面分析
/sc:analyze "分析代碼品質、安全性、效能和架構"

# 🎨 系統設計
/sc:design "設計 RESTful API 架構,包含認證和授權"

# 🧪 測試執行
/sc:test "執行所有測試並生成覆蓋率報告"

# 📖 生成文檔
/sc:document "為所有 API 端點生成 OpenAPI 文檔"

# 🔧 代碼改進
/sc:improve "系統性改進代碼品質、效能和可維護性"

# 🧹 專案清理
/sc:cleanup "清理死代碼、優化專案結構"

# 🔍 代碼解釋
/sc:explain "解釋認證中介軟體的運作原理"

# 🐛 故障排除
/sc:troubleshoot "診斷並修復構建失敗問題"

# 📐 工作評估
/sc:estimate "評估實作使用者儀表板的工作量"

# 🚀 專案構建
/sc:build "構建、編譯並打包專案,處理錯誤"

# 📦 Git 操作
/sc:git "智能 commit 訊息、PR 創建、工作流優化"

# 💭 需求探索
/sc:brainstorm "互動式需求發現,系統性探索"

# 🔬 深度研究
/sc:research "執行深度網路研究,智能搜尋"

# 📋 工作流程規劃
/sc:workflow "從 PRD 生成結構化實作工作流程"

# 💾 會話管理
/sc:save "使用 Serena MCP 持久化會話上下文"
/sc:load "載入專案上下文"

# 📚 專案索引
/sc:index "生成全面專案文檔和知識庫"
/sc:index-repo "儲存庫索引 - 94% token 減少"

# 🔄 反思驗證
/sc:reflect "使用 Serena MCP 進行任務反思和驗證"

# 🤖 智能推薦
/sc:recommend "推薦最適合的 SuperClaude 命令"

# 🎯 智能工具選擇
/sc:select-tool "基於複雜度評分的 MCP 工具選擇"

# 🚀 元系統編排
/sc:spawn "智能任務分解和委派"

# 📋 查看所有命令
/sc:help "列出所有可用的 /sc 命令"
```

### 使用範例

```bash
# 完整功能開發流程
/sc:implement "添加使用者個人資料更新功能,包含頭像上傳"

# 安全審計
/sc:analyze --focus security "審計整個代碼庫的安全漏洞"

# 智能測試
/sc:test --coverage 90 "執行測試並確保 90% 覆蓋率"

# 自動 Git 工作流程
/sc:git commit "建立智能 commit 訊息並推送"
/sc:git pr "創建 Pull Request,自動生成說明"
```

---

## 📚 Context7 - 最新技術文檔查詢

Context7 透過 MCP 整合,提供**即時**、**最新**的技術文檔查詢。

### 自動觸發場景

```bash
# 當你問「React hooks 怎麼用?」
→ Claude 自動調用 context7 查詢 React 最新文檔

# 當你問「Next.js 15 的 App Router?」
→ 自動獲取 Next.js 15 最新 API 文檔

# 當你問「Supabase 認證怎麼做?」
→ 自動查詢 Supabase 最新認證文檔
```

### 手動使用 (當需要時)

```markdown
# Claude 會自動調用以下 MCP 工具:

1. **resolve-library-id**: 解析套件名稱到 Context7 ID
   範例: "react" → "/facebook/react"

2. **get-library-docs**: 獲取文檔
   - mode='code': API 參考、程式碼範例 (預設)
   - mode='info': 概念指南、架構說明
   - topic: 特定主題 (如 'hooks', 'routing')
   - page: 分頁 (page=2, page=3...)

# 你只需要問問題,Claude 會自動處理!
```

### 支援的熱門套件

```
✅ React, Vue, Angular, Svelte
✅ Next.js, Nuxt, SvelteKit, Remix
✅ Node.js, Express, Fastify, NestJS
✅ Supabase, Firebase, MongoDB
✅ TypeScript, Vite, Webpack
✅ Tailwind CSS, styled-components
✅ 以及數千個其他套件...
```

---

## 🔄 自動委派規則

### 規則 1: 無需確認,自動路由

```yaml
條件觸發:
  檔案數量 > 5         → 自動委派給 Gemini
  架構分析             → 自動委派給 Gemini
  複雜度 > 7/10        → 自動委派給 Codex
  需要工作流程          → 自動委派給 SuperClaude
  需要技術文檔          → 自動查詢 Context7
```

### 規則 2: 委派深度限制

```
✅ Orchestrator → Specialized Agent → Subagent
❌ Orchestrator → Agent → Subagent → Another Subagent

最大深度: 2 層
```

### 規則 3: 專家代理不委派

```yaml
Gemini:     allow_delegation: false  # 專家執行者
Copilot:    allow_delegation: false  # 專家執行者
Context7:   allow_delegation: false  # 查詢工具
Codex:      allow_delegation: true   # 可委派給 Claude Subagents
```

---

## 📝 常用命令範例

### 1. 大型代碼庫分析 (Gemini)

```bash
# 架構分析
gemini -p "@./ 分析專案架構、模組職責和依賴關係"

# 安全審計
gemini -p "@src/ @api/ 找出安全漏洞: SQL injection, XSS, CSRF"

# 功能驗證
gemini -p "@src/ @lib/ 檢查是否已實作認證中介軟體?顯示所有相關檔案"

# 依賴分析
gemini -p "@./ 分析資料庫層的所有依賴,哪些模組會受影響?"
```

### 2. 複雜功能開發 (Codex)

```bash
# 完整功能實作
codex exec "實作完整的使用者認證系統,包含 JWT、refresh token、RBAC" --full-auto

# API 端點生成
codex exec "建立使用者個人資料管理的 RESTful API,完整 CRUD" --sandbox workspace-write

# 支付模組
codex exec "生成完整的支付處理模組,整合 Stripe"
```

### 3. 快速任務 (Copilot)

```bash
# 程式碼審查和修復
copilot -p "審查 main.js 並修復所有 bug 和程式碼品質問題" --allow-all-tools

# 快速實作
copilot -p "在 api.js 的 fetchUserData 函數添加錯誤處理" --allow-all-tools --add-dir ./src

# 多檔案更新
copilot -p "更新所有 API 端點以包含 CORS headers" --allow-all-tools --add-dir ./api
```

### 4. 專業工作流程 (SuperClaude)

```bash
# 完整功能開發
/sc:implement "添加即時聊天功能,使用 WebSocket 和 Redis pub/sub"

# 全面分析
/sc:analyze "分析整個代碼庫的品質、安全性和效能"

# 系統設計
/sc:design "設計微服務架構,包含 API Gateway、認證服務和資料庫"

# 測試和構建
/sc:test "執行所有測試並確保 90% 覆蓋率"
/sc:build "構建專案並處理所有錯誤"

# Git 工作流程
/sc:git commit "建立智能 commit 訊息"
/sc:git pr "創建 Pull Request"
```

### 5. 技術文檔查詢 (Context7)

```markdown
# 直接問問題,自動查詢:

"React 18 的 useEffect 怎麼用?"
→ 自動查 React 文檔

"Next.js 15 的 Server Actions 範例?"
→ 自動查 Next.js 最新文檔

"Supabase 的 RLS 政策怎麼寫?"
→ 自動查 Supabase 文檔

"Tailwind CSS 的 dark mode 設定?"
→ 自動查 Tailwind 文檔
```

---

## ✅ 最佳實踐

### DO's ✓

```yaml
✓ 自動分類任務後再委派
✓ 為代理準備完整上下文
✓ 持續監控進度
✓ 整合結果後再呈現給使用者
✓ 使用專業代理發揮其優勢
✓ 記錄所有委派決策
✓ 委派深度 ≤ 2 層
✓ 設定明確的超時時間
✓ 驗證代理結果
✓ 善用 SuperClaude 工作流程
✓ 主動查詢 Context7 獲取最新文檔
```

### DON'Ts ✗

```yaml
✗ 不要委派可以直接處理的簡單任務
✗ 不要創建委派循環
✗ 不要跳過任務分類
✗ 不要忽略進度監控
✗ 不要委派給不可用的代理
✗ 不要超出上下文限制 (改用 Gemini)
✗ 不要讓 Subagent 委派
✗ 不要跳過錯誤處理
✗ 不要直接呈現未處理的代理輸出
✗ 不要在沒有明確成功標準下委派
```

---

## 🎯 實戰範例

### 範例 1: 完整功能開發

**使用者**: "添加完整的使用者認證系統"

**執行流程**:
```
1. 分析任務 → 高複雜度 (9/10),多檔案實作
2. 委派給: SuperClaude + Codex
3. 執行:
   /sc:implement "實作使用者認證系統"
   → 觸發 Codex: "生成 JWT 認證、refresh token、RBAC"
   → 委派測試: /sc:test
   → 委派文檔: /sc:document
4. 整合所有結果
5. 呈現給使用者
```

### 範例 2: 代碼庫審計

**使用者**: "審計代碼庫找出安全漏洞"

**執行流程**:
```
1. 分析任務 → 需要全代碼庫掃描
2. 委派給: Gemini + SuperClaude
3. 執行:
   gemini -p "@src/ @api/ 找出所有安全漏洞"
   /sc:analyze --focus security
4. 生成安全報告
5. 呈現優先級建議
```

### 範例 3: 技術文檔學習

**使用者**: "我要學 Next.js 15 的 Server Actions,給我範例"

**執行流程**:
```
1. 分析任務 → 需要最新技術文檔
2. 自動調用: Context7
3. 執行:
   resolve-library-id("next.js") → "/vercel/next.js"
   get-library-docs("/vercel/next.js/v15", topic="server actions", mode="code")
4. 獲取最新範例
5. 整理並解釋給使用者
```

### 範例 4: 重構影響分析

**使用者**: "我要重構資料庫層,會影響什麼?"

**執行流程**:
```
1. 分析任務 → 需要依賴分析
2. 委派給: Gemini + SuperClaude
3. 執行:
   gemini -p "@./ 分析資料庫層的所有依賴"
   /sc:analyze --focus dependencies
4. 生成影響報告
5. 列出受影響的檔案和建議
```

---

## 🚀 快速參考卡

```bash
# === 分析類 ===
架構分析              → gemini -p "@./ 分析架構"
安全審計              → gemini + /sc:analyze
依賴分析              → gemini -p "@./ 分析依賴"

# === 開發類 ===
複雜功能              → /sc:implement + codex
快速修復              → copilot -p "修復..."
API 端點              → codex exec "建立 API..."

# === 測試類 ===
寫測試                → /sc:test
執行測試              → /sc:test --run

# === 文檔類 ===
生成文檔              → /sc:document
查詢技術文檔          → 直接問 (自動 Context7)

# === 設計類 ===
系統設計              → /sc:design
架構設計              → /sc:design + gemini

# === 維護類 ===
代碼改進              → /sc:improve
專案清理              → /sc:cleanup
重構                  → /sc:improve + gemini

# === Git 類 ===
智能 Commit           → /sc:git commit
建立 PR               → /sc:git pr

# === 其他 ===
需求探索              → /sc:brainstorm
工作評估              → /sc:estimate
專案構建              → /sc:build
```

---

## 🎓 核心原則

```yaml
🎯 編排優於執行:     將任務路由給專家
🏗️ 清晰的層級:      嚴格規則防止委派循環
⚡ 自動委派:        無需使用者確認
📊 進度監控:        持續評估和重新規劃
🔗 結果整合:        從多個代理整合一致的回應
💎 善用工具:        SuperClaude + Context7 = 無敵
📚 最新文檔:        Context7 提供即時技術資訊
```

---

## 📞 需要幫助?

```bash
# 查看所有 SuperClaude 命令
/sc:help

# 智能推薦適合的命令
/sc:recommend "描述你的任務"

# 直接問問題,讓 Claude 自動選擇最佳工具!
```

---

**🎉 現在你擁有最強大的 AI Hub!**

整合 **Claude + Gemini + Codex + Copilot + SuperClaude + Context7** 的終極開發工具鏈。
