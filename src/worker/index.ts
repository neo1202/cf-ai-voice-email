import { Hono } from 'hono';
import type { Context, Next } from 'hono';
// 使用 Hono，並綁定 Env 類型
const app = new Hono<{ Bindings: Env }>();
const setCoopCoepHeaders = async (c: Context, next: Next) => {
    c.res.headers.set('Cross-Origin-Opener-Policy', 'same-origin');
    c.res.headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
    return next();
};

// 1. 將中介軟體套用在所有路由之前
app.use(setCoopCoepHeaders);
// 設置一個路由來處理所有 /chat/:sessionId 的請求
app.all('/chat/:sessionId', async (c) => {
    
    // --- 新增日誌 ---
    console.log(`[Worker] 收到請求: ${c.req.method} ${c.req.url}`);

    // 1. 從 URL 參數中取得 sessionId
    const sessionId = c.req.param('sessionId');
    if (!sessionId) {
        // --- 新增日誌 ---
        console.error('[Worker] 錯誤: 缺少 sessionId');
        return c.json({ error: "Missing sessionId" }, 400);
    }

    // --- 新增日誌 ---
    console.log(`[Worker] 取得 sessionId: ${sessionId}`);

    // 2. 從 Hono 的 context 中取得 env
    const env = c.env;

    // 檢查 DO 綁定是否存在
    if (!env.CHAT_HISTORY) {
        console.error('[Worker] 嚴重錯誤: CHAT_HISTORY 綁定未設定!');
        return c.json({ error: "CHAT_HISTORY binding is not configured." }, 500);
    }

    try {
        // 3. 根據 sessionId 取得 DO ID
        const id = env.CHAT_HISTORY.idFromName(sessionId);

        // 4. 取得 DO stub
        const stub = env.CHAT_HISTORY.get(id);

        // --- 新增日誌 ---
        console.log(`[Worker] 正在將請求轉發至 DO: ${id}`);

        // 5. 將原始請求 (c.req.raw) 轉發給 DO 處理
        const response = await stub.fetch(c.req.raw);

        // --- 新增日SQL ---
        console.log(`[Worker] 收到 DO 的回應，狀態: ${response.status}`);
        console.log(response);

        // 將 DO 的回應傳回
        return response;

    } catch (e) {
        const errorMessage = e instanceof Error ? e.message : "Unknown error";
        
        // --- 新增日SQL ---
        console.error(`[Worker] 呼叫 DO 時發生錯誤: ${errorMessage}`);
        
        return c.json({ error: `Failed to fetch from Durable Object: ${errorMessage}` }, 500);
    }
});

// 匯出 app 以便 Wrangler 運行
export default app;

// 匯出 Durable Object Class，Wrangler 在遷移時需要它
// (這會假設您的 DO Class 檔案名稱是 'chatHistory.do.ts')
export { ChatHistoryObject } from './chatHistory.do';