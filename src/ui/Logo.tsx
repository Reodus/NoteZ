export function Logo(props: { size?: number }) {
  const s = props.size ?? 28;
  return (
    <svg width={s} height={s} viewBox="0 0 64 64" class="logo" aria-label="NoteZ">
      <defs>
        <linearGradient id="nzg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="var(--accent)" />
          <stop offset="1" stop-color="var(--accent-2)" />
        </linearGradient>
      </defs>
      <rect x="4" y="4" width="56" height="56" rx="16" fill="url(#nzg)" />
      <path d="M20 44V20l24 24V20" fill="none" stroke="white" stroke-width="5.5" stroke-linecap="round" stroke-linejoin="round" />
      <circle cx="46" cy="46" r="3.2" fill="white" opacity="0.85" />
    </svg>
  );
}
