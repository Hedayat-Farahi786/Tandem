import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClientProvider } from '@tanstack/react-query';
import { makeQueryClient } from '../App';
import { ToastProvider } from '../ui/kit';
import { RunnerControls } from '../ui/runner-section';
import { mockApi } from './helpers';

const cloud = { role: 'owner', runner: { mode: 'cloud', connected: false } };
const show = () =>
  render(
    <ToastProvider>
      <QueryClientProvider client={makeQueryClient()}>
        <RunnerControls />
      </QueryClientProvider>
    </ToastProvider>,
  );

async function moveToCompany(answer: object) {
  mockApi({ 'GET /api/workspace': cloud, 'POST /api/workspace/runner': answer });
  const user = userEvent.setup();
  show();
  await user.click(await screen.findByRole('button', { name: 'Use a company computer' }));
  const dialog = await screen.findByRole('dialog', { name: 'Work on a company computer?' });
  await user.click(within(dialog).getByRole('button', { name: 'Make a runner key' }));
}

describe('Moving a workspace to a company computer', () => {
  it('shows how to install Tandem there, then how to start the runner', async () => {
    await moveToCompany({ key: 'tdr_x', install: 'npm install -g https://app.example.com/download/tandem.tgz', command: 'tandem runner --url https://app.example.com --key tdr_x' });
    expect(await screen.findByText('On the company computer, install Tandem once:')).toBeTruthy();
    expect(screen.getByText('npm install -g https://app.example.com/download/tandem.tgz')).toBeTruthy();
    expect(screen.getByText('Then start the runner:')).toBeTruthy();
    expect(screen.getByText('tandem runner --url https://app.example.com --key tdr_x')).toBeTruthy();
    expect(screen.getByText(/Waiting for the runner to connect/)).toBeTruthy();
  });

  it('shows only the runner command when the web app offers no package', async () => {
    await moveToCompany({ key: 'tdr_y', command: 'tandem runner --url https://app.example.com --key tdr_y' });
    expect(await screen.findByText('On the company computer, run:')).toBeTruthy();
    expect(screen.getByText('tandem runner --url https://app.example.com --key tdr_y')).toBeTruthy();
    expect(screen.queryByText(/npm install/)).toBeNull();
    expect(screen.getByText(/a copy of Tandem \(the same one your team runs locally\)/)).toBeTruthy();
  });
});
