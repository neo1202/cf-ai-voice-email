import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { cloudflare } from "@cloudflare/vite-plugin";
// import { viteStaticCopy } from "vite-plugin-static-copy";

export default defineConfig({
    plugins: [
        react(), 
        cloudflare(),
        
    ],
    server: {
        headers: {
            "Cross-Origin-Embedder-Policy": "require-corp",
            "Cross-Origin-Opener-Policy": "same-origin",
        },
        proxy: {
            // 這會將所有 /chat 開頭的請求
            // 代理到您本地運行的 wrangler dev 伺服器
            // '/chat': {
            //     target: 'http://localhost:8787', // 這是 wrangler dev 的預設埠號
            //     changeOrigin: true,
            // },
            // 如果您有其他 API 路由，也可以在這裡添加
        },
    },
    optimizeDeps: {
        include: [
            '@ricky0123/vad-react',
            'onnxruntime-web',
        ],
    },
});
