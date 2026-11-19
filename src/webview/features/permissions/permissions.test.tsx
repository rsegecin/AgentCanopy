// @vitest-environment jsdom
import { fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PERMISSION_SWITCHES, EMPTY_VIEW_STATE } from '../../../shared';
import type { FolderPermissions, PermissionSwitch, ViewState } from '../../../shared';
import { makeFolderPermissions, makeSavedPermission, makeState } from '../../test-support/fixtures';
import { renderWithHost } from '../../test-support/harness';
import {
  NO_FOLDER_REASON,
  PROJECT_CODE_WARNING,
  PermissionsView,
  UNTRUSTED_REASON,
  WEB_TOOLS_NOTE,
} from './PermissionsView';

const FULL: FolderPermissions = makeFolderPermissions({
  switches: ['read-outside'],
  saved: [
    makeSavedPermission('d1', { kind: 'read-directory', text: '/libs/shared' }),
    makeSavedPermission('e1', { kind: 'edit-directory', text: '/libs/generated' }),
    makeSavedPermission('w1', { kind: 'web-site', text: 'docs.example.com' }),
    makeSavedPermission('c1', {
      kind: 'command',
      text: 'npm test',
      shell: 'bash',
      runsProjectCode: true,
    }),
    makeSavedPermission('c2', { kind: 'command', text: 'Get-Date', shell: 'powershell' }),
    makeSavedPermission('t1', { kind: 'mcp-tool', text: 'mcp__docs__search' }),
  ],
});

const stateWith = (permissions: FolderPermissions, over: Partial<ViewState> = {}): ViewState =>
  makeState({ permissions, ...over });

const renderView = (permissions: FolderPermissions = FULL, over: Partial<ViewState> = {}) =>
  renderWithHost(<PermissionsView />, stateWith(permissions, over));

const section = (name: string) => screen.getByRole('region', { name });
const switchOf = (label: string) => screen.getByRole<HTMLButtonElement>('switch', { name: label });
const describedBy = (el: HTMLElement) =>
  (el.getAttribute('aria-describedby') ?? '')
    .split(' ')
    .filter((id) => id !== '')
    .map((id) => document.getElementById(id)?.textContent ?? '');

describe('Permissions view: sections', () => {
  it('shows the four sections in order, each with an h2', () => {
    renderView();
    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual([
      'Allowed without asking in this folder',
      'Saved permissions',
      'Always asks',
      'Settings for every project',
    ]);
  });

  it('shows the three switches in the order of the contract, with their words and descriptions', () => {
    renderView(FULL, { policySettings: { ...EMPTY_VIEW_STATE.policySettings, askWebTools: true } });
    const switches = within(section('Allowed without asking in this folder')).getAllByRole(
      'switch',
    );
    expect(switches.map((s) => s.getAttribute('aria-labelledby'))).toHaveLength(3);
    expect(
      switches.map(
        (s) => document.getElementById(s.getAttribute('aria-labelledby') ?? '')?.textContent,
      ),
    ).toEqual(['Reads outside the folder', 'Web fetch', 'Web search']);
    expect(PERMISSION_SWITCHES).toEqual(['read-outside', 'web-fetch', 'web-search']);
    expect(describedBy(switchOf('Reads outside the folder'))).toEqual([
      "Read and search files anywhere on this machine. Credential locations and AgentCanopy's own storage still ask, except Claude Code's memory for this folder.",
    ]);
    expect(describedBy(switchOf('Web fetch'))).toEqual(['Fetch any web address.']);
    expect(describedBy(switchOf('Web search'))).toEqual(['Run any web search.']);
  });

  it('says on and off in words and in aria-checked, not by colour alone', () => {
    renderView();
    const on = switchOf('Reads outside the folder');
    const off = switchOf('Web fetch');
    expect(on.getAttribute('role')).toBe('switch');
    expect(on.getAttribute('type')).toBe('button');
    expect(on.getAttribute('aria-checked')).toBe('true');
    expect(on.textContent).toBe('Allow');
    expect(on.classList.contains('permissions-switch--on')).toBe(true);
    expect(off.getAttribute('aria-checked')).toBe('false');
    expect(off.textContent).toBe('Ask');
    expect(off.classList.contains('permissions-switch--on')).toBe(false);
  });

  it('groups saved entries by kind under h3 headings, and leaves out empty groups', () => {
    renderView();
    const saved = section('Saved permissions');
    expect(
      within(saved)
        .getAllByRole('heading', { level: 3 })
        .map((h) => h.textContent),
    ).toEqual(['Folders (read)', 'Folders (read and edit)', 'Web sites', 'Commands', 'Tools']);
    const folders = within(section('Folders (read)'));
    expect(folders.getAllByRole('listitem')).toHaveLength(1);
    expect(folders.getByText('/libs/shared').tagName).toBe('CODE');
    const editFolders = within(section('Folders (read and edit)'));
    expect(editFolders.getAllByRole('listitem')).toHaveLength(1);
    expect(editFolders.getByText('/libs/generated').tagName).toBe('CODE');
    expect(within(section('Web sites')).getByText('docs.example.com').tagName).toBe('CODE');
    expect(within(section('Commands')).getAllByRole('listitem')).toHaveLength(2);
    expect(within(section('Tools')).getByText('mcp__docs__search').tagName).toBe('CODE');
  });

  it('shows only the groups that have entries', () => {
    renderView(
      makeFolderPermissions({
        saved: [makeSavedPermission('w1', { kind: 'web-site', text: 'a.example.com' })],
      }),
    );
    expect(screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual([
      'Web sites',
    ]);
    expect(screen.queryByText('Nothing is saved for this folder yet.')).toBeNull();
  });

  it('shows the shell of a command, and the warning only when it runs project code', () => {
    renderView();
    const commands = within(section('Commands')).getAllByRole('listitem');
    const [bash, powershell] = commands as [HTMLElement, HTMLElement];
    expect(within(bash).getByText('npm test').tagName).toBe('CODE');
    expect(within(bash).getByText('Bash')).toBeTruthy();
    expect(within(bash).getByText(PROJECT_CODE_WARNING)).toBeTruthy();
    expect(bash.querySelector('.visually-hidden')?.textContent).toBe('Warning: ');
    expect(bash.querySelector('.codicon-warning')?.getAttribute('aria-hidden')).toBe('true');
    expect(within(powershell).getByText('PowerShell')).toBeTruthy();
    expect(within(powershell).queryByText(PROJECT_CODE_WARNING)).toBeNull();
    // Entries of other kinds never show a shell or the warning.
    expect(within(section('Folders (read)')).queryByText(PROJECT_CODE_WARNING)).toBeNull();
    expect(within(section('Folders (read and edit)')).queryByText(PROJECT_CODE_WARNING)).toBeNull();
  });

  it('says what is saved for nothing: the empty state, with the two buttons that add a folder below', () => {
    renderView(makeFolderPermissions());
    expect(screen.getByText('Nothing is saved for this folder yet.')).toBeTruthy();
    expect(screen.queryAllByRole('heading', { level: 3 })).toHaveLength(0);
    expect(screen.queryByRole('button', { name: /^Remove/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Allow reads in a folder...' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Allow edits in a folder...' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Allow a folder...' })).toBeNull();
  });

  it('lists what always asks, with the reasons', () => {
    renderView();
    const items = within(section('Always asks')).getAllByRole('listitem');
    expect(items).toHaveLength(4);
    expect(items[0]?.textContent).toContain(
      'Edits outside the folder, except in folders you allowed for edits.',
    );
    expect(items[0]?.textContent).toContain('Review and checkpoints cannot undo them.');
    expect(items[1]?.textContent).toContain('Edits to protected files.');
    expect(items[1]?.textContent).toContain('They ask also inside a folder allowed for edits.');
    expect(items[2]?.textContent).toContain('skills and background commands');
    expect(items[3]?.textContent).toContain("AgentCanopy's own storage");
    expect(items[3]?.textContent).toContain("reading Claude Code's memory for this folder");
  });

  it('shows the six settings read-only, each with its value in words and its id', () => {
    renderView(FULL, {
      policySettings: {
        editApproval: 'ask',
        alwaysAskCommands: true,
        askWebTools: true,
        autoOffered: false,
        autoWebTools: true,
        sandbox: false,
      },
    });
    const rows = Array.from(section('Settings for every project').querySelectorAll('dl > div')).map(
      (row) => [
        row.querySelector('dt')?.textContent,
        row.querySelector('.permissions-value')?.textContent,
        row.querySelector('code')?.textContent,
      ],
    );
    expect(rows).toEqual([
      ['Edits inside the folder', 'Ask', 'agentCanopy.agent.editApproval'],
      ['Always ask for commands and tools', 'On', 'agentCanopy.agent.alwaysAskCommands'],
      ['Web tools in Ask and Plan', 'On', 'agentCanopy.ask.webTools'],
      ['Auto offered in Agent mode', 'Off', 'agentCanopy.agent.auto.enabled'],
      ['Auto covers web tools', 'On', 'agentCanopy.agent.auto.webTools'],
      ['Sandbox for commands', 'Off', 'agentCanopy.agent.sandbox'],
    ]);
  });

  it('says Without asking for edits inside the folder when the setting is auto', () => {
    renderView(FULL, {
      policySettings: { ...EMPTY_VIEW_STATE.policySettings, editApproval: 'auto' },
    });
    expect(
      section('Settings for every project').querySelector('.permissions-value')?.textContent,
    ).toBe('Without asking');
  });

  it('shows the web note only while Ask and Plan have web tools off, and ties it to the web switches', () => {
    const off = { ...EMPTY_VIEW_STATE.policySettings, askWebTools: false };
    const { init } = renderView(FULL, { policySettings: off });
    expect(screen.getByText(WEB_TOOLS_NOTE)).toBeTruthy();
    expect(describedBy(switchOf('Web fetch'))).toContain(WEB_TOOLS_NOTE);
    expect(describedBy(switchOf('Web search'))).toContain(WEB_TOOLS_NOTE);
    expect(describedBy(switchOf('Reads outside the folder'))).not.toContain(WEB_TOOLS_NOTE);
    init(stateWith(FULL, { policySettings: { ...off, askWebTools: true } }), 1);
    expect(screen.queryByText(WEB_TOOLS_NOTE)).toBeNull();
    expect(describedBy(switchOf('Web fetch'))).not.toContain(WEB_TOOLS_NOTE);
  });
});

describe('Permissions view: messages', () => {
  it.each([
    ['Reads outside the folder', 'read-outside', false],
    ['Web fetch', 'web-fetch', true],
    ['Web search', 'web-search', true],
  ] as [string, PermissionSwitch, boolean][])(
    'posts %s with the opposite of its state',
    (label, name, on) => {
      const { host } = renderView();
      fireEvent.click(switchOf(label));
      expect(host.postedOf('permissions.setSwitch')).toEqual([
        { type: 'permissions.setSwitch', name, on },
      ]);
    },
  );

  it('posts permissions.remove with the id of the entry, named after its text', () => {
    const { host } = renderView();
    fireEvent.click(screen.getByRole('button', { name: 'Remove docs.example.com' }));
    expect(host.postedOf('permissions.remove')).toEqual([{ type: 'permissions.remove', id: 'w1' }]);
  });

  it('gives each Remove the name of its own entry', () => {
    renderView();
    expect(
      screen.getAllByRole('button', { name: /^Remove / }).map((b) => b.getAttribute('aria-label')),
    ).toEqual([
      'Remove /libs/shared',
      'Remove /libs/generated',
      'Remove docs.example.com',
      'Remove npm test',
      'Remove Get-Date',
      'Remove mcp__docs__search',
    ]);
  });

  it('posts permissions.addDirectory', () => {
    const { host } = renderView();
    fireEvent.click(screen.getByRole('button', { name: 'Allow reads in a folder...' }));
    expect(host.postedOf('permissions.addDirectory')).toEqual([
      { type: 'permissions.addDirectory' },
    ]);
    expect(host.postedOf('permissions.addEditDirectory')).toEqual([]);
  });

  it('posts permissions.addEditDirectory', () => {
    const { host } = renderView();
    fireEvent.click(screen.getByRole('button', { name: 'Allow edits in a folder...' }));
    expect(host.postedOf('permissions.addEditDirectory')).toEqual([
      { type: 'permissions.addEditDirectory' },
    ]);
    expect(host.postedOf('permissions.addDirectory')).toEqual([]);
  });

  it('posts settings.open', () => {
    const { host } = renderView();
    fireEvent.click(screen.getByRole('button', { name: 'Open Settings' }));
    expect(host.postedOf('settings.open')).toEqual([{ type: 'settings.open' }]);
  });
});

describe('Permissions view: disabled', () => {
  const changing = () => [
    ...screen.getAllByRole<HTMLButtonElement>('switch'),
    ...screen.getAllByRole<HTMLButtonElement>('button', { name: /^Remove / }),
    screen.getByRole<HTMLButtonElement>('button', { name: 'Allow reads in a folder...' }),
    screen.getByRole<HTMLButtonElement>('button', { name: 'Allow edits in a folder...' }),
  ];

  it('disables everything that changes something when the workspace is not trusted, and says why', () => {
    const { host } = renderView(FULL, { trusted: false });
    const controls = changing();
    expect(controls).toHaveLength(11);
    for (const control of controls) {
      expect(control.disabled, control.outerHTML).toBe(true);
      expect(describedBy(control)).toContain(UNTRUSTED_REASON);
      fireEvent.click(control);
    }
    expect(screen.getByText(UNTRUSTED_REASON)).toBeTruthy();
    expect(host.posted.filter((m) => m.type !== 'ready')).toEqual([]);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Open Settings' }).disabled).toBe(
      false,
    );
  });

  it('disables everything that changes something without a folder, and says why', () => {
    renderView(makeFolderPermissions({ folder: null, saved: FULL.saved }));
    for (const control of changing()) {
      expect(control.disabled, control.outerHTML).toBe(true);
      expect(describedBy(control)).toContain(NO_FOLDER_REASON);
    }
    expect(screen.getByText(NO_FOLDER_REASON)).toBeTruthy();
    expect(screen.queryByText(UNTRUSTED_REASON)).toBeNull();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Open Settings' }).disabled).toBe(
      false,
    );
  });

  it('gives the untrusted reason precedence over the missing folder', () => {
    renderView(makeFolderPermissions({ folder: null }), { trusted: false });
    expect(screen.getByText(UNTRUSTED_REASON)).toBeTruthy();
    expect(screen.queryByText(NO_FOLDER_REASON)).toBeNull();
  });

  it('shows no reason and enables the controls when the folder is usable', () => {
    renderView();
    expect(screen.queryByText(UNTRUSTED_REASON)).toBeNull();
    expect(screen.queryByText(NO_FOLDER_REASON)).toBeNull();
    for (const control of changing()) {
      expect(control.disabled).toBe(false);
      expect(describedBy(control)).not.toContain(UNTRUSTED_REASON);
    }
  });
});

describe('Permissions view: lock after a click', () => {
  const patchPermissions = (host: ReturnType<typeof renderView>['host'], seq: number) => {
    // Equal content, a new object: the host sends the permissions again after it handled a message.
    host.emit({
      type: 'patch',
      seq,
      ops: [{ op: 'set', path: ['permissions'], value: structuredClone(FULL) }],
    });
  };

  it('disables every changing control after a click, and releases them when the host answers', () => {
    const { host } = renderView();
    fireEvent.click(switchOf('Web fetch'));
    for (const control of [
      ...screen.getAllByRole<HTMLButtonElement>('switch'),
      ...screen.getAllByRole<HTMLButtonElement>('button', { name: /^Remove / }),
      screen.getByRole<HTMLButtonElement>('button', { name: 'Allow reads in a folder...' }),
      screen.getByRole<HTMLButtonElement>('button', { name: 'Allow edits in a folder...' }),
    ]) {
      expect(control.disabled, control.outerHTML).toBe(true);
    }
    // Locked: a second click posts nothing.
    fireEvent.click(switchOf('Web search'));
    expect(host.postedOf('permissions.setSwitch')).toHaveLength(1);
    // Open Settings is never locked.
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Open Settings' }).disabled).toBe(
      false,
    );

    patchPermissions(host, 1);
    for (const control of screen.getAllByRole<HTMLButtonElement>('switch')) {
      expect(control.disabled).toBe(false);
    }
    for (const name of ['Allow reads in a folder...', 'Allow edits in a folder...']) {
      expect(screen.getByRole<HTMLButtonElement>('button', { name }).disabled).toBe(false);
    }
    fireEvent.click(switchOf('Web search'));
    expect(host.postedOf('permissions.setSwitch')).toHaveLength(2);
  });

  it('locks after Remove and the buttons that allow a folder too', () => {
    const { host } = renderView();
    fireEvent.click(screen.getByRole('button', { name: 'Allow reads in a folder...' }));
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Remove npm test' }).disabled,
    ).toBe(true);
    patchPermissions(host, 1);
    fireEvent.click(screen.getByRole('button', { name: 'Allow edits in a folder...' }));
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Remove npm test' }).disabled,
    ).toBe(true);
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Allow reads in a folder...' })
        .disabled,
    ).toBe(true);
    // Locked: a second click posts nothing.
    fireEvent.click(screen.getByRole('button', { name: 'Allow reads in a folder...' }));
    expect(host.postedOf('permissions.addDirectory')).toHaveLength(1);
    expect(host.postedOf('permissions.addEditDirectory')).toHaveLength(1);
    patchPermissions(host, 2);
    fireEvent.click(screen.getByRole('button', { name: 'Remove npm test' }));
    expect(switchOf('Web fetch').disabled).toBe(true);
    expect(host.postedOf('permissions.remove')).toEqual([{ type: 'permissions.remove', id: 'c1' }]);
  });

  it('does not release the lock for a change elsewhere in the state', () => {
    const { host } = renderView();
    fireEvent.click(switchOf('Web fetch'));
    host.emit({ type: 'patch', seq: 1, ops: [{ op: 'set', path: ['trusted'], value: true }] });
    expect(switchOf('Web fetch').disabled).toBe(true);
  });
});

describe('Permissions view: focus', () => {
  it('puts focus back on the switch that was pressed when the lock lifts', () => {
    const { host } = renderView();
    switchOf('Web fetch').focus();
    fireEvent.click(switchOf('Web fetch'));
    // While the lock holds the switch is disabled and focus has gone to a heading.
    expect(document.activeElement?.tagName).toBe('H2');
    // The host answers with the switch on.
    host.emit({
      type: 'patch',
      seq: 1,
      ops: [
        {
          op: 'set',
          path: ['permissions'],
          value: { ...FULL, switches: ['read-outside', 'web-fetch'] },
        },
      ],
    });
    expect(switchOf('Web fetch').getAttribute('aria-checked')).toBe('true');
    expect(document.activeElement).toBe(switchOf('Web fetch'));
  });

  it('moves to the neighbouring Remove when an entry is removed', () => {
    const { host } = renderView();
    screen.getByRole('button', { name: 'Remove docs.example.com' }).focus();
    fireEvent.click(screen.getByRole('button', { name: 'Remove docs.example.com' }));
    host.emit({
      type: 'patch',
      seq: 1,
      ops: [
        {
          op: 'set',
          path: ['permissions'],
          value: { ...FULL, saved: FULL.saved.filter((e) => e.id !== 'w1') },
        },
      ],
    });
    expect(screen.queryByText('docs.example.com')).toBeNull();
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Remove npm test');
  });

  it('does not take focus from somewhere else when the lock lifts', () => {
    const { host } = renderView();
    fireEvent.click(switchOf('Web fetch'));
    const settings = screen.getByRole<HTMLButtonElement>('button', { name: 'Open Settings' });
    settings.focus();
    host.emit({
      type: 'patch',
      seq: 1,
      ops: [{ op: 'set', path: ['permissions'], value: structuredClone(FULL) }],
    });
    expect(document.activeElement).toBe(settings);
  });
});
