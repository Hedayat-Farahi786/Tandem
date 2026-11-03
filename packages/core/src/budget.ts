import type { Settings } from '@tandem/shared';
import type { Clock, Store } from './ports.js';

export class BudgetError extends Error {
  override readonly name = 'BudgetError';
}

const NANO = 1e9;
const credits = (n: number) => (Math.round(n * 100) / 100).toString();

export interface BudgetSummary {
  today: number;
  perDay: number;
  task?: number;
  perTask: number;
  credits: { today: number; perDay: number; task?: number; perTask: number };
}

/**
 * Copilot is often a shared plan: prompts and AI credits are metered per task and per day, with
 * hard limits. Prompts are checked before each prompt; credits also stop a run while it works.
 */
export class Budget {
  constructor(
    private readonly store: Store,
    private readonly clock: Clock,
    private readonly settings: () => Promise<Settings>,
  ) {}

  private since(): string {
    const dayStart = new Date(this.clock.now());
    dayStart.setHours(0, 0, 0, 0);
    return dayStart.toISOString();
  }

  private async nanoAiu(scope: { taskId?: string; since?: string }): Promise<number> {
    return (await this.store.usage.list(scope)).reduce((n, u) => n + u.nanoAiu, 0);
  }

  /** Throws BudgetError with a plain message when another prompt would go over a limit. */
  async assertCanSend(taskId?: string): Promise<void> {
    const s = (await this.settings()).budget;
    const since = this.since();
    const today = await this.store.usage.prompts({ since });
    if (today >= s.perDayPrompts) {
      throw new BudgetError(`Today's Copilot limit is used up (${today} of ${s.perDayPrompts} prompts). Raise it in Settings or continue tomorrow.`);
    }
    const todayCredits = (await this.nanoAiu({ since })) / NANO;
    if (todayCredits >= s.perDayCredits) {
      throw new BudgetError(`Today's Copilot credits are used up (${credits(todayCredits)} of ${s.perDayCredits}). Raise the limit in Settings or continue tomorrow.`);
    }
    if (taskId) {
      const used = await this.store.usage.prompts({ taskId });
      if (used >= s.perTaskPrompts) throw new BudgetError(`This task used its Copilot limit (${used} of ${s.perTaskPrompts} prompts). Raise it in Settings to continue.`);
      const taskCredits = (await this.nanoAiu({ taskId })) / NANO;
      if (taskCredits >= s.perTaskCredits) throw new BudgetError(`This task used its Copilot credits (${credits(taskCredits)} of ${s.perTaskCredits}). Raise the limit in Settings to continue.`);
    }
  }

  /** Nano-AIU the next run may use before a task or day credit limit is reached. */
  async remainingNanoAiu(taskId?: string): Promise<number> {
    const s = (await this.settings()).budget;
    let left = s.perDayCredits * NANO - (await this.nanoAiu({ since: this.since() }));
    if (taskId) left = Math.min(left, s.perTaskCredits * NANO - (await this.nanoAiu({ taskId })));
    return Math.max(0, left);
  }

  /** The message for a run stopped by remainingNanoAiu(). */
  async limitMessage(taskId?: string): Promise<string> {
    const s = (await this.settings()).budget;
    const day = (await this.nanoAiu({ since: this.since() })) / NANO;
    if (taskId) {
      const task = (await this.nanoAiu({ taskId })) / NANO;
      if (task >= s.perTaskCredits - 0.005 || day < s.perDayCredits - 0.005) return `Stopped: this task reached its Copilot credit limit (${credits(task)} of ${s.perTaskCredits}). Raise the limit in Settings, then resume.`;
    }
    return `Stopped: today's Copilot credits are used up (${credits(day)} of ${s.perDayCredits}). Raise the limit in Settings or continue tomorrow.`;
  }

  async summary(taskId?: string): Promise<BudgetSummary> {
    const s = (await this.settings()).budget;
    const since = this.since();
    const today = await this.store.usage.prompts({ since });
    const out: BudgetSummary = { today, perDay: s.perDayPrompts, perTask: s.perTaskPrompts, credits: { today: (await this.nanoAiu({ since })) / NANO, perDay: s.perDayCredits, perTask: s.perTaskCredits } };
    if (taskId) {
      out.task = await this.store.usage.prompts({ taskId });
      out.credits.task = (await this.nanoAiu({ taskId })) / NANO;
    }
    return out;
  }
}
