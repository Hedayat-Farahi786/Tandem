import { useEffect, useState } from 'react';
import { fetchGreeting, type Greeting } from './api';

type State = { kind: 'loading' } | { kind: 'ready'; greeting: Greeting } | { kind: 'error'; message: string };

export function App({ load = fetchGreeting }: { load?: () => Promise<Greeting> }) {
  const [state, setState] = useState<State>({ kind: 'loading' });

  useEffect(() => {
    let active = true;
    load()
      .then((greeting) => {
        if (active) setState({ kind: 'ready', greeting });
      })
      .catch((err: unknown) => {
        if (active) setState({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
      });
    return () => {
      active = false;
    };
  }, [load]);

  return (
    <main>
      <h1>Tandem sandbox</h1>
      {state.kind === 'loading' && <p>Loading…</p>}
      {state.kind === 'ready' && <p data-testid="greeting">{state.greeting.message}</p>}
      {state.kind === 'error' && <p role="alert">Could not load the greeting: {state.message}</p>}
    </main>
  );
}
