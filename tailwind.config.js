export default {
    // 1. 告訴 Tailwind 要掃描哪些檔案來尋找 class
    content: [
        "./index.html",
        "./src/**/*.{js,ts,jsx,tsx}", // 包含所有 src 底下的 .tsx 和 .jsx 檔案
    ],
    theme: {
        extend: {},
    },
    plugins: [],
}
