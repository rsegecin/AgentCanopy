import type { ProviderStatus } from '../../shared';
import { Icon, VisuallyHidden } from './components';
import { useViewState } from './store';

function describe(provider: ProviderStatus | null): { icon: string; text: string; ok: boolean } {
  if (provider === null) return { icon: 'loading', text: 'Checking', ok: false };
  if (!provider.installed) return { icon: 'error', text: 'Not installed', ok: false };
  if (!provider.meetsMinimum) return { icon: 'warning', text: 'Update needed', ok: false };
  if (provider.auth === 'signed-out') return { icon: 'warning', text: 'Signed out', ok: false };
  if (provider.problems.length > 0) return { icon: 'warning', text: 'Has problems', ok: false };
  return { icon: 'pass', text: 'Ready', ok: true };
}

/** Shows whether the provider can run. Shape and text carry the state, not just colour. */
export function ProviderIndicator() {
  const provider = useViewState((s) => s.provider);
  const info = describe(provider);
  const name = provider?.displayName ?? 'Provider';
  const details = provider?.problems.join(' ') ?? '';
  return (
    <span
      className={`provider provider--${info.ok ? 'ok' : 'attention'}`}
      title={`${name}: ${info.text}${details !== '' ? `. ${details}` : ''}`}
      role="status"
    >
      <Icon name={info.icon} spin={provider === null} />
      <span className="provider-name">{name}</span>
      {!info.ok && <span className="provider-state">{info.text}</span>}
      {info.ok && <VisuallyHidden>{info.text}</VisuallyHidden>}
    </span>
  );
}
