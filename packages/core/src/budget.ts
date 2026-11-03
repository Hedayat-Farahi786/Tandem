import type { Settings } from '@tandem/shared';
import type { Clock, Store } from './ports.js';

export class BudgetError extends Error {
  override readonly name = 'BudgetError';
}

/** Copilot is often a shared plan: prompts are metered per task and per day, with hard limits. */
export class Budget {
  constructor(
    private readonly store: Store,
    private readonly clock: Clock,
    private readonly settings: () => Promise<Settings>,
  ) {}

  /** Throws BudgetError with a plain message when another prompt would go over a limit. */
  async assertCanSend(taskId?: string): Promise<void> {
    const s = (await this.settings()).budget;
    const dayStart = new Date(this.clock.now());
    dayStart.setHours(0, 0, 0, 0);
    const today = await this.store.usage.prompts({ since: dayStart.toISOString() });
    if (today >= s.perDayPrompts) {
      throw new BudgetError(`Today's Copilot limit is used up (${today} of ${s.perDayPrompts} prompts). Raise it in Settings or continue tomorrow.`);
    }
    if (taskId) {
      const used = await this.store.usage.prompts({ taskId });
      if (used >= s.perTaskPrompts) throw new BudgetError(`This task used its Copilot limit (${used} of ${s.perTaskPrompts} prompts). Raise it in Settings to continue.`);
    }
  }

  async summary(taskId?: string): Promise<{ today: number; perDay: number; task?: number; perTask: number }> {
    const s = (await this.settings()).budget;
    const dayStart = new Date(this.clock.now());
    dayStart.setHours(0, 0, 0, 0);
    const today = await this.store.usage.prompts({ since: dayStart.toISOString() });
    const out: { today: number; perDay: number; task?: number; perTask: number } = { today, perDay: s.perDayPrompts, perTask: s.perTaskPrompts };
    if (taskId) out.task = await this.store.usage.prompts({ taskId });
    return out;
  }
}
