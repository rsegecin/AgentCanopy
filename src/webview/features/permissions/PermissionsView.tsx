import { useId, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { PERMISSION_SWITCHES } from '../../../shared';
import type {
  FolderPermissions,
  PermissionSwitch,
  PolicySettings,
  SavedPermission,
  SavedPermissionKind,
  WebviewMessage,
} from '../../../shared';
import { Icon, VisuallyHidden } from '../../app/components';
import { usePost } from '../../app/context';
import { useFocusRecovery } from '../../app/focus';
import { useViewState } from '../../app/store';

export const UNTRUSTED_REASON = 'This workspace is not trusted, so permissions cannot be changed.';
export const NO_FOLDER_REASON =
  'Permissions belong to a workspace folder. Open a folder to use them.';
export const WEB_TOOLS_NOTE =
  'Ask and Plan mode do not use the web while agentCanopy.ask.webTools is off.';
export const PROJECT_CODE_WARNING =
  'This command runs code from the project, which can do anything you can do.';

const SWITCH_TEXT: Record<PermissionSwitch, { label: string; description: string }> = {
  'read-outside': {
    label: 'Reads outside the folder',
    description:
      "Read and search files anywhere on this machine. Credential locations and AgentCanopy's own storage still ask.",
  },
  'web-fetch': { label: 'Web fetch', description: 'Fetch any web address.' },
  'web-search': { label: 'Web search', description: 'Run any web search.' },
};

const GROUPS: { kind: SavedPermissionKind; title: string }[] = [
  { kind: 'read-directory', title: 'Folders' },
  { kind: 'web-site', title: 'Web sites' },
  { kind: 'command', title: 'Commands' },
  { kind: 'mcp-tool', title: 'Tools' },
];

const ALWAYS_ASKS: { what: string; why: string }[] = [
  {
    what: 'Edits outside the folder.',
    why: 'Review and checkpoints cannot undo them.',
  },
  {
    what: 'Edits to protected files.',
    why: 'They can run code or change approvals later.',
  },
  {
    what: 'Tools that are not from a tool server, such as skills and background commands.',
    why: 'No rule for them can be checked.',
  },
  {
    what: "Credential locations and AgentCanopy's own storage.",
    why: 'They ask also with a switch on or inside a saved folder.',
  },
];

const onOff = (value: boolean): string => (value ? 'On' : 'Off');

const SETTINGS_ROWS: {
  label: string;
  id: string;
  value: (s: PolicySettings) => string;
}[] = [
  {
    label: 'Edits inside the folder',
    id: 'agentCanopy.agent.editApproval',
    value: (s) => (s.editApproval === 'auto' ? 'Without asking' : 'Ask'),
  },
  {
    label: 'Always ask for commands and tools',
    id: 'agentCanopy.agent.alwaysAskCommands',
    value: (s) => onOff(s.alwaysAskCommands),
  },
  {
    label: 'Web tools in Ask and Plan',
    id: 'agentCanopy.ask.webTools',
    value: (s) => onOff(s.askWebTools),
  },
  {
    label: 'Auto offered in Agent mode',
    id: 'agentCanopy.agent.auto.enabled',
    value: (s) => onOff(s.autoOffered),
  },
  {
    label: 'Auto covers web tools',
    id: 'agentCanopy.agent.auto.webTools',
    value: (s) => onOff(s.autoWebTools),
  },
  {
    label: 'Sandbox for commands',
    id: 'agentCanopy.agent.sandbox',
    value: (s) => onOff(s.sandbox),
  },
];

/** What is in use for the control that was just pressed, to put focus back when the lock lifts. */
interface PressedControl {
  key: string;
  /** Its position among all the view's controls, to find a neighbour if it is gone. */
  order: number;
}

/**
 * The Permissions tab: what is allowed without asking in the folder of this view, what is saved, what
 * always asks, and the machine-wide settings. Adding anything happens in a native dialog on the host;
 * this view can only ask for it, and can take things away.
 */
export function PermissionsView() {
  const post = usePost();
  const permissions = useViewState((s) => s.permissions);
  const settings = useViewState((s) => s.policySettings);
  const trusted = useViewState((s) => s.trusted);
  const reasonId = useId();
  const webNoteId = useId();
  const scroller = useRef<HTMLDivElement>(null);
  const pressed = useRef<PressedControl | null>(null);
  // Every control that changes something stays locked after a click until the host sends the
  // permissions again (also when nothing changed): the new object ends the lock.
  const [sent, setSent] = useState<FolderPermissions | null>(null);
  const locked = sent === permissions;

  // The Remove that was pressed goes away with its entry, and every pressed control is disabled
  // while the lock holds: focus must not be lost to the page.
  useFocusRecovery(scroller, { fallback: 'h2' });

  const reason = !trusted
    ? UNTRUSTED_REASON
    : permissions.folder === null
      ? NO_FOLDER_REASON
      : null;
  const disabled = reason !== null || locked;

  // When the lock lifts, focus goes back to the control that was pressed, or to the one now in its place.
  useLayoutEffect(() => {
    const info = pressed.current;
    if (info === null || locked) return;
    pressed.current = null;
    const root = scroller.current;
    if (!root) return;
    const active = document.activeElement;
    const lost =
      !active ||
      active === document.body ||
      active === root ||
      (active.tagName === 'H2' && root.contains(active));
    if (!lost) return;
    const controls = Array.from(root.querySelectorAll<HTMLElement>('[data-focus-key]')).filter(
      (c) => !(c as HTMLButtonElement).disabled,
    );
    const target =
      controls.find((c) => c.dataset['focusKey'] === info.key) ??
      controls[Math.min(info.order, controls.length - 1)];
    target?.focus();
  });

  const change = (key: string, message: WebviewMessage) => {
    if (disabled) return;
    const controls = Array.from(
      scroller.current?.querySelectorAll<HTMLElement>('[data-focus-key]') ?? [],
    );
    pressed.current = {
      key,
      order: controls.findIndex((c) => c.dataset['focusKey'] === key),
    };
    post(message);
    setSent(permissions);
  };

  const describedBy = (...ids: (string | undefined)[]): string | undefined => {
    const list = ids.filter((id) => id !== undefined);
    return list.length > 0 ? list.join(' ') : undefined;
  };
  const reasonRef = reason !== null ? reasonId : undefined;

  return (
    <div className="permissions">
      <div ref={scroller} className="permissions-scroll" tabIndex={-1}>
        <div className="column">
          {reason !== null && (
            <p id={reasonId} className="permissions-reason">
              <Icon name="info" />
              <span>{reason}</span>
            </p>
          )}

          <Section title="Allowed without asking in this folder">
            <ul className="permissions-list">
              {PERMISSION_SWITCHES.map((name) => (
                <SwitchRow
                  key={name}
                  name={name}
                  on={permissions.switches.includes(name)}
                  disabled={disabled}
                  describedBy={(own) =>
                    describedBy(
                      own,
                      name !== 'read-outside' && !settings.askWebTools ? webNoteId : undefined,
                      reasonRef,
                    )
                  }
                  onToggle={(on) => {
                    change(`switch:${name}`, { type: 'permissions.setSwitch', name, on });
                  }}
                />
              ))}
            </ul>
            {!settings.askWebTools && (
              <p id={webNoteId} className="muted permissions-note">
                {WEB_TOOLS_NOTE}
              </p>
            )}
          </Section>

          <Section title="Saved permissions">
            {permissions.saved.length === 0 && (
              <p className="permissions-empty">Nothing is saved for this folder yet.</p>
            )}
            {GROUPS.map(({ kind, title }) => {
              const entries = permissions.saved.filter((entry) => entry.kind === kind);
              return entries.length > 0 ? (
                <Group key={kind} title={title}>
                  <ul className="permissions-list">
                    {entries.map((entry) => (
                      <EntryRow
                        key={entry.id}
                        entry={entry}
                        disabled={disabled}
                        describedBy={reasonRef}
                        onRemove={() => {
                          change(`remove:${entry.id}`, {
                            type: 'permissions.remove',
                            id: entry.id,
                          });
                        }}
                      />
                    ))}
                  </ul>
                </Group>
              ) : null;
            })}
            <div className="permissions-actions">
              <button
                type="button"
                className="button button--secondary"
                data-focus-key="add"
                disabled={disabled}
                aria-describedby={reasonRef}
                onClick={() => {
                  change('add', { type: 'permissions.addDirectory' });
                }}
              >
                Allow a folder...
              </button>
            </div>
          </Section>

          <Section title="Always asks">
            <ul className="permissions-list permissions-list--plain">
              {ALWAYS_ASKS.map((item) => (
                <li key={item.what} className="permissions-ask">
                  <span className="permissions-label">{item.what}</span>{' '}
                  <span className="muted">{item.why}</span>
                </li>
              ))}
            </ul>
          </Section>

          <Section title="Settings for every project">
            <dl className="permissions-settings">
              {SETTINGS_ROWS.map((row) => (
                <div key={row.id} className="permissions-setting">
                  <dt className="permissions-label">{row.label}</dt>
                  <dd>
                    <span className="permissions-value">{row.value(settings)}</span>{' '}
                    <code className="permissions-code">{row.id}</code>
                  </dd>
                </div>
              ))}
            </dl>
            <div className="permissions-actions">
              <button
                type="button"
                className="button button--secondary"
                onClick={() => {
                  post({ type: 'settings.open' });
                }}
              >
                Open Settings
              </button>
            </div>
          </Section>
        </div>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <section className="permissions-section" aria-labelledby={id}>
      <h2 id={id} className="permissions-heading" tabIndex={-1}>
        {title}
      </h2>
      {children}
    </section>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <section className="permissions-group" aria-labelledby={id}>
      <h3 id={id} className="permissions-subheading">
        {title}
      </h3>
      {children}
    </section>
  );
}

function SwitchRow({
  name,
  on,
  disabled,
  describedBy,
  onToggle,
}: {
  name: PermissionSwitch;
  on: boolean;
  disabled: boolean;
  /** The ids the switch is described by: its own line first, then whatever else applies. */
  describedBy: (own: string) => string | undefined;
  onToggle: (on: boolean) => void;
}) {
  const labelId = useId();
  const descriptionId = useId();
  const text = SWITCH_TEXT[name];
  return (
    <li className="permissions-row">
      <div className="permissions-row-text">
        <span id={labelId} className="permissions-label">
          {text.label}
        </span>
        <span id={descriptionId} className="muted permissions-description">
          {text.description}
        </span>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-labelledby={labelId}
        aria-describedby={describedBy(descriptionId)}
        className={`button button--secondary permissions-switch${on ? ' permissions-switch--on' : ''}`}
        data-focus-key={`switch:${name}`}
        disabled={disabled}
        onClick={() => {
          onToggle(!on);
        }}
      >
        <Icon name={on ? 'pass-filled' : 'circle-large-outline'} />
        <span>{on ? 'Allow' : 'Ask'}</span>
      </button>
    </li>
  );
}

function EntryRow({
  entry,
  disabled,
  describedBy,
  onRemove,
}: {
  entry: SavedPermission;
  disabled: boolean;
  describedBy: string | undefined;
  onRemove: () => void;
}) {
  return (
    <li className="permissions-row">
      <div className="permissions-row-text">
        <code className="permissions-code">{entry.text}</code>
        {entry.kind === 'command' && entry.shell !== undefined && (
          <span className="muted permissions-shell">
            {entry.shell === 'bash' ? 'Bash' : 'PowerShell'}
          </span>
        )}
        {entry.kind === 'command' && entry.runsProjectCode === true && (
          <p className="prompt-warning">
            <Icon name="warning" />
            <span>
              <VisuallyHidden>Warning: </VisuallyHidden>
              {PROJECT_CODE_WARNING}
            </span>
          </p>
        )}
      </div>
      <button
        type="button"
        className="button button--secondary"
        aria-label={`Remove ${entry.text}`}
        data-focus-key={`remove:${entry.id}`}
        disabled={disabled}
        aria-describedby={describedBy}
        onClick={onRemove}
      >
        Remove
      </button>
    </li>
  );
}
