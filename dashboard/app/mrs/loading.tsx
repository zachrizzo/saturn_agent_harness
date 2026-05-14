export default function MergeRequestsLoading() {
  return (
    <div className="mrs-workspace">
      <aside className="mrs-list-panel">
        <div className="mrs-list-head">
          <div className="loading-skeleton h-5 w-36" />
          <div className="loading-skeleton h-8 w-8" />
        </div>
        <div className="mrs-controls">
          <div className="loading-skeleton h-8 w-full" />
          <div className="loading-skeleton h-7 w-44" />
        </div>
        <div className="mrs-list loading-list" role="status" aria-label="Loading merge requests">
          {Array.from({ length: 8 }).map((_, index) => (
            <div key={index} className="mrs-row loading">
              <span className="loading-skeleton h-4 w-24" />
              <span className="loading-skeleton h-4 w-full" />
              <span className="loading-skeleton h-3 w-3/4" />
            </div>
          ))}
        </div>
      </aside>
      <section className="mrs-detail-panel">
        <div className="chat-shell-loading chat-shell">
          <div className="chat-main">
            <div className="chat-header">
              <div className="loading-skeleton h-5 w-48" />
            </div>
            <div className="chat-stream">
              <div className="message-loading-block user" />
              <div className="message-loading-block" />
            </div>
          </div>
          <div className="inspector-loading">
            <div className="loading-skeleton h-8 w-full" />
            <div className="loading-skeleton h-40 w-full" />
          </div>
        </div>
      </section>
    </div>
  );
}
