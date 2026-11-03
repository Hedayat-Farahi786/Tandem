import type { Clock, IdGenerator, Store, Tracker, TrackerComment, TrackerTask } from '@tandem/core';
import { redactor } from '@tandem/core';

/** The default tracker: Tandem's own tasks; comments appear in the task timeline. */
export class LocalTracker implements Tracker {
  readonly kind = 'local' as const;

  constructor(
    private readonly store: Store,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly owner: () => Promise<string> = async () => 'Tandem',
  ) {}

  async getTask(key: string): Promise<TrackerTask | undefined> {
    const t = await this.store.tasks.getByKey(key);
    return t ? { key: t.key, title: t.title, description: t.description, status: t.state } : undefined;
  }

  /** Local tasks are created in Tandem directly, so there is nothing to import. */
  async findReadyTasks(): Promise<TrackerTask[]> {
    return [];
  }

  async comment(key: string, markdown: string): Promise<{ id: string; createdAt: string }> {
    const c: TrackerComment = { id: this.ids(), key, authorId: 'tandem', authorName: 'Tandem', body: redactor.redact(markdown), createdAt: this.clock.iso() };
    await this.store.trackerComments.add(c);
    return { id: c.id, createdAt: c.createdAt };
  }

  /** Status lives in Tandem's own state machine. */
  async transition(): Promise<'moved' | 'not-available'> {
    return 'not-available';
  }

  async readReplies(key: string, since: string, authorIds?: readonly string[]): Promise<TrackerComment[]> {
    return (await this.store.trackerComments.list(key)).filter((c) => c.createdAt > since && c.authorId !== 'tandem' && (!authorIds || authorIds.includes(c.authorId)));
  }

  /** Records a comment from a person (owner notes in the timeline). */
  async addPersonComment(key: string, body: string): Promise<TrackerComment> {
    const c: TrackerComment = { id: this.ids(), key, authorId: 'owner', authorName: await this.owner(), body: redactor.redact(body), createdAt: this.clock.iso() };
    await this.store.trackerComments.add(c);
    return c;
  }

  link(): string | undefined {
    return undefined;
  }
}
