// src/components/VoiceChat.tsx

import { useEffect, useMemo, useRef, useState } from "react";
import { useMicVAD } from "@ricky0123/vad-react";
import { encodeWavPCM16 } from "../lib/wav";
import { b64ToBlob, sniffAudioMime, waitFor, waitForOpen } from "../lib/utils";
import VoiceVisualStatus from "./VoiceVisualStatus";

// TypeScript declarations for browser compatibility
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
const pendingTtsRef = useRef(0);
const serverReadyRef = useRef(false);

const wsRef = useRef<WebSocket | null>(null);
const audioQueueRef = useRef<Blob[]>([]);
const isPlayingRef = useRef(false);
const chatContainerRef = useRef<HTMLDivElement>(null);

// --- 關鍵修改：使用 Vite 的環境變數 ---
const serverUrl = useMemo(() => {
    if (typeof window === "undefined") return "";
    const proto = location.protocol === "https:" ? "wss" : "ws";
    // 從 import.meta.env 讀取，而不是 process.env
    return `${proto}://${import.meta.env.VITE_WS_HOST}/websocket`;
}, []);

const vad = useMicVAD({
    startOnLoad: false,
    onSpeechStart: () => setStatus("Listening…"),
    onSpeechEnd: (audio) => {
    setStatus("Processing…");
    const wav = encodeWavPCM16(audio, 16_000);
    wsRef.current?.send(wav);
    },
});

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
    if (pendingTtsRef.current <= 0) setAiSpeaking(false);
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
    a.onerror = () => {
    URL.revokeObjectURL(url);
    isPlayingRef.current = false;
    pendingTtsRef.current = Math.max(0, pendingTtsRef.current - 1);
    playNext();
    };

    a.play().catch((err) => {
    setStatus(`Playback blocked: ${String(err)}`);
    });
};

const enqueueAudio = (blob: Blob) => {
    audioQueueRef.current.push(blob);
    pendingTtsRef.current += 1;
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
    if (typeof ev.data !== "string") return;
    let msg: WebSocketMessage;
    try {
        msg = JSON.parse(ev.data);
    } catch {
        return;
    }

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

        const mime = sniffAudioMime(raw);
        enqueueAudio(b64ToBlob(raw, mime));
        return;
    }
    };
    wsRef.current = ws;
};

const disconnect = () => {
    wsRef.current?.close();
    wsRef.current = null;
};

const onStart = async () => {
    connect();
    await waitForOpen(wsRef.current!);
    try {
    await waitFor(() => serverReadyRef.current, "server ready", 2500);
    } catch {
    console.warn("No 'ready' ping seen; proceeding after open()");
    serverReadyRef.current = true;
    }
    await waitFor(() => vad.loading === false, "VAD load", 15000);

    const ctx = await unlockAudio();
    if (ctx) setAudioCtx(ctx);

    vad.start();
    setListening(true);
    setStatus("Listening…");
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

useEffect(() => {
    return () => {
    vad.pause();
    disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
}, []);

// UI (JSX) 部分保持不變，你可以根據你的需求修改
return (
    <div className="flex flex-col gap-4 p-4 max-w-2xl mx-auto">
    <div
        ref={chatContainerRef}
        className="rounded-xl border bg-white p-4 h-[420px] overflow-y-auto"
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
        disabled={listening}
        className={`rounded-lg px-4 py-2 font-medium ${
            listening
            ? "bg-gray-400 cursor-not-allowed"
            : "bg-green-600 hover:opacity-90 active:scale-95"
        } text-white shadow`}
        >
        Start Conversation
        </button>

        <button
        onClick={onStop}
        disabled={!listening}
        className={`rounded-lg px-4 py-2 font-medium ${
            !listening
            ? "bg-gray-400 cursor-not-allowed"
            : "bg-red-600 hover:opacity-90 active:scale-95"
        } text-white shadow`}
        >
        Stop Conversation
        </button>

        <button
        onClick={onClear}
        className="ml-auto rounded-lg px-4 py-2 font-medium bg-gray-700 text-white shadow hover:opacity-90 active:scale-95"
        >
        Clear Chat
        </button>

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