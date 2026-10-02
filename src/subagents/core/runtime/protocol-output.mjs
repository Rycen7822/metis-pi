/** Bounded JSONL output for the plugin-owned SDK child. SDK event callbacks
 * cannot await drain; coalesce only adjacent progress while the pipe is full. */
export function createProtocolOutput(stream, { fail, maxBytes = 8 * 1024 * 1024, timeoutMs = 45_000 } = {}) {
  const write = stream.write.bind(stream);
  const pending = [];
  let bytes = 0, blocked = false, failed = false, timer;
  const stop = error => {
    if (failed) return;
    failed = true;
    clearTimeout(timer);
    stream.off('drain', drain);
    pending.length = 0; bytes = 0;
    fail(error);
  };
  const send = frame => {
    try {
      blocked = !write(frame);
      if (blocked) timer = setTimeout(() => stop(new Error('SDK protocol output stalled')), timeoutMs).unref();
    } catch (error) { stop(error); }
  };
  function drain() {
    clearTimeout(timer); blocked = false;
    while (pending.length && !blocked && !failed) {
      const { frame } = pending.shift(); bytes -= frame.length;
      send(frame);
    }
  }
  stream.on('drain', drain);
  stream.on('error', stop);
  stream.on('close', () => stop(new Error('SDK protocol output closed')));
  return value => {
    if (failed) return;
    let frame;
    try { frame = Buffer.from(JSON.stringify(value) + '\n'); }
    catch (error) { stop(error); return; }
    const progress = value.type === 'message_update' || value.type === 'tool_execution_update';
    // A critical frame is a barrier: progress never moves across a result,
    // question, lifecycle event or RPC response, even across consecutive tasks.
    if (progress && pending.at(-1)?.progress) bytes -= pending.pop().frame.length;
    const full = () => bytes + stream.writableLength + frame.length > maxBytes || pending.length >= 256;
    if (full() && !progress) {
      for (let i = pending.length - 1; i >= 0; i--) {
        if (pending[i].progress) bytes -= pending.splice(i, 1)[0].frame.length;
      }
    }
    if (full()) {
      if (!progress) stop(new Error('SDK protocol output capacity exceeded'));
      return;
    }
    if (!blocked) send(frame);
    else { pending.push({ frame, progress }); bytes += frame.length; }
  };
}
