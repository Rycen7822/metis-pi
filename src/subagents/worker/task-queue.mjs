import { AsyncLocalStorage } from 'node:async_hooks';

const MAX_QUEUED_INPUTS = 256;
const MAX_QUEUED_BYTES = 8 * 1024 * 1024;

/** One durable task owns its SDK call, native input preflights and continuations.
 * Canceling freezes this owner until every owned call really exits. */
export class TaskQueue {
  context = new AsyncLocalStorage();
  active;
  constructor(execute, complete) { this.execute = execute; this.complete = complete; }

  start(id, input) {
    if (this.active) throw new Error('A managed task is already active');
    const task = { id, inputs: [{ input, size: 0 }], queuedBytes: 0, replies: 0,
      cancelled: false, cancelRequested: false, controls: new Set(), controlTail: Promise.resolve() };
    task.done = new Promise(resolve => { task.resolve = resolve; });
    this.active = task;
    void this.context.run(task, async () => {
      let error;
      try {
        while (task.inputs.length || task.controls.size) {
          if (task.controls.size) {
            // Native preflights may outlive the current SDK call. They own the
            // session until they return; starting another prompt races them.
            await Promise.allSettled([...task.controls]);
          } else if (!task.cancelled && task.inputs.length) {
            const { input, size } = task.inputs.shift(); task.queuedBytes -= size;
            await this.execute(input);
          } else break;
        }
        if (!task.cancelled && !task.replies) error = 'Pi handled the input without producing an assistant result';
      } catch (exc) { error = String(exc); }
      finally {
        // Failed root calls must not leave native preflights attached to a new task.
        if (error) task.cancelled = true;
        task.inputs.length = 0; task.queuedBytes = 0;
        await Promise.allSettled([...task.controls]);
        this.active = undefined;
        this.complete({ type: 'managed_task_end', runId: id, error, ...(task.cancelRequested ? { cancelled: true } : {}) });
        task.resolve();
      }
    });
  }

  owner(owner = this.context.getStore()) {
    if (!owner || owner !== this.active || owner.cancelled)
      throw new Error('Input rejected: its managed task has already ended, is cancelled, or no task owns it');
    return owner;
  }
  reserve(input, owner) {
    const size = Buffer.byteLength(JSON.stringify(input));
    if (owner.inputs.length + owner.controls.size >= MAX_QUEUED_INPUTS || owner.queuedBytes + size > MAX_QUEUED_BYTES) {
      const error = new Error('Managed SDK input queue capacity exceeded'); error.code = 'managed_queue_full'; throw error;
    }
    owner.queuedBytes += size; return size;
  }
  enqueue(input, owner = this.context.getStore()) {
    owner = this.owner(owner); const size = this.reserve(input, owner);
    owner.inputs.push({ input, size });
  }
  native(input, execute, owner = this.active) {
    owner = this.owner(owner); const size = this.reserve(input, owner);
    const previous = owner.controlTail;
    const call = this.context.run(owner, async () => {
      await previous;
      try { this.owner(owner); await execute(input, owner); }
      catch (error) {
        this.complete({ type: 'managed_control_end', runId: owner.id, receiptId: input.receiptId, error: String(error) });
      }
      finally { owner.queuedBytes -= size; }
    });
    owner.controls.add(call); owner.controlTail = call;
    void call.finally(() => owner.controls.delete(call));
  }
  async cancel(abort, discard = () => {}) {
    const task = this.active;
    if (!task) { await abort(); return { runId: null, taskExited: true }; }
    if (!task.cancelPromise) {
      task.cancelled = true; task.cancelRequested = true;
      const removedBytes = task.inputs.reduce((sum, x) => sum + x.size, 0);
      task.inputs.length = 0; task.queuedBytes -= removedBytes;
      discard(task);
      task.cancelPromise = this.context.run(task, async () => {
        await abort(); await task.done;
        return { runId: task.id, taskExited: true };
      });
    }
    return await task.cancelPromise;
  }
  observe(event) {
    if (event.type === 'message_end' && event.message?.role === 'assistant' && this.active)
      this.active.replies++;
  }
}
