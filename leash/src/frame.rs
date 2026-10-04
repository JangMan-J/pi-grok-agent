use std::ops::Range;

/// Preserve the wire token for replies, but compare decoded string IDs.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Id {
    pub raw: String,
    pub key: String,
}

#[derive(Debug, PartialEq)]
pub struct Frame {
    pub method: Option<String>,
    pub id: Option<Id>,
    pub extension: Option<(Id, u64)>,
}

pub fn tracked(method: &str) -> bool {
    matches!(
        method,
        "_x.ai/hooks/run" | "session/request_permission" | "_x.ai/ask_user_question"
    )
}

/// Validate the whole JSON object; never match keys hidden in nested params or strings.
pub fn parse(line: &[u8]) -> Option<Frame> {
    let text = std::str::from_utf8(line).ok()?;
    let fields = object(text)?;
    let get = |key: &str| {
        fields
            .iter()
            .rev()
            .find(|(k, _)| k == key)
            .map(|(_, r)| &text[r.clone()])
    };
    let method = get("method").and_then(string);
    let id = get("id").and_then(parse_id);
    let extension = (|| {
        let params = get("params")?;
        let fields = object(params)?;
        let get = |key: &str| {
            fields
                .iter()
                .rev()
                .find(|(k, _)| k == key)
                .map(|(_, r)| &params[r.clone()])
        };
        Some((parse_id(get("id")?)?, get("ms")?.parse::<u64>().ok()?))
    })();
    Some(Frame {
        method,
        id,
        extension,
    })
}

fn parse_id(token: &str) -> Option<Id> {
    let key = if token.starts_with('"') {
        format!("s:{}", string(token)?)
    } else if token.starts_with(|c: char| c == '-' || c.is_ascii_digit()) {
        format!("n:{token}")
    } else {
        return None;
    };
    Some(Id {
        raw: token.to_owned(),
        key,
    })
}

fn object(text: &str) -> Option<Vec<(String, Range<usize>)>> {
    let mut parser = Parser {
        bytes: text.as_bytes(),
        pos: 0,
    };
    parser.space();
    parser.take(b'{')?;
    let mut fields = Vec::new();
    parser.space();
    if !parser.eat(b'}') {
        loop {
            parser.space();
            let start = parser.pos;
            parser.string()?;
            let key = string(&text[start..parser.pos])?;
            parser.space();
            parser.take(b':')?;
            parser.space();
            let start = parser.pos;
            parser.value(0)?;
            fields.push((key, start..parser.pos));
            parser.space();
            if parser.eat(b'}') {
                break;
            }
            parser.take(b',')?;
        }
    }
    parser.space();
    (parser.pos == parser.bytes.len()).then_some(fields)
}

struct Parser<'a> {
    bytes: &'a [u8],
    pos: usize,
}
impl Parser<'_> {
    fn space(&mut self) {
        while self
            .bytes
            .get(self.pos)
            .is_some_and(|b| matches!(b, b' ' | b'\t' | b'\n' | b'\r'))
        {
            self.pos += 1;
        }
    }
    fn eat(&mut self, b: u8) -> bool {
        if self.bytes.get(self.pos) == Some(&b) {
            self.pos += 1;
            true
        } else {
            false
        }
    }
    fn take(&mut self, b: u8) -> Option<()> {
        self.eat(b).then_some(())
    }
    fn string(&mut self) -> Option<()> {
        let start = self.pos;
        self.take(b'"')?;
        loop {
            let b = *self.bytes.get(self.pos)?;
            self.pos += 1;
            match b {
                b'"' => {
                    // Also reject unpaired UTF-16 surrogates.
                    string(std::str::from_utf8(&self.bytes[start..self.pos]).ok()?)?;
                    return Some(());
                }
                b'\\' => {
                    let escaped = *self.bytes.get(self.pos)?;
                    self.pos += 1;
                    match escaped {
                        b'"' | b'\\' | b'/' | b'b' | b'f' | b'n' | b'r' | b't' => (),
                        b'u' => {
                            for _ in 0..4 {
                                if !self.bytes.get(self.pos)?.is_ascii_hexdigit() {
                                    return None;
                                }
                                self.pos += 1;
                            }
                        }
                        _ => return None,
                    }
                }
                0..=31 => return None,
                _ => (),
            }
        }
    }
    fn value(&mut self, depth: usize) -> Option<()> {
        if depth > 128 {
            return None;
        }
        self.space();
        match *self.bytes.get(self.pos)? {
            b'"' => self.string(),
            b'{' | b'[' => {
                let is_object = self.eat(b'{');
                let end = if is_object {
                    b'}'
                } else {
                    self.take(b'[')?;
                    b']'
                };
                self.space();
                if self.eat(end) {
                    return Some(());
                }
                loop {
                    self.space();
                    if is_object {
                        self.string()?;
                        self.space();
                        self.take(b':')?;
                    }
                    self.value(depth + 1)?;
                    self.space();
                    if self.eat(end) {
                        return Some(());
                    }
                    self.take(b',')?;
                }
            }
            b't' => self.literal(b"true"),
            b'f' => self.literal(b"false"),
            b'n' => self.literal(b"null"),
            _ => {
                self.eat(b'-');
                if !self.eat(b'0') {
                    if !matches!(self.bytes.get(self.pos)?, b'1'..=b'9') {
                        return None;
                    }
                    self.digits()?;
                }
                if self.eat(b'.') {
                    self.digits()?;
                }
                if self.eat(b'e') || self.eat(b'E') {
                    if !self.eat(b'+') {
                        self.eat(b'-');
                    }
                    self.digits()?;
                }
                Some(())
            }
        }
    }
    fn digits(&mut self) -> Option<()> {
        let start = self.pos;
        while self.bytes.get(self.pos).is_some_and(u8::is_ascii_digit) {
            self.pos += 1;
        }
        (self.pos > start).then_some(())
    }
    fn literal(&mut self, literal: &[u8]) -> Option<()> {
        if self.bytes.get(self.pos..self.pos + literal.len())? != literal {
            return None;
        }
        self.pos += literal.len();
        Some(())
    }
}

fn string(token: &str) -> Option<String> {
    let mut chars = token.strip_prefix('"')?.strip_suffix('"')?.chars();
    let mut result = String::new();
    while let Some(c) = chars.next() {
        result.push(match c {
            '\\' => match chars.next()? {
                '"' => '"',
                '\\' => '\\',
                '/' => '/',
                'b' => '\u{8}',
                'f' => '\u{c}',
                'n' => '\n',
                'r' => '\r',
                't' => '\t',
                'u' => {
                    let hex = |chars: &mut std::str::Chars<'_>| -> Option<u32> {
                        let mut n = 0;
                        for _ in 0..4 {
                            n = n * 16 + chars.next()?.to_digit(16)?;
                        }
                        Some(n)
                    };
                    let n = hex(&mut chars)?;
                    let n = if (0xd800..=0xdbff).contains(&n) {
                        if chars.next()? != '\\' || chars.next()? != 'u' {
                            return None;
                        }
                        let low = hex(&mut chars)?;
                        if !(0xdc00..=0xdfff).contains(&low) {
                            return None;
                        }
                        0x10000 + ((n - 0xd800) << 10) + low - 0xdc00
                    } else {
                        n
                    };
                    char::from_u32(n)?
                }
                _ => return None,
            },
            '"' | '\0'..='\u{1f}' => return None,
            _ => c,
        });
    }
    Some(result)
}

pub fn quote(value: &str) -> String {
    let mut out = String::from("\"");
    for c in value.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\0'..='\u{1f}' => out.push_str(&format!("\\u{:04x}", c as u32)),
            _ => out.push(c),
        }
    }
    out.push('"');
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn classifies_controls() {
        let f = parse(br#"{"jsonrpc":"2.0","method":"pi/heartbeat"}"#).unwrap();
        assert_eq!(f.method.as_deref(), Some("pi/heartbeat"));
        let f = parse(br#"{"method":"pi/extend","params":{"id":"abc","ms":570000}}"#).unwrap();
        let (id, ms) = f.extension.unwrap();
        assert_eq!(id.raw, "\"abc\"");
        assert_eq!(ms, 570000);
    }
    #[test]
    fn tracked_methods_and_responses() {
        for method in [
            "_x.ai/hooks/run",
            "session/request_permission",
            "_x.ai/ask_user_question",
        ] {
            let line = format!(r#"{{"method":"{method}","id":12}}"#);
            let f = parse(line.as_bytes()).unwrap();
            assert!(tracked(f.method.as_deref().unwrap()));
            assert_eq!(f.id.unwrap().raw, "12");
        }
        let f = parse(br#"{"id":"a\"b","result":{}}"#).unwrap();
        assert_eq!(f.method, None);
        assert_eq!(f.id.unwrap().key, "s:a\"b");
    }
    #[test]
    fn nested_keys_and_escaped_strings() {
        let f = parse(br#"{"params":{"method":"pi/heartbeat","id":2},"method":"other","id":"\u0061\ud83d\ude00","text":"\"method\":\"pi/heartbeat\""}"#).unwrap();
        assert_eq!(f.method.as_deref(), Some("other"));
        assert_eq!(f.id.unwrap().key, "s:a😀");
        assert_eq!(
            parse(br#"{"params":{"method":"pi/heartbeat"}}"#)
                .unwrap()
                .method,
            None
        );
        assert_eq!(
            parse(br#"{"\u006dethod":"pi/heartbeat"}"#)
                .unwrap()
                .method
                .as_deref(),
            Some("pi/heartbeat")
        );
    }
    #[test]
    fn malformed_and_nonobjects() {
        for line in [
            "[]",
            "null",
            "1",
            "\"text\"",
            "no json",
            "{",
            "{}x",
            "{\"a\":1,}",
            "{\"a\":01}",
            "{\"a\":1.}",
            "{\"a\":tru}",
            "{\"a\":\"\\ud800\"}",
            "{\"a\":\"\\q\"}",
        ] {
            assert!(parse(line.as_bytes()).is_none(), "{line}");
        }
        assert!(parse(b"{\"a\":\"\xff\"}").is_none());
        assert!(parse(b" {\"a\":[true,false,null,-1.25e+2,{}]}\r\n").is_some());
    }
    #[test]
    fn quote_roundtrips() {
        let text = "\"\\\n\t\r\0😀";
        assert_eq!(string(&quote(text)).as_deref(), Some(text));
    }
}
