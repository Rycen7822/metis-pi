//! Shared pre-tokenization for Recall indexing and querying.
fn han(c: char) -> bool {
    matches!(c as u32, 0x3400..=0x4dbf | 0x4e00..=0x9fff | 0xf900..=0xfaff | 0x20000..=0x323af)
}

fn token_class(c: char) -> u8 {
    if han(c) {
        1
    } else if c.is_alphanumeric() || c == '_' {
        2
    } else {
        0
    }
}

fn han_terms(run: &str, query: bool, out: &mut Vec<String>) {
    if !query || run.chars().nth(1).is_none() {
        out.extend(run.chars().map(|c| c.to_string()));
    }
    let mut chars = run.chars();
    if let Some(mut prev) = chars.next() {
        for c in chars {
            out.push([prev, c].into_iter().collect());
            prev = c;
        }
    }
}

fn identifier_terms(run: &str, out: &mut Vec<String>) {
    let whole = run.to_lowercase();
    let mut previous = '_';
    let mut start = 0;
    for (i, c) in run.char_indices() {
        let camel = previous.is_lowercase() && c.is_uppercase();
        if c == '_' || camel {
            if start < i {
                out.push(run[start..i].to_lowercase());
            }
            start = if camel { i } else { i + 1 };
        }
        previous = c;
    }
    if start != 0 && start < run.len() {
        out.push(run[start..].to_lowercase());
    }
    if run.chars().any(char::is_alphanumeric) {
        out.push(whole);
    }
}

fn terms(text: &str, query: bool) -> Vec<String> {
    let mut out = Vec::new();
    let mut start = 0;
    let mut class = 0;
    for (i, new_class) in text
        .char_indices()
        .map(|(i, c)| (i, token_class(c)))
        .chain([(text.len(), 0)])
    {
        if new_class == class {
            continue;
        }
        let run = &text[start..i];
        match class {
            1 => han_terms(run, query, &mut out),
            2 => identifier_terms(run, &mut out),
            _ => {}
        }
        start = i;
        class = new_class;
    }
    out
}

pub(super) fn index(text: &str) -> String {
    terms(text, false).join(" ")
}

pub(super) fn query(text: &str) -> String {
    let mut tokens = terms(text, true);
    tokens.sort_unstable();
    tokens.dedup();
    tokens
        .iter()
        .map(|term| format!("\"{term}\""))
        .collect::<Vec<_>>()
        .join(" OR ")
}
