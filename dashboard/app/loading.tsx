export default function Loading() {
  return (
    <div className="route-loading" role="status" aria-live="polite" aria-label="Loading">
      <div className="loading-spinner" aria-hidden="true" />
      <span>Loading</span>
    </div>
  );
}
