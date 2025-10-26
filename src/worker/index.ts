// import { Hono } from 'hono';
// import type { Context, Next } from 'hono';
// // 使用 Hono，並綁定 Env 類型
// const app = new Hono<{ Bindings: Env }>();
// const setCoopCoepHeaders = async (c: Context, next: Next) => {
//     c.res.headers.set('Cross-Origin-Opener-Policy', 'same-origin');
//     c.res.headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
//     return next();
// };

// // 1. 將中介軟體套用在所有路由之前
// app.use(setCoopCoepHeaders);
// // 設置一個路由來處理所有 /chat/:sessionId 的請求
// app.all('/chat/:sessionId', async (c) => {
    
//     // --- 新增日誌 ---
//     console.log(`[Worker] 收到請求: ${c.req.method} ${c.req.url}`);

//     // 1. 從 URL 參數中取得 sessionId
//     const sessionId = c.req.param('sessionId');
//     if (!sessionId) {
//         // --- 新增日誌 ---
//         console.error('[Worker] 錯誤: 缺少 sessionId');
//         return c.json({ error: "Missing sessionId" }, 400);
//     }

//     // --- 新增日誌 ---
//     console.log(`[Worker] 取得 sessionId: ${sessionId}`);

//     // 2. 從 Hono 的 context 中取得 env
//     const env = c.env;

//     // 檢查 DO 綁定是否存在
//     if (!env.CHAT_HISTORY) {
//         console.error('[Worker] 嚴重錯誤: CHAT_HISTORY 綁定未設定!');
//         return c.json({ error: "CHAT_HISTORY binding is not configured." }, 500);
//     }

//     try {
//         // 3. 根據 sessionId 取得 DO ID
//         const id = env.CHAT_HISTORY.idFromName(sessionId);

//         // 4. 取得 DO stub
//         const stub = env.CHAT_HISTORY.get(id);

//         // --- 新增日誌 ---
//         console.log(`[Worker] 正在將請求轉發至 DO: ${id}`);

//         // 5. 將原始請求 (c.req.raw) 轉發給 DO 處理
//         const response = await stub.fetch(c.req.raw);

//         // --- 新增日SQL ---
//         console.log(`[Worker] 收到 DO 的回應，狀態: ${response.status}`);
//         console.log(response);

//         // 將 DO 的回應傳回
//         return response;

//     } catch (e) {
//         const errorMessage = e instanceof Error ? e.message : "Unknown error";
        
//         // --- 新增日SQL ---
//         console.error(`[Worker] 呼叫 DO 時發生錯誤: ${errorMessage}`);
        
//         return c.json({ error: `Failed to fetch from Durable Object: ${errorMessage}` }, 500);
//     }
// });

// // 匯出 app 以便 Wrangler 運行
// export default app;

// // 匯出 Durable Object Class，Wrangler 在遷移時需要它
// // (這會假設您的 DO Class 檔案名稱是 'chatHistory.do.ts')
// export { ChatHistoryObject } from './chatHistory.do';
import { smoothStream, streamText, type CoreMessage } from 'ai';
import { DurableObject } from 'cloudflare:workers';
import { createWorkersAI } from 'workers-ai-provider';
import PQueue from 'p-queue';


export class ChatHistoryObject extends DurableObject {
	env: Env;
	msgHistory: CoreMessage[];
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.env = env;
		this.msgHistory = [];
	}
	async fetch(request: Request) {
		// set up ws pipeline
        console.log("haha");
		const webSocketPair = new WebSocketPair();
		const [socket, ws] = Object.values(webSocketPair);

		console.log('request', request.method, request.url);

		ws.accept();
		ws.send(JSON.stringify({ type: 'status', text: 'ready' })); // tell the client it’s safe to send
		const workersai = createWorkersAI({ binding: this.env.AI });
		const queue = new PQueue({ concurrency: 1 });

		ws.addEventListener('message', async (event) => {
			// handle chat commands
			if (typeof event.data === 'string') {
				const { type, data } = JSON.parse(event.data);
				if (type === 'cmd' && data === 'clear') {
					this.msgHistory.length = 0; // clear chat history
				}
				return; // end processing here for this event type
			}

			// transcribe audio buffer to text (stt)
			const { text } = await this.env.AI.run('@cf/openai/whisper-tiny-en', {
				audio: [...new Uint8Array(event.data as ArrayBuffer)],
			});
			console.log('>>', text);
			ws.send(JSON.stringify({ type: 'text', text })); // send transcription to client
			this.msgHistory.push({ role: 'user', content: text });

			// run inference
			console.log('Starting inference...');

			const result = streamText({
				model: workersai('@cf/meta/llama-3.1-8b-instruct'),
				system: 'You are a helpful assistant in a voice conversation with the user',
				messages: this.msgHistory,
				temperature: 0.7,
				// IMPORTANT: sentence chunking, no artificial delay
				experimental_transform: smoothStream({
					delayInMs: null,
					chunking: (buf: string) => {
						// emit a sentence if we see ., !, ? followed by space/end
						const m = buf.match(/^(.+?[.!?])(?:\s+|$)/);
						if (m) return m[0];
						// otherwise emit a clause if it’s getting long
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

				// serialize TTS per sentence (keeps order) but don't block the reader too long
				// DO NOT await here – let the reader continue; queue enforces order=1
				void queue.add(async () => {
					const tts = await this.env.AI.run('@cf/myshell-ai/melotts', { prompt: sentence });

					// normalize to a base64 string
					let b64: string;
					if (typeof tts === 'string') {
						b64 = tts;
					} else if (tts && typeof tts === 'object' && 'audio' in tts) {
						b64 = (tts as { audio: string }).audio;
					} else {
						// Convert Uint8Array to base64
						b64 = btoa(String.fromCharCode(...new Uint8Array(tts as ArrayBuffer)));
					}

					ws.send(JSON.stringify({ type: 'audio', text: sentence, audio: b64 }));
				});
			}

			// wait for audio queue to drain before closing the turn
			await queue.onIdle();

			// Only after the model finishes: add one assistant turn to history
			this.msgHistory.push({ role: 'assistant', content: fullReply });
			ws.send(JSON.stringify({ type: 'status', text: 'Idle' }));

			// Optional debug:
			console.log('finishReason:', await result.finishReason);
		});

		ws.addEventListener('close', (cls) => {
			ws.close(cls.code, 'Durable Object is closing WebSocket');
		});

		return new Response(null, { status: 101, webSocket: socket });
	}
}

export default {
	async fetch(request, env, ctx): Promise<Response> {
		console.log('ctx.name:', ctx.props.name);
		if (request.url.endsWith('/websocket')) {
			const upgradeHeader = request.headers.get('Upgrade');
			if (!upgradeHeader || upgradeHeader !== 'websocket') {
				return new Response('Expected upgrade to websocket', { status: 426 });
			}
			const id: DurableObjectId = env.CHAT_HISTORY.idFromName(crypto.randomUUID());
			const stub = env.CHAT_HISTORY.get(id);
			return stub.fetch(request);
		}

		return new Response(null, {
			status: 400,
			statusText: 'Bad Request',
			headers: { 'Content-Type': 'text/plain' },
		});
	},
} satisfies ExportedHandler<Env>;