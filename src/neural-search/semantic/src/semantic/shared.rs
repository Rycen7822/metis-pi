//! One model owner per service. ORT stays on its owner thread, never Send/Sync.
use super::{Delivery, DocumentBlock, EncodeSink, Work, bekko, lateon, native};
use crate::{Result, cache::Cache, request};
use half::f16;
use std::{
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
        mpsc::{self, SyncSender},
    },
    thread,
};

#[derive(PartialEq, Eq)]
struct Assets {
    directory: PathBuf,
    library: PathBuf,
    files: Vec<(u64, u64, u64, i64, i64)>,
}
impl Assets {
    fn capture(directory: PathBuf, library: PathBuf, text: bool) -> Result<Self> {
        use std::os::unix::fs::MetadataExt;
        let names = if text {
            vec!["manifest.json", "tokenizer.json", "bekko128.pack"]
        } else {
            vec![
                "manifest.json",
                "tokenizer.json",
                "embedding_preln_f16.pack",
                "backbone.ort",
            ]
        };
        let mut files = Vec::new();
        for path in names
            .into_iter()
            .map(|n| directory.join(n))
            .chain((!text).then(|| library.clone()))
        {
            let m = std::fs::metadata(path)?;
            files.push((m.dev(), m.ino(), m.len(), m.ctime(), m.ctime_nsec()));
        }
        Ok(Self {
            directory,
            library,
            files,
        })
    }
}
#[derive(Default)]
struct Counts {
    code: AtomicUsize,
    text: AtomicUsize,
    runtimes: AtomicUsize,
    encoding: AtomicUsize,
    encoding_peak: AtomicUsize,
}
type QueryReply = Result<(Vec<f32>, usize, native::ScoringKernel)>;
enum Command {
    Query {
        assets: Arc<Assets>,
        text: String,
        context: Arc<request::Context>,
        reply: SyncSender<QueryReply>,
    },
    Document {
        assets: Arc<Assets>,
        query: Arc<Vec<f32>>,
        blocks: bool,
        path: String,
        text: String,
        context: Arc<request::Context>,
        reply: SyncSender<Event>,
    },
}
enum Event {
    Window {
        source: std::ops::Range<usize>,
        tokens: usize,
        values: Vec<f16>,
        ack: SyncSender<Result<Delivery>>,
    },
    Done(Result<(f64, Work)>),
}
pub(crate) struct Models {
    sender: Option<SyncSender<Command>>,
    owner: Option<thread::JoinHandle<()>>,
    text: Mutex<Option<(Assets, Arc<bekko::Encoder>)>>,
    counts: Arc<Counts>,
}
impl Models {
    pub fn new() -> Result<Self> {
        let (tx, rx) = mpsc::sync_channel::<Command>(3);
        let counts = Arc::new(Counts::default());
        let stats = counts.clone();
        let owner = thread::Builder::new().name("semantic-model".into()).spawn(move || {
            let mut model: Option<(Arc<Assets>, lateon::Encoder)> = None;
            for command in rx {
                match command {
                    Command::Query { assets, text, context, reply } => {
                        let result = request::enter(context, || -> QueryReply {
                            request::check()?;
                            if model.as_ref().is_none_or(|(key, _)| *key != assets) {
                                model = None;
                                let encoder = lateon::Encoder::open(&assets.directory, &assets.library)?;
                                stats.code.fetch_add(1, Ordering::Relaxed);
                                model = Some((assets, encoder));
                            }
                            let encoder = &mut model.as_mut().expect("model loaded").1;
                            let (values, tokens) = encoder.query(&text)?;
                            let kernel = encoder.scoring_kernel()?;
                            Ok((values, tokens, kernel))
                        });
                        let _ = reply.send(result);
                    }
                    Command::Document { assets, query, blocks, path, text, context, reply } => {
                        let result = request::enter(context, || -> Result<(f64, Work)> {
                            request::check()?;
                            if model.as_ref().is_none_or(|(key, _)| *key != assets) {
                                return Err("ARTIFACT_MISMATCH: code assets changed during a request; retry after drain".into());
                            }
                            let encoder = &mut model.as_mut().expect("matching model").1;
                            let mut deliver = |block: DocumentBlock<'_>| -> Result<Delivery> {
                                request::check()?;
                                let DocumentBlock::Code { source, input_tokens, values } = block else {
                                    return Err("shared code model returned text".into());
                                };
                                let (ack, done) = mpsc::sync_channel(0);
                                reply.send(Event::Window {
                                    source, tokens: input_tokens, values: values.to_vec(), ack,
                                }).map_err(|_| "shared document consumer disconnected")?;
                                // Encoding and writer/CRC must not compute concurrently.
                                let delivery = done.recv().map_err(|_| "shared document sink disconnected")??;
                                request::check()?;
                                Ok(delivery)
                            };
                            encoder.score_to(&query, &path, &text, if blocks { Some(&mut deliver) } else { None })
                        });
                        let _ = reply.send(Event::Done(result));
                    }
                }
            }
        })?;
        Ok(Self {
            sender: Some(tx),
            owner: Some(owner),
            text: Mutex::new(None),
            counts,
        })
    }
    pub fn stats(&self) -> serde_json::Value {
        serde_json::json!({
            "lateon_loads": self.counts.code.load(Ordering::Relaxed),
            "bekko_loads": self.counts.text.load(Ordering::Relaxed),
            "native_runtime_creations": self.counts.runtimes.load(Ordering::Relaxed),
            "native_encode_active": self.counts.encoding.load(Ordering::Relaxed),
            "native_encode_peak": self.counts.encoding_peak.load(Ordering::Relaxed),
        })
    }
    pub fn encoding_started(&self) {
        let active = self.counts.encoding.fetch_add(1, Ordering::Relaxed) + 1;
        self.counts
            .encoding_peak
            .fetch_max(active, Ordering::Relaxed);
    }
    pub fn encoding_finished(&self) {
        self.counts.encoding.fetch_sub(1, Ordering::Relaxed);
    }
    pub fn runtime_created(&self) {
        self.counts.runtimes.fetch_add(1, Ordering::Relaxed);
    }
    pub(super) fn text(&self, assets: &Cache) -> Result<Arc<bekko::Encoder>> {
        let key = Assets::capture(
            assets.model_directory("bekko128")?,
            assets.native_library(),
            true,
        )?;
        let mut slot = self
            .text
            .lock()
            .map_err(|_| "shared text model owner poisoned")?;
        if slot.as_ref().is_none_or(|(old, _)| *old != key) {
            // Existing text request Arcs may still be in use. Do not create a second
            // version beside them; a changed asset requires drain/restart instead.
            if slot.as_ref().is_some_and(|(_, e)| Arc::strong_count(e) > 1) {
                return Err(
                    "ARTIFACT_MISMATCH: text assets changed with active readers; drain the service"
                        .into(),
                );
            }
            *slot = None;
            let encoder = Arc::new(bekko::Encoder::open(&key.directory)?);
            self.counts.text.fetch_add(1, Ordering::Relaxed);
            *slot = Some((key, encoder));
        }
        Ok(slot.as_ref().expect("text model loaded").1.clone())
    }
    pub(super) fn code(&self, assets: &Cache, text: &str) -> Result<(Client, Vec<f32>, usize)> {
        let key = Arc::new(Assets::capture(
            assets.model_directory("lateon-edge")?,
            assets.native_library(),
            false,
        )?);
        let context = request::current().ok_or("shared encoder requires request context")?;
        let (reply, rx) = mpsc::sync_channel(0);
        let sender = self.sender.as_ref().ok_or("model service shutting down")?;
        sender
            .send(Command::Query {
                assets: key.clone(),
                text: text.into(),
                context,
                reply,
            })
            .map_err(|_| "code model owner stopped")?;
        let (query, tokens, kernel) = rx.recv().map_err(|_| "code model query owner stopped")??;
        Ok((
            Client {
                sender: sender.clone(),
                kernel,
                assets: key,
            },
            query,
            tokens,
        ))
    }
}
impl Drop for Models {
    fn drop(&mut self) {
        drop(self.sender.take());
        if let Some(h) = self.owner.take() {
            let _ = h.join();
        }
    }
}
pub(crate) struct Client {
    sender: SyncSender<Command>,
    kernel: native::ScoringKernel,
    assets: Arc<Assets>,
}
impl Client {
    fn kernel(&self) -> native::ScoringKernel {
        self.kernel.clone()
    }
    pub fn score_to(
        &self,
        query: &Arc<Vec<f32>>,
        path: String,
        text: String,
        mut sink: Option<&mut EncodeSink<'_>>,
    ) -> Result<(f64, Work)> {
        request::check()?;
        let context = request::current().ok_or("shared encoder requires request context")?;
        let (reply, rx) = mpsc::sync_channel(0);
        self.sender
            .send(Command::Document {
                assets: self.assets.clone(),
                query: query.clone(),
                blocks: sink.is_some(),
                path,
                text,
                context,
                reply,
            })
            .map_err(|_| "code model owner stopped")?;
        for event in rx {
            match event {
                Event::Window {
                    source,
                    tokens,
                    values,
                    ack,
                } => {
                    let result = request::check().and_then(|_| {
                        let delivery = sink.as_mut().ok_or("unexpected code model window")?;
                        delivery(DocumentBlock::Code {
                            source,
                            input_tokens: tokens,
                            values: &values,
                        })
                    });
                    ack.send(result)
                        .map_err(|_| "code model window owner stopped")?;
                }
                Event::Done(result) => return result,
            }
        }
        Err("code model document owner stopped".into())
    }
}

pub(crate) enum CodeEncoder {
    Local(lateon::Encoder),
    Shared(Client),
}
impl CodeEncoder {
    pub fn score_to(
        &mut self,
        query: &Arc<Vec<f32>>,
        path: String,
        text: String,
        sink: Option<&mut EncodeSink<'_>>,
    ) -> Result<(f64, Work)> {
        match self {
            Self::Local(e) => e.score_to(query, &path, &text, sink),
            Self::Shared(e) => e.score_to(query, path, text, sink),
        }
    }
    pub(super) fn scoring_kernel(&self) -> Result<native::ScoringKernel> {
        match self {
            Self::Local(e) => e.scoring_kernel(),
            Self::Shared(e) => Ok(e.kernel()),
        }
    }
    pub fn scoring_error(&self, error: crate::Error) -> crate::Error {
        match self {
            Self::Local(e) => e.scoring_error(error),
            Self::Shared(_) => error,
        }
    }
}
