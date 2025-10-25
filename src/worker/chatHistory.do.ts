import { smoothStream, streamText, type CoreMessage } from 'ai';
import { createWorkersAI } from 'workers-ai-provider';
import PQueue from 'p-queue';
import { DurableObject } from 'cloudflare:workers';

export class ChatHistoryObject extends DurableObject {
    env: Env;
    msgHistory: CoreMessage[];

    constructor(ctx: DurableObjectState, env: Env) {
        super(ctx, env);
        this.env = env;
        this.msgHistory = [];
        
        // 啟動時載入持久化的歷史紀錄
        this.ctx.storage.get("history").then(history => {
            this.msgHistory = (history as CoreMessage[]) || [];
            console.log(`[DO] ${this.ctx.id} 啟動，載入了 ${this.msgHistory.length} 則歷史訊息。`);
        });
    }

    async fetch(request: Request): Promise<Response> {
        const upgradeHeader = request.headers.get('Upgrade');
        if (upgradeHeader === 'websocket') {
            console.log(`[DO] ${this.ctx.id} 正在處理 WebSocket 請求...`);
            return this.handleWebSocket(request);
        } else {
            console.log(`[DO] ${this.ctx.id} 正在處理 HTTP 請求...`);
            return this.handleHttpRequest(request);
        }
    }

    // --- 這就是更新後的函式 ---
    async handleHttpRequest(request: Request): Promise<Response> {
        if (request.method === "POST") {
            try {
                const { message } = (await request.json()) as { message: string };
                console.log(`[DO] ${this.ctx.id} 收到 HTTP 訊息: "${message}"`);

                this.msgHistory.push({ role: 'user', content: message });

                // --- 這是新的 AI 呼叫邏輯 ---
                console.log(`[DO] ${this.ctx.id} 正在為 HTTP 請求呼叫 AI...`);
                const workersai = createWorkersAI({ binding: this.env.AI });
                
                const result = streamText({
                    model: workersai('@cf/meta/llama-3.1-8b-instruct'),
                    system: 'You are a helpful assistant.', // 文字聊天的 system prompt
                    messages: this.msgHistory,
                });

                // 因為是 HTTP，我們收集完整的 AI 回覆，而不是串流
                let aiResponseContent = '';
                for await (const chunk of result.textStream) {
                    aiResponseContent += chunk;
                }
                
                console.log(`[DO] ${this.ctx.id} 收到 AI 完整回覆: "${aiResponseContent}"`);
                // --- AI 呼叫邏輯結束 ---

                this.msgHistory.push({ role: 'assistant', content: aiResponseContent });

                console.log(`[DO] ${this.ctx.id} 目前完整 HTTP 歷史:`, JSON.stringify(this.msgHistory, null, 2));
                
                await this.ctx.storage.put("history", this.msgHistory);
                console.log(`[DO] ${this.ctx.id} 已儲存歷史。正在回傳: "${aiResponseContent}"`);

                return new Response(JSON.stringify({ reply: aiResponseContent }), {
                    headers: { "Content-Type": "application/json" },
                });
            } catch (e) {
                const errorMessage = e instanceof Error ? e.message : "Unknown error";
                console.error(`[DO] ${this.ctx.id} 處理 HTTP 請求時發生錯誤:`, errorMessage);
                return new Response(`Error: ${errorMessage}`, { status: 400 });
            }
        }
        return new Response("Method Not Allowed", { status: 405 });
    }

    async handleWebSocket(_request: Request): Promise<Response> {
        const webSocketPair = new WebSocketPair();
        const [socket, ws] = Object.values(webSocketPair);

        ws.accept();
        console.log(`[DO] ${this.ctx.id} WebSocket 連線成功建立。`);
        ws.send(JSON.stringify({ type: 'status', text: 'ready' }));
        
        const workersai = createWorkersAI({ binding: this.env.AI });
        const queue = new PQueue({ concurrency: 1 });

        ws.addEventListener('message', async (event) => {
            try {
                if (typeof event.data === 'string') {
                    const { type, data } = JSON.parse(event.data);
                    if (type === 'cmd' && data === 'clear') {
                        this.msgHistory = [];
                        await this.ctx.storage.delete("history");
                        ws.send(JSON.stringify({ type: 'status', text: 'History cleared' }));
                    }
                    return;
                }
                
                console.log(`[DO] ${this.ctx.id} 收到音訊，大小: ${(event.data as ArrayBuffer).byteLength}，正在轉文字...`);

                const { text } = await this.env.AI.run('@cf/openai/whisper-tiny-en', {
                    audio: [...new Uint8Array(event.data as ArrayBuffer)],
                });
                
                console.log(`[DO] ${this.ctx.id} STT 結果: "${text}"`);
                // 將使用者的逐字稿發回前端
                ws.send(JSON.stringify({ type: 'transcript', text: text }));
                this.msgHistory.push({ role: 'user', content: text });
                
                console.log(`[DO] ${this.ctx.id} 正在開始 AI 串流...`);
                const result = streamText({
                    model: workersai('@cf/meta/llama-3.1-8b-instruct'),
                    system: 'You are a helpful assistant in a voice conversation. Keep your responses concise.',
                    messages: this.msgHistory,
                    // maxTokens: 160,
                    temperature: 0.75,
                    experimental_transform: smoothStream({
                        delayInMs: null,
                        chunking: (buf: string) => {
                            const m = buf.match(/^(.+?[.!?])(?:\s+|$)/);
                            if (m) return m[0];
                            if (buf.length > 120) return buf;
                            return null;
                        },
                    }),
                });

                let fullReply = '';
                for await (const chunk of result.textStream) {
                    const sentence = String(chunk).trim();
                    if (!sentence) continue;
                    fullReply += (fullReply ? ' ' : '') + sentence;
                    ws.send(JSON.stringify({ type: 'status', text: 'Speaking…' }));
                    console.log('<<', sentence);
                    void queue.add(async () => {
                        console.log(`[DO] ${this.ctx.id} 正在為句子生成 TTS: "${sentence}"`);
                        const tts = await this.env.AI.run('@cf/myshell-ai/melotts', { prompt: sentence });
                        let b64: string;
                        if (typeof tts === 'string') {
                            b64 = tts;
                        } else if (tts && typeof tts === 'object' && 'audio' in tts) {
                            b64 = (tts as { audio: string }).audio;
                        } else {
                            // Convert Uint8Array to base64
                            b64 = btoa(String.fromCharCode(...new Uint8Array(tts as ArrayBuffer)));
                        }
                        ws.send(JSON.stringify({ type: 'assistant', text: sentence, audio: b64 }));
                    });
                }

                await queue.onIdle();
                this.msgHistory.push({ role: 'assistant', content: fullReply });
                await this.ctx.storage.put("history", this.msgHistory);
                console.log(`[DO] ${this.ctx.id} 已儲存 WS 歷史。`);

                ws.send(JSON.stringify({ type: 'status', text: 'Idle' }));
                
            } catch (error) {
                console.error(`[DO] ${this.ctx.id} 處理訊息時發生嚴重錯誤:`, error);
                ws.send(JSON.stringify({ type: 'status', text: `Error: ${(error as Error).message}` }));
            }
        });

        ws.addEventListener('close', () => {
            console.log(`[DO] ${this.ctx.id} WebSocket 已關閉`);
        });

        return new Response(null, { status: 101, webSocket: socket });
    }
}

