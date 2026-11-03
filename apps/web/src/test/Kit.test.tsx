import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Select, Tabs } from '../ui/kit';
import { parseDiff } from '../ui/diff';

function Pick({ onChange }: { onChange: (v: string) => void }) {
  const [v, setV] = useState('b');
  return (
    <Select
      label="Model"
      value={v}
      onChange={(x) => (setV(x), onChange(x))}
      options={[
        { value: 'a', label: 'Alpha' },
        { value: 'b', label: 'Beta' },
        { value: 'c', label: 'Gamma', disabled: true },
        { value: 'd', label: 'Delta' },
      ]}
    />
  );
}

describe('Select', () => {
  it('is a labelled combobox driven by the keyboard, skipping disabled options', async () => {
    const onChange = vi.fn();
    render(<Pick onChange={onChange} />);
    const user = userEvent.setup();
    const box = screen.getByRole('combobox', { name: 'Model' });
    expect(box.textContent).toContain('Beta');
    box.focus();
    await user.keyboard('{ArrowDown}');
    expect(box.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('listbox', { name: 'Model' })).toBeTruthy();
    expect(box.getAttribute('aria-activedescendant')).toMatch(/-opt-1$/);
    await user.keyboard('{ArrowDown}');
    expect(box.getAttribute('aria-activedescendant')).toMatch(/-opt-3$/);
    await user.keyboard('{Enter}');
    expect(onChange).toHaveBeenLastCalledWith('d');
    expect(screen.queryByRole('listbox')).toBeNull();
    await user.keyboard('{ArrowDown}a{Enter}');
    expect(onChange).toHaveBeenLastCalledWith('a');
    await user.keyboard('{ArrowDown}{Escape}');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(document.activeElement).toBe(box);
  });
});

describe('Tabs', () => {
  it('moves with arrow keys and marks the selected tab', async () => {
    function T() {
      const [v, setV] = useState('one');
      return (
        <Tabs
          label="Sections"
          value={v}
          onChange={setV}
          tabs={[
            { id: 'one', label: 'One' },
            { id: 'two', label: 'Two' },
          ]}
        />
      );
    }
    render(<T />);
    const user = userEvent.setup();
    screen.getByRole('tab', { name: 'One' }).focus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Two' }).getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Two' }));
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'One' }).getAttribute('aria-selected')).toBe('true');
  });
});

describe('parseDiff', () => {
  it('reads files, statuses, counts and line numbers', () => {
    const files = parseDiff(
      [
        'diff --git a/src/app.ts b/src/app.ts',
        'index 1..2 100644',
        '--- a/src/app.ts',
        '+++ b/src/app.ts',
        '@@ -1,3 +1,4 @@',
        ' import x',
        '-old()',
        '+next()',
        '+more()',
        ' end',
        'diff --git a/new.md b/new.md',
        'new file mode 100644',
        '--- /dev/null',
        '+++ b/new.md',
        '@@ -0,0 +1 @@',
        '+hello',
        'diff --git a/logo.png b/logo.png',
        'Binary files a/logo.png and b/logo.png differ',
      ].join('\n'),
    );
    expect(files.map((f) => [f.path, f.status, f.additions, f.deletions])).toEqual([
      ['src/app.ts', 'modified', 2, 1],
      ['new.md', 'added', 1, 0],
      ['logo.png', 'modified', 0, 0],
    ]);
    const lines = files[0]!.lines;
    expect(lines[1]).toEqual({ kind: 'ctx', text: 'import x', oldNo: 1, newNo: 1 });
    expect(lines[2]).toEqual({ kind: 'del', text: 'old()', oldNo: 2 });
    expect(lines[3]).toEqual({ kind: 'add', text: 'next()', newNo: 2 });
    expect(lines[5]).toEqual({ kind: 'ctx', text: 'end', oldNo: 3, newNo: 4 });
    expect(files[2]!.lines).toEqual([{ kind: 'hunk', text: 'Binary file changed' }]);
  });
});
