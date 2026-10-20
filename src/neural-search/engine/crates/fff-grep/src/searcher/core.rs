use crate::{
    lines,
    matcher::Matcher,
    searcher::{Range, Searcher},
    sink::{Sink, SinkError, SinkFinish, SinkMatch},
};

#[derive(Debug)]
pub(crate) struct Core<'s, M: 's, S> {
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

    pub(crate) fn find_at(&mut self, buf: &[u8], at: usize) -> Result<Option<Range>, S::Error> {
        self.matcher
            .find_at(buf, at)
            .map_err(S::Error::error_message)
    }

    pub(crate) fn begin(&mut self) -> Result<bool, S::Error> {
        self.sink.begin(self.searcher)
    }

    pub(crate) fn finish(&mut self) -> Result<(), S::Error> {
        self.sink.finish(self.searcher, &SinkFinish)
    }

    pub(crate) fn match_by_line(&mut self, buf: &[u8]) -> Result<(), S::Error> {
        while !buf[self.pos()..].is_empty() {
            if let Some((line, crosses_line)) = self.find_by_line(buf)? {
                self.set_pos(line.end());
                if !self.matched(buf, &line, crosses_line)? {
                    return Ok(());
                }
            } else {
                break;
            }
        }
        self.set_pos(buf.len());
        Ok(())
    }

    #[inline(always)]
    fn find_by_line(&mut self, buf: &[u8]) -> Result<Option<(Range, bool)>, S::Error> {
        let Some(mat) = self.find_at(buf, self.pos())? else {
            return Ok(None);
        };
        let line = lines::locate(
            buf,
            self.searcher.line_terminator().as_byte(),
            Range::zero(mat.start()),
        );
        if line.start() == buf.len() {
            return Ok(None);
        }
        // A later alternative can cross LF even when the first match stays on a line.
        let crosses_line = self.matcher.line_terminator() != Some(self.searcher.line_terminator())
            || buf[mat.start()..mat.end()].contains(&self.searcher.line_terminator().as_byte());
        Ok(Some((line, crosses_line)))
    }

    #[inline(always)]
    pub(crate) fn matched(
        &mut self,
        buf: &[u8],
        range: &Range,
        crosses_line: bool,
    ) -> Result<bool, S::Error> {
        self.count_lines(buf, range.start());
        let linebuf = &buf[*range];
        self.sink.matched(
            self.searcher,
            &SinkMatch {
                bytes: linebuf,
                crosses_line,
                line_number: self.line_number,
                buffer: buf,
                bytes_range_in_buffer: range.start()..range.end(),
            },
        )
    }

    fn count_lines(&mut self, buf: &[u8], upto: usize) {
        if self.last_line_counted >= upto {
            return;
        }
        let count = lines::count(
            &buf[self.last_line_counted..upto],
            self.searcher.line_terminator().as_byte(),
        );
        self.line_number += count;
        self.last_line_counted = upto;
    }
}
