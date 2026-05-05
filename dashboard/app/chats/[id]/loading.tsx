import type { CSSProperties } from "react";

export default function ChatLoading() {
  return (
    <div
      className="chat-shell chat-shell-loading"
      style={{ "--inspector-width": "var(--persisted-inspector-width, 420px)" } as CSSProperties}
      role="status"
      aria-label="Loading chat"
    >
      <div className="chat-main">
        <header className="chat-header">
          <div className="chat-title-row">
            <div className="loading-skeleton h-5 w-48" />
            <div className="loading-skeleton h-5 w-16 rounded-full" />
            <div className="loading-skeleton h-5 w-32 rounded-full" />
          </div>
          <div className="chat-header-actions">
            <div className="loading-skeleton h-7 w-20" />
            <div className="loading-skeleton h-7 w-24" />
          </div>
        </header>
        <div className="chat-stream">
          <div className="message-loading-block user" />
          <div className="message-loading-block assistant" />
          <div className="message-loading-block assistant short" />
        </div>
        <div className="chat-composer-area p-4">
          <div className="loading-skeleton h-24 w-full" />
        </div>
      </div>
      <aside className="inspector inspector-loading">
        <div className="loading-skeleton h-7 w-44" />
        <div className="loading-skeleton h-24 w-full" />
        <div className="loading-skeleton h-40 w-full" />
      </aside>
    </div>
  );
}
