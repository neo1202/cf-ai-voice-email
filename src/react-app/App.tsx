// src/App.tsx

import VoiceChat from './components/VoiceChat';

function App() {
  return (
    <main className="bg-gray-100 min-h-screen flex items-center justify-center font-sans">
      <div className="w-full max-w-2xl p-4">
        <header className="text-center mb-6">
          <h1 className="text-3xl font-bold text-gray-800">AI Voice Assistant</h1>
          <p className="text-gray-500">
            Powered by Cloudflare AI & Vite
          </p>
        </header>
        <VoiceChat />
      </div>
    </main>
  );
}

export default App;