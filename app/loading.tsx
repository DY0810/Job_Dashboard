/**
 * Shown while the page's database read is in flight. It keeps the chrome and greys the data
 * region rather than replacing the screen, so a filter change does not feel like navigation.
 */
export default function Loading() {
  return (
    <main className="min-h-dvh px-4 pb-16">
      <header className="flex items-baseline gap-6 border-b border-rule py-2">
        <h1 className="w-wide text-[13px] font-medium">Worky</h1>
        <span className="w-wide text-[11px] text-fg-dim">loading</span>
      </header>
      <div className="border-b border-rule py-2">
        <span className="text-[10px] uppercase tracking-[0.1em] text-fg-dim">posted</span>
      </div>
      <table className="rows" aria-hidden>
        <tbody>
          {Array.from({ length: 12 }, (_, i) => (
            <tr key={i}>
              <td className="text-fg-faint">&mdash;</td>
              <td className="grow text-fg-faint">&mdash;</td>
              <td className="text-fg-faint">&mdash;</td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
