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

    async handleHttpRequest(request: Request): Promise<Response> {
        if (request.method === "POST") {
            try {
                const { message } = (await request.json()) as { message: string };
                console.log(`[DO] ${this.ctx.id} 收到 HTTP 訊息: "${message}"`);

                this.msgHistory.push({ role: 'user', content: message });
                
                const aiResponseContent = `AI received HTTP text: '${message}'`;
                this.msgHistory.push({ role: 'assistant', content: aiResponseContent });

                // --- 要求的日誌 ---
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

    async handleWebSocket(request: Request): Promise<Response> {
        const webSocketPair = new WebSocketPair();
        const [socket, ws] = Object.values(webSocketPair);

        ws.accept();
        ws.send(JSON.stringify({ type: 'status', text: 'ready' }));
        const workersai = createWorkersAI({ binding: this.env.AI });
        const queue = new PQueue({ concurrency: 1 });

        ws.addEventListener('message', async (event) => {
            if (typeof event.data === 'string') {
                const { type, data } = JSON.parse(event.data);
                console.log(`[DO] ${this.ctx.id} 收到 WS 指令: ${type} - ${data}`);
                if (type === 'cmd' && data === 'clear') {
                    this.msgHistory = [];
                    await this.ctx.storage.delete("history");
                    ws.send(JSON.stringify({ type: 'status', text: 'History cleared' }));
                }
                return;
            }

            const { text } = await this.env.AI.run('@cf/openai/whisper-tiny-en', {
                audio: [...new Uint8Array(event.data as ArrayBuffer)],
            });
            console.log(`[DO] ${this.ctx.id} STT 結果: "${text}"`);
            ws.send(JSON.stringify({ type: 'text', text }));
            this.msgHistory.push({ role: 'user', content: text });

            console.log(`[DO] ${this.ctx.id} 正在開始 AI 串流...`);
            const result = streamText({
                model: workersai('@cf/meta/llama-3.1-8b-instruct'),
                system: 'You are a helpful assistant in a voice conversation.',
                messages: this.msgHistory,
            });

            let fullReply = '';
            for await (const chunk of result.textStream) {
                const sentence = String(chunk).trim();
                if (!sentence) continue;
                fullReply += (fullReply ? ' ' : '') + sentence;
                ws.send(JSON.stringify({ type: 'status', text: 'Speaking…' }));

                void queue.add(async () => {
                    const tts = await this.env.AI.run('@cf/myshell-ai/melotts', { prompt: sentence });
                    const b64 = btoa(String.fromCharCode(...new Uint8Array(tts as ArrayBuffer)));
                    ws.send(JSON.stringify({ type: 'audio', text: sentence, audio: b64 }));
                });
            }

            await queue.onIdle();

            this.msgHistory.push({ role: 'assistant', content: fullReply });

            // --- 要求的日誌 ---
            console.log(`[DO] ${this.ctx.id} 目前完整 WS 歷史:`, JSON.stringify(this.msgHistory, null, 2));

            await this.ctx.storage.put("history", this.msgHistory);
            console.log(`[DO] ${this.ctx.id} 已儲存 WS 歷史。`);

            ws.send(JSON.stringify({ type: 'status', text: 'Idle' }));
        });

        ws.addEventListener('close', () => {
            console.log(`[DO] ${this.ctx.id} WebSocket 已關閉`);
        });

        return new Response(null, { status: 101, webSocket: socket });
    }
}

