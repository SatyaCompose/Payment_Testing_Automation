import type { AuthState } from '../types';

interface Props {
  auth: AuthState;
  onSignIn: () => Promise<void>;
  onCancel: () => Promise<void>;
}

export function AuthPanel({ auth, onSignIn, onCancel }: Props) {
  const signedIn = auth.status === 'signed-in';
  const signingIn = auth.status === 'signing-in';

  return (
    <div className="rounded-2xl border border-slate-800 bg-panel p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex flex-col leading-tight">
          <span className="text-xs uppercase tracking-widest text-slate-500">Browser session</span>
          <span className="text-sm font-semibold text-slate-200">
            {signedIn && <span className="text-success">✓ Signed in</span>}
            {signingIn && <span className="text-accent">● Signing in…</span>}
            {auth.status === 'signed-out' && <span className="text-warn">Not signed in</span>}
            {auth.status === 'error' && <span className="text-danger">Sign-in failed</span>}
            {auth.status === 'unknown' && <span className="text-slate-400">Checking…</span>}
          </span>
          {signedIn && auth.since && (
            <span className="text-[10px] text-slate-500">
              Saved {new Date(auth.since).toLocaleString()}
            </span>
          )}
        </div>
        {!signingIn ? (
          <button
            onClick={onSignIn}
            className={`rounded-full px-4 py-2 text-sm font-semibold shadow-lg transition active:scale-95 ${
              signedIn
                ? 'border border-slate-600 text-slate-200 hover:bg-slate-800'
                : 'bg-accent text-slate-950 hover:brightness-110'
            }`}
          >
            {signedIn ? 'Re-sign in' : 'Sign in to browser'}
          </button>
        ) : (
          <button
            onClick={onCancel}
            className="rounded-full border border-danger px-4 py-2 text-sm font-semibold text-danger hover:bg-danger/10"
          >
            Cancel
          </button>
        )}
      </div>

      {signingIn && (
        <div className="rounded-xl border border-slate-800 bg-black/40 p-2 font-mono text-[11px] leading-tight text-slate-300">
          {auth.progress.length === 0 && (
            <div className="text-slate-500">Opening Chrome window…</div>
          )}
          {auth.progress.map((line, i) => (
            <div key={i} className="whitespace-pre-wrap">
              {line}
            </div>
          ))}
        </div>
      )}

      {auth.status === 'error' && auth.error && (
        <div className="rounded-xl border border-danger/40 bg-danger/10 p-2 text-xs text-danger">
          {auth.error}
        </div>
      )}

      {!signingIn && auth.status !== 'signed-in' && (
        <p className="mt-1 text-[11px] leading-tight text-slate-500">
          Click above to open a real Chrome window. Sign in to Google, then to KWH.
          Close the window when done — the session is saved automatically.
        </p>
      )}
    </div>
  );
}
