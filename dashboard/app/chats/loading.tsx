export default function ChatsLoading() {
  return (
    <div className="chats-page">
      <div className="chats-main">
        <div className="chats-toolbar">
          <div className="loading-skeleton h-8 w-[min(380px,100%)]" />
          <div className="loading-skeleton h-7 w-24" />
          <div className="loading-skeleton h-7 w-28" />
          <div className="loading-skeleton h-7 w-32" />
        </div>
        <div className="chats-list loading-list" role="status" aria-label="Loading chats">
          {Array.from({ length: 10 }).map((_, index) => (
            <div key={index} className="chat-row loading-row">
              <span className="loading-skeleton h-4 w-4" />
              <span className="loading-skeleton h-3 w-3" />
              <span className="loading-skeleton h-3 w-3" />
              <span className="loading-skeleton h-4 w-36" />
              <span className="loading-skeleton h-4 w-full" />
              <span className="loading-skeleton h-4 w-14" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
