use crate::{
    lines,
    matcher::Matcher,
    searcher::{Config, Range, Searcher, core::Core},
    sink::Sink,
};

#[derive(Debug)]
pub(crate) struct MultiLine<'s, M, S> {
    config: &'s Config,
    core: Core<'s, M, S>,
    slice: &'s [u8],
    last_match: Option<(Range, bool)>,
}

impl<'s, M: Matcher, S: Sink> MultiLine<'s, M, S> {
    pub(crate) fn new(
        searcher: &'s Searcher,
        matcher: M,
        slice: &'s [u8],
        write_to: S,
    ) -> MultiLine<'s, M, S> {
        debug_assert!(searcher.multi_line_with_matcher(&matcher));

        MultiLine {
            config: &searcher.config,
            core: Core::new(searcher, matcher, write_to),
            slice,
            last_match: None,
        }
    }

    pub(crate) fn run(mut self) -> Result<(), S::Error> {
        if self.core.begin()? {
            let mut keepgoing = true;
            while !self.slice[self.core.pos()..].is_empty() && keepgoing {
                keepgoing = self.sink()?;
            }
            if keepgoing && let Some((last_match, crosses_line)) = self.last_match.take() {
                self.sink_matched(&last_match, crosses_line)?;
            }
        }
        self.core.finish()
    }

    fn sink(&mut self) -> Result<bool, S::Error> {
        let mat = match self.find()? {
            Some(range) => range,
            None => {
                self.core.set_pos(self.slice.len());
                return Ok(true);
            }
        };
        self.advance(&mat);

        let crosses_line = self.slice[mat].contains(&self.config.line_term.as_byte());
        let line = lines::locate(self.slice, self.config.line_term.as_byte(), mat);
        match self.last_match.take() {
            None => {
                self.last_match = Some((line, crosses_line));
                Ok(true)
            }
            Some((last_match, last_crosses_line)) => {
                if last_match.end() >= line.start() {
                    self.last_match = Some((
                        last_match.with_end(line.end()),
                        last_crosses_line || crosses_line,
                    ));
                    Ok(true)
                } else {
                    self.last_match = Some((line, crosses_line));
                    self.sink_matched(&last_match, last_crosses_line)
                }
            }
        }
    }

    fn sink_matched(&mut self, range: &Range, crosses_line: bool) -> Result<bool, S::Error> {
        if range.is_empty() {
            return Ok(false);
        }
        self.core.matched(self.slice, range, crosses_line)
    }

    fn find(&mut self) -> Result<Option<Range>, S::Error> {
        self.core.find_at(self.slice, self.core.pos())
    }

    fn advance(&mut self, range: &Range) {
        self.core.set_pos(range.end());
        if range.is_empty() && self.core.pos() < self.slice.len() {
            let newpos = self.core.pos() + 1;
            self.core.set_pos(newpos);
        }
    }
}
