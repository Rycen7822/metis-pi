use crate::{
    lines,
    matcher::Matcher,
    searcher::{Config, Range, Searcher},
    sink::{Sink, SinkError, SinkFinish, SinkMatch},
};

#[derive(Debug)]
pub(crate) struct Core<'s, M: 's, S> {
    config: &'s Config,
    matcher: M,
    searcher: &'s Searcher,
    sink: S,
    pos: usize,
    line_number: u64,
    last_line_counted: usize,
}

impl<'s, M: Matcher, S: Sink> Core<'s, M, S> {
    pub(crate) fn new(searcher: &'s Searcher, matcher: M, sink: S) -> Core<'s, M, S> {
        Core {
            config: &searcher.config,
            matcher,
            searcher,
            sink,
            pos: 0,
            line_number: 1,
            last_line_counted: 0,
        }
    }

    pub(crate) fn pos(&self) -> usize {
        self.pos
    }

    pub(crate) fn set_pos(&mut self, pos: usize) {
        self.pos = pos;
    }

    pub(crate) fn matched(
        &mut self,
        buf: &[u8],
        range: &Range,
        crosses_line: bool,
    ) -> Result<bool, S::Error> {
        self.sink_matched(buf, range, crosses_line)
    }

    pub(crate) fn find_at(&mut self, buf: &[u8], at: usize) -> Result<Option<Range>, S::Error> {
        self.matcher
            .find_at(buf, at)
            .map_err(S::Error::error_message)
    }

    pub(crate) fn begin(&mut self) -> Result<bool, S::Error> {
        self.sink.begin(self.searcher)
    }

    pub(crate) fn finish(&mut self, byte_count: u64) -> Result<(), S::Error> {
        self.sink.finish(self.searcher, &SinkFinish { byte_count })
    }

    pub(crate) fn match_by_line(&mut self, buf: &[u8]) -> Result<bool, S::Error> {
        while !buf[self.pos()..].is_empty() {
            if let Some((line, crosses_line)) = self.find_by_line(buf)? {
                self.set_pos(line.end());
                if !self.sink_matched(buf, &line, crosses_line)? {
                    return Ok(false);
                }
            } else {
                break;
            }
        }
        self.set_pos(buf.len());
        Ok(true)
    }

    #[inline(always)]
    fn find_by_line(&mut self, buf: &[u8]) -> Result<Option<(Range, bool)>, S::Error> {
        let mut pos = self.pos();
        while !buf[pos..].is_empty() {
            let mat = match self
                .matcher
                .find_at(buf, pos)
                .map_err(S::Error::error_message)?
            {
                None => return Ok(None),
                Some(m) => m,
            };
            let line = lines::locate(
                buf,
                self.config.line_term.as_byte(),
                Range::zero(mat.start()),
            );
            if line.start() == buf.len() {
                pos = buf.len();
                continue;
            }
            // A later alternative on this output line can cross the boundary
            // even when the first match does not. Preserve the extraction policy
            // but conservatively flag LF-capable matchers without another scan.
            let crosses_line = self.matcher.line_terminator() != Some(self.config.line_term)
                || buf[mat.start()..mat.end()].contains(&self.config.line_term.as_byte());
            return Ok(Some((line, crosses_line)));
        }
        Ok(None)
    }

    #[inline(always)]
    fn sink_matched(
        &mut self,
        buf: &[u8],
        range: &Range,
        crosses_line: bool,
    ) -> Result<bool, S::Error> {
        self.count_lines(buf, range.start());
        let linebuf = &buf[*range];
        let keepgoing = self.sink.matched(
            self.searcher,
            &SinkMatch {
                bytes: linebuf,
                crosses_line,
                line_number: self.line_number,
                buffer: buf,
                bytes_range_in_buffer: range.start()..range.end(),
            },
        )?;
        if !keepgoing {
            return Ok(false);
        }
        Ok(true)
    }

    fn count_lines(&mut self, buf: &[u8], upto: usize) {
        if self.last_line_counted >= upto {
            return;
        }
        let count = lines::count(
            &buf[self.last_line_counted..upto],
            self.config.line_term.as_byte(),
        );
        self.line_number += count;
        self.last_line_counted = upto;
    }
}
