export function Mark() {
  return (
    <span className="mark" aria-hidden="true">
      <svg viewBox="0 0 32 32">
        <path d="M6 5h5.2v8.4h9.6V5H26v22h-5.2v-8.8h-9.6V27H6V5z" fill="#111" />
      </svg>
    </span>
  );
}

export function Brand({ subtitle }: { subtitle: string }) {
  return (
    <header className="brand">
      <Mark />
      <div>
        <div className="word">
          hemi <span>BTC</span>
        </div>
        <div className="tag">{subtitle}</div>
      </div>
    </header>
  );
}
