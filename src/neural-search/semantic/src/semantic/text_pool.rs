//! Request-owned document encoding. All lanes finish before sink/scoring resumes.
use super::bekko;
use crate::{Chunk, Result, request};
use std::{
    sync::{
        Arc,
        mpsc::{self, Receiver, SyncSender},
    },
    thread::{self, JoinHandle},
};

type Encoded = Result<([f32; bekko::EMBEDDING_DIMENSION], usize)>;

pub(super) fn encode(encoder: &bekko::Encoder, source: &Chunk) -> Encoded {
    request::check()?;
    encoder.encode(&format!("{}\n{}", source.path, source.content))
}

struct Worker {
    sender: Option<SyncSender<Arc<Chunk>>>,
    done: Receiver<Encoded>,
    handle: Option<JoinHandle<()>>,
}
impl Drop for Worker {
    fn drop(&mut self) {
        self.sender.take();
        if let Some(handle) = self.handle.take()
            && handle.join().is_err()
        {
            request::diagnostic(format_args!("sgrep: text encoding worker panicked"));
        }
    }
}

// Request ownership prevents idle workers retaining model readers across requests.
// Workers grow only to the largest batch seen; the caller is always one lane.
#[derive(Default)]
pub struct Pool {
    workers: Vec<Worker>,
}
impl Pool {
    pub(super) fn encode(
        &mut self,
        encoder: &Arc<bekko::Encoder>,
        sources: &[Arc<Chunk>],
    ) -> Result<Vec<Encoded>> {
        while self.workers.len() < sources.len() - 1 {
            let lane = self.workers.len() + 1;
            let encoder = encoder.clone();
            let context = request::current();
            let (sender, jobs) = mpsc::sync_channel::<Arc<Chunk>>(1);
            let (reply, done) = mpsc::sync_channel(1);
            let handle = thread::Builder::new()
                .name(format!("semantic-text-{lane}"))
                .spawn(move || {
                    let run = || {
                        for source in jobs {
                            if reply.send(encode(&encoder, &source)).is_err() {
                                break;
                            }
                        }
                    };
                    match context {
                        Some(context) => request::enter(context, run),
                        None => run(),
                    }
                })?;
            self.workers.push(Worker {
                sender: Some(sender),
                done,
                handle: Some(handle),
            });
        }
        // No sink/compression overlaps encoding. Keep each Result in source order
        // rather than returning a later encode error ahead of an earlier sink.
        let pending: Vec<Result<&Receiver<Encoded>>> = self
            .workers
            .iter()
            .zip(&sources[1..])
            .map(|(worker, source)| {
                worker
                    .sender
                    .as_ref()
                    .expect("live text worker")
                    .send(source.clone())
                    .map(|()| &worker.done)
                    .map_err(|_| "text encoding worker stopped".into())
            })
            .collect();
        let mut results = Vec::with_capacity(sources.len());
        results.push(encode(encoder, &sources[0]));
        for receiver in pending {
            results.push(receiver.and_then(|done| {
                done.recv()
                    .map_err(|_| "text encoding worker disconnected")?
            }));
        }
        Ok(results)
    }
}
