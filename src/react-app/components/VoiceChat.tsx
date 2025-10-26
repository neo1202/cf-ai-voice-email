// src/components/VoiceChat.tsx

import { useEffect, useMemo, useRef, useState } from "react";
import { useMicVAD } from "@ricky0123/vad-react";
import { encodeWavPCM16 } from "../lib/wav";
import { b64ToBlob, sniffAudioMime, waitFor, waitForOpen } from "../lib/utils";
import VoiceVisualStatus from "./VoiceVisualStatus";

function getSessionId(): string {
    let sessionId = localStorage.getItem("sessionId");
    if (!sessionId) {
        sessionId = crypto.randomUUID();
        localStorage.setItem("sessionId", sessionId);
    }
    return sessionId;
}

declare global {
    interface Window {
        webkitAudioContext?: typeof AudioContext;
        __vcCtx?: AudioContext;
    }
}

type Role = "user" | "assistant" | "system";
type ChatMsg = { role: Role; content: string };

type WebSocketMessage =
    | { type: "status"; text: string }
    | { type: "text" | "transcript"; text: string }
    | {
        type: "audio" | "assistant";
        text?: string;
        audio?: string | { audio: string };
        };

export default function VoiceChat() {
    const [messages, setMessages] = useState<ChatMsg[]>([]);
    const [status, setStatus] = useState<string>("");
    const [connected, setConnected] = useState(false);
    const [listening, setListening] = useState(false);
    const [playbackEl, setPlaybackEl] = useState<HTMLAudioElement | null>(null);
    const [aiSpeaking, setAiSpeaking] = useState(false);
    const [audioCtx, setAudioCtx] = useState<AudioContext | null>(null);
    const [sessionId, setSessionId] = useState<string | null>(null);

    const pendingTtsRef = useRef(0);
    const serverReadyRef = useRef(false);
    const wsRef = useRef<WebSocket | null>(null);
    const audioQueueRef = useRef<Blob[]>([]);
    const isPlayingRef = useRef(false);
    const chatContainerRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        setSessionId(getSessionId());
    }, []);

    const serverUrl = useMemo(() => {
        if (typeof window === "undefined" || !sessionId) return "";
        const proto = location.protocol === "https:" ? "wss" : "ws";
        console.log(`${proto}://${import.meta.env.VITE_WS_HOST}/chat/${sessionId}`);
        return `${proto}://${import.meta.env.VITE_WS_HOST}/chat/${sessionId}`;
    }, [sessionId]);

    const vad = useMicVAD({
        onnxWASMBasePath:"https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/",
        baseAssetPath:"https://cdn.jsdelivr.net/npm/@ricky0123/vad-web@0.0.27/dist/",
        startOnLoad: false,
        onSpeechStart: () => setStatus("Listening…"),
        onSpeechEnd: (audio) => {
            setStatus("Processing…");
            const wav = encodeWavPCM16(audio, 16_000);
            wsRef.current?.send(wav);
        },
    });
    const uiStatus = aiSpeaking
    ? "Speaking…"
    : vad.loading
    ? "Loading VAD…"
    : !listening
    ? "Idle"
    : vad.userSpeaking
    ? "User speaking"
    : "Listening";

    useEffect(
        () => setStatus(uiStatus),
        [uiStatus, aiSpeaking, vad.loading, vad.userSpeaking, listening]
    );

    useEffect(() => {
        if (chatContainerRef.current) {
            chatContainerRef.current.scrollTop = chatContainerRef.current.scrollHeight;
        }
    }, [messages]);

    async function unlockAudio(): Promise<AudioContext | null> {
        try {
            const AC = window.AudioContext || window.webkitAudioContext;
            if (!AC) return null;
            const ctx: AudioContext = window.__vcCtx ?? new AC();
            window.__vcCtx = ctx;
            if (ctx.state !== "running") await ctx.resume();
            return ctx;
        } catch {
            return null;
        }
    }

    const playNext = () => {
        if (isPlayingRef.current) return;
        const next = audioQueueRef.current.shift();
        if (!next) {
            setAiSpeaking(false);
            return;
        }

        isPlayingRef.current = true;
        const url = URL.createObjectURL(next);
        const a = new Audio(url);
        setPlaybackEl(a);

        a.onplaying = () => {
            setAiSpeaking(true);
            setStatus("Speaking…");
        };
        a.onwaiting = () => setStatus("Buffering audio…");
        a.onended = () => {
            URL.revokeObjectURL(url);
            isPlayingRef.current = false;
            pendingTtsRef.current = Math.max(0, pendingTtsRef.current - 1);
            if (pendingTtsRef.current <= 0 && audioQueueRef.current.length === 0) {
                setAiSpeaking(false);
                setStatus(listening ? "Listening…" : "Idle");
            }
            playNext();
        };
        a.onerror = (e) => {
            console.error("Audio Playback Error:", e);
            URL.revokeObjectURL(url);
            isPlayingRef.current = false;
            pendingTtsRef.current = Math.max(0, pendingTtsRef.current - 1);
            playNext(); // 即使出錯，也要繼續播放下一個
        };

        a.play().catch((err) => {
            console.error("a.play() was rejected!", err);
            setStatus(`Playback blocked: ${String(err)}`);
            // a.onerror?.(new Event('error')); // 手動觸發 onerror 來清理
        });
    };

    // const enqueueAudio = (b64: string) => {
    //     if (!b64 || b64.length === 0) {
    //         console.warn("Received empty audio data, skipping enqueue.");
    //         return;
    //     }
    //     const mime = sniffAudioMime(b64);
    //     const blob = b64ToBlob(b64, mime);
    //     audioQueueRef.current.push(blob);
    //     playNext(); // 每次有新音訊加入就嘗試播放
    // };
    const enqueueAudio = (blob: Blob) => {
        audioQueueRef.current.push(blob);
        pendingTtsRef.current += 1; // we have one more chunk to play
        playNext();
    };


    const connect = () => {
        if (!serverUrl) return;
        if (
        wsRef.current &&
        (wsRef.current.readyState === WebSocket.OPEN ||
            wsRef.current.readyState === WebSocket.CONNECTING)
        )
        return;
        
        console.log(`Connecting to: ${serverUrl}`);
        const ws = new WebSocket(serverUrl);
        ws.binaryType = "arraybuffer";

        ws.onopen = () => {
            setConnected(true);
            setStatus("Connected");
        };
        ws.onclose = () => {
            setConnected(false);
            setStatus("");
        };
        ws.onerror = () => setStatus("WebSocket error");

        ws.onmessage = (ev) => {
            console.log("[WebSocket MSG Received]:", ev.data);
            if (typeof ev.data !== "string") return;
            let msg: WebSocketMessage;
            try {
                msg = JSON.parse(ev.data);
            } catch { return; }

            if (msg.type === "status") {
                if (msg.text === "ready") {
                    serverReadyRef.current = true;
                    setStatus("Connected (server ready)");
                } else {
                    setStatus(String(msg.text ?? ""));
                }
                return;
            }
            
            if (msg.type === "text" || msg.type === "transcript") {
                setMessages((m) => [...m, { role: "user", content: msg.text }]);
                return;
            }

            if (msg.type === "audio" || msg.type === "assistant") {
                if (msg.text)
                setMessages((m) => [
                    ...m,
                    { role: "assistant", content: msg.text as string },
                ]);
                const raw =
                typeof msg.audio === "string" ? msg.audio : msg.audio?.audio ?? null;
                if (!raw) return;

                const mime = sniffAudioMime(raw); // picks audio/mpeg for MeloTTS
                enqueueAudio(b64ToBlob(raw, mime));
                return;

                // log play() errors so you see if autoplay is blocked
                // (see autoplay policies below)
                //  - put this inside playNext() on the Audio element:
                // a.play().catch(err => setStatus(`Playback blocked: ${String(err)}`));
            }
        };
        wsRef.current = ws;
    };

    const disconnect = () => {
        wsRef.current?.close();
        wsRef.current = null;
    };

    const onStart = async () => {
        console.log("--- 'Start Conversation' button clicked ---");
        connect(); // creates wsRef.current
        await waitForOpen(wsRef.current!);
        try {
            await waitFor(() => serverReadyRef.current, "server ready", 2500);
            await waitFor(() => !vad.loading, "VAD load", 15000);
            
            const ctx = await unlockAudio();
            if (ctx) setAudioCtx(ctx);
            
            vad.start();
            setListening(true);
            setStatus("Listening…");
        } catch (err) {
            console.error("Failed to start conversation:", err);
            setStatus((err as Error).message);
        }
    };

    const onStop = () => {
        vad.pause();
        setListening(false);
        setStatus("");
    };

    const onClear = () => {
        setMessages([]);
        setStatus("");
        wsRef.current?.send(JSON.stringify({ type: "cmd", data: "clear" }));
        audioQueueRef.current = [];
        isPlayingRef.current = false;
    };
    const onNewConversation = () => {
        // 1. 停止所有正在進行的活動
        onStop();
        if (playbackEl) playbackEl.pause();
        setAiSpeaking(false);
        audioQueueRef.current = [];
        isPlayingRef.current = false;
        
        // 2. 斷開當前的 WebSocket 連線
        disconnect();

        // 3. 清除前端顯示的訊息
        setMessages([]);

        // 4. 核心步驟：移除舊 session ID 並生成一個新的
        localStorage.removeItem("sessionId");
        const newSessionId = getSessionId(); // getSessionId 會自動創建並儲存新的 ID
        setSessionId(newSessionId);

        // 5. 重設狀態，準備好下一次對話
        setStatus("Ready for a new conversation.");
        serverReadyRef.current = false; // 重設伺服器就緒狀態
        console.log(`✨ New session started with ID: ${newSessionId}`);
    };

    useEffect(() => {
        return () => {
            vad.pause();
            disconnect();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // ... JSX 部分保持不變 ...
    return (
        <div className="flex flex-col gap-4 p-4 max-w-2xl mx-auto bg-white shadow-lg rounded-lg">
        <div
            ref={chatContainerRef}
            className="rounded-xl border bg-gray-50 p-4 h-[420px] overflow-y-auto"
        >
            {messages.length === 0 ? (
            <div className="text-sm text-gray-400">
                No messages yet. Click “Start Conversation” to talk.
            </div>
            ) : (
            <ul className="space-y-2">
                {messages.map((m, i) => (
                <li
                    key={i}
                    className={`flex ${
                    m.role === "user" ? "justify-end" : "justify-start"
                    }`}
                >
                    <div
                    className={[
                        "max-w-[80%] rounded-2xl px-3 py-2 text-sm shadow-sm",
                        m.role === "user"
                        ? "bg-blue-600 text-white"
                        : "bg-gray-200 text-gray-900",
                    ].join(" ")}
                    >
                    {m.content}
                    </div>
                </li>
                ))}
            </ul>
            )}
        </div>
    
        <VoiceVisualStatus
            mode={aiSpeaking ? "playback" : "mic"}
            audioContext={audioCtx}
            playbackEl={playbackEl}
            statusText={status}
            listening={listening}
            vadLoading={vad.loading}
            userSpeaking={vad.userSpeaking}
            aiSpeaking={aiSpeaking}
        />
    
        <div className="flex items-center gap-3">
            <button
            onClick={onStart}
            disabled={listening || !sessionId}
            className={`rounded-lg px-4 py-2 font-medium transition-colors ${
                listening || !sessionId
                ? "bg-gray-400 cursor-not-allowed"
                : "bg-green-600 hover:bg-green-700 active:scale-95"
            } text-white shadow`}
            >
            Start
            </button>
    
            <button
            onClick={onStop}
            disabled={!listening}
            className={`rounded-lg px-4 py-2 font-medium transition-colors ${
                !listening
                ? "bg-gray-400 cursor-not-allowed"
                : "bg-red-600 hover:bg-red-700 active:scale-95"
            } text-white shadow`}
            >
            Stop
            </button>

            <div className="ml-auto flex items-center gap-3">
            {/* 按鈕 1: 清除當前對話 */}
                <button
                    onClick={onClear}
                    className="rounded-lg px-4 py-2 font-medium bg-cyan-600 text-white shadow hover:bg-cyan-700 active:scale-95"
                >
                    Clear Chat
                </button>

                {/* 按鈕 2: 開始全新對話 */}
                <button
                    onClick={onNewConversation}
                    className="rounded-lg px-4 py-2 font-medium bg-gray-700 text-white shadow hover:bg-gray-800 active:scale-95"
                >
                    New Conversation
                </button>
            </div>
            
    
            <span
            className={`text-xs ${
                connected ? "text-green-700" : "text-gray-400"
            }`}
            >
            {connected ? "WS connected" : "WS disconnected"}
            </span>
        </div>
        </div>
    );
}