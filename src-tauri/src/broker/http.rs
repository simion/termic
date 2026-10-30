//! Strict HTTP/1.1 request parsing for the broker. One request per
//! connection, `Connection: close` both ways, bodies streamed with their
//! framing checked so nothing after the request can ride along upstream.

use std::io::{self, BufRead, Read, Write};

/// Same cap the proxy uses for a request head.
pub(crate) const MAX_HEADER_BYTES: usize = crate::proxy::MAX_HEADER_BYTES;
const MAX_HEADERS: usize = 96;
const MAX_CHUNK_LINE: usize = 4096;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Body { None, Length(u64), Chunked }

#[derive(Debug, Clone)]
pub(crate) struct Head {
    pub method: String,
    /// Origin form: `/path?query`.
    pub target: String,
    pub headers: Vec<(String, Vec<u8>)>,
    pub body: Body,
}

impl Head {
    pub(crate) fn path(&self) -> &str { self.target.split('?').next().unwrap_or("") }
    pub(crate) fn query(&self) -> &str { self.target.split_once('?').map(|(_, q)| q).unwrap_or("") }
    pub(crate) fn one<'a>(&'a self, name: &str) -> Option<&'a str> {
        self.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_slice()).and_then(|v| std::str::from_utf8(v).ok()).map(str::trim)
    }
}

#[derive(Debug)]
pub(crate) enum HttpError {
    /// Refuse with this status and reason.
    Reject(u16, &'static str),
    /// The connection failed; nothing more to send. Kept for `Debug`.
    Io(#[allow(dead_code)] io::Error),
}

impl From<io::Error> for HttpError {
    fn from(e: io::Error) -> Self { HttpError::Io(e) }
}

/// Read and validate one request head, leaving the body unread in `r`.
pub(crate) fn read_head<R: BufRead>(r: &mut R) -> Result<Head, HttpError> {
    let mut buf: Vec<u8> = Vec::with_capacity(1024);
    loop {
        let avail = r.fill_buf()?;
        if avail.is_empty() {
            return Err(HttpError::Io(io::Error::new(io::ErrorKind::UnexpectedEof, "closed before the request head")));
        }
        let before = buf.len();
        let take = avail.len().min(MAX_HEADER_BYTES + 1 - before);
        buf.extend_from_slice(&avail[..take]);
        let mut hs = [httparse::EMPTY_HEADER; MAX_HEADERS];
        let mut req = httparse::Request::new(&mut hs);
        match req.parse(&buf) {
            Ok(httparse::Status::Complete(n)) => {
                r.consume(n - before);
                return validate(&req);
            }
            Ok(httparse::Status::Partial) => {
                r.consume(take);
                if buf.len() > MAX_HEADER_BYTES { return Err(HttpError::Reject(431, "Request Header Fields Too Large")); }
            }
            Err(httparse::Error::TooManyHeaders) => return Err(HttpError::Reject(431, "Request Header Fields Too Large")),
            Err(_) => return Err(HttpError::Reject(400, "Bad Request")),
        }
    }
}

fn validate(req: &httparse::Request) -> Result<Head, HttpError> {
    let bad = || HttpError::Reject(400, "Bad Request");
    if req.version != Some(1) { return Err(HttpError::Reject(505, "HTTP Version Not Supported")); }
    let method = req.method.ok_or_else(bad)?.to_string();
    let raw = req.path.ok_or_else(bad)?;
    let (path, query) = raw.split_once('?').map_or((raw, None), |(p, q)| (p, Some(q)));
    let path = decode_unreserved(path);
    // one pass can build a new escape (`%%36D` -> `%6D`); refuse those, so the
    // path the rules match is the path upstream decodes.
    if !path.starts_with('/') || decode_unreserved(&path) != path || !path_is_canonical(&path) { return Err(bad()); }
    // rules and upstream both see the decoded path, so an escape cannot
    // spell a route the rules did not match (`%6Derge` for `merge`).
    let target = match query { Some(q) => format!("{path}?{q}"), None => path };
    let headers: Vec<(String, Vec<u8>)> = req.headers.iter().map(|h| (h.name.to_string(), h.value.to_vec())).collect();
    let count = |n: &str| headers.iter().filter(|(k, _)| k.eq_ignore_ascii_case(n)).count();
    let value = |n: &str| headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(n)).map(|(_, v)| v.as_slice());
    if count("host") != 1 || count("content-length") > 1 || count("transfer-encoding") > 1 || count("authorization") > 1 {
        return Err(bad());
    }
    let body = match (value("content-length"), value("transfer-encoding")) {
        (Some(_), Some(_)) => return Err(bad()),
        (None, Some(te)) if te.eq_ignore_ascii_case(b"chunked") => Body::Chunked,
        (None, Some(_)) => return Err(HttpError::Reject(501, "Not Implemented")),
        (Some(cl), None) => {
            if cl.is_empty() || !cl.iter().all(u8::is_ascii_digit) { return Err(bad()); }
            match std::str::from_utf8(cl).ok().and_then(|s| s.parse::<u64>().ok()) {
                Some(0) => Body::None,
                Some(n) => Body::Length(n),
                None => return Err(bad()),
            }
        }
        (None, None) => Body::None,
    };
    Ok(Head { method, target, headers, body })
}

/// Decode every `%XX` whose byte is unreserved (RFC 3986: letters, digits,
/// `-._~`). Those forms are equivalent to the plain character, and route
/// literals are made of nothing else, so after this no escape can hide one.
/// Other escapes stay as sent.
pub(crate) fn decode_unreserved(path: &str) -> String {
    let b = path.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() && b[i + 1].is_ascii_hexdigit() && b[i + 2].is_ascii_hexdigit() {
            let hex = |c: u8| (c as char).to_digit(16).unwrap_or(0) as u8;
            let v = hex(b[i + 1]) << 4 | hex(b[i + 2]);
            if v.is_ascii_alphanumeric() || matches!(v, b'-' | b'.' | b'_' | b'~') {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8(out).unwrap_or_else(|_| path.to_string())
}

/// Rules glob the (unreserved-decoded) path, so refuse any path GitHub could
/// read differently: encoded `/` or `\`, a raw `\`, `.` / `..` segments,
/// empty segments (`//`), a literal `*`, and `#` / `;` (a server that cuts
/// the path at a fragment or a matrix parameter would run `/merge` where the
/// rules saw `/merge#x`). What is left means one thing to both.
pub(crate) fn path_is_canonical(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    if ["%2f", "%5c", "\\", "//", "*", "#", ";"].iter().any(|bad| lower.contains(bad)) { return false; }
    !lower.split('/').skip(1).any(|seg| {
        let d = seg.replace("%2e", ".");
        d == "." || d == ".."
    })
}

/// Headers never forwarded: hop-by-hop, plus the proxy's own credentials.
fn hop_by_hop(name: &str) -> bool {
    ["connection", "proxy-connection", "keep-alive", "upgrade", "te", "trailer", "proxy-authorization"]
        .iter().any(|h| name.eq_ignore_ascii_case(h))
}

/// The head as it goes upstream: `replace` is (header, value) swapped in
/// for the client's value of that header, and `Connection: close` is forced.
pub(crate) fn serialize(head: &Head, replace: Option<(&str, &str)>) -> Vec<u8> {
    let mut out = format!("{} {} HTTP/1.1\r\n", head.method, head.target).into_bytes();
    for (k, v) in &head.headers {
        if hop_by_hop(k) { continue; }
        out.extend_from_slice(k.as_bytes());
        out.extend_from_slice(b": ");
        match replace {
            Some((name, a)) if k.eq_ignore_ascii_case(name) => out.extend_from_slice(a.as_bytes()),
            _ => out.extend_from_slice(v),
        }
        out.extend_from_slice(b"\r\n");
    }
    out.extend_from_slice(b"Connection: close\r\n\r\n");
    out
}

/// Walk a request body, handing `raw` the bytes exactly as framed (chunked
/// stays chunked) and `data` the decoded payload. Stops at the body's end.
pub(crate) fn walk_body<R: BufRead>(
    r: &mut R,
    body: &Body,
    raw: &mut dyn FnMut(&[u8]) -> Result<(), HttpError>,
    data: &mut dyn FnMut(&[u8]) -> Result<(), HttpError>,
) -> Result<(), HttpError> {
    let mut buf = [0u8; 16 * 1024];
    let mut copy = |r: &mut R, mut n: u64, raw: &mut dyn FnMut(&[u8]) -> Result<(), HttpError>, data: &mut dyn FnMut(&[u8]) -> Result<(), HttpError>| -> Result<(), HttpError> {
        while n > 0 {
            let want = n.min(buf.len() as u64) as usize;
            let got = r.read(&mut buf[..want])?;
            if got == 0 { return Err(HttpError::Io(io::ErrorKind::UnexpectedEof.into())); }
            raw(&buf[..got])?;
            data(&buf[..got])?;
            n -= got as u64;
        }
        Ok(())
    };
    match body {
        Body::None => Ok(()),
        Body::Length(n) => copy(r, *n, raw, data),
        Body::Chunked => loop {
            let line = read_line(r)?;
            raw(&line)?;
            let size = line.strip_suffix(b"\r\n").ok_or(HttpError::Reject(400, "Bad Request"))?;
            let size = size.split(|b| *b == b';').next().unwrap_or(b"");
            let size = std::str::from_utf8(size).ok()
                .filter(|s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_hexdigit()))
                .and_then(|s| u64::from_str_radix(s, 16).ok())
                .ok_or(HttpError::Reject(400, "Bad Request"))?;
            if size == 0 {
                // trailers, then the empty line that ends the message.
                loop {
                    let t = read_line(r)?;
                    raw(&t)?;
                    if t == b"\r\n" { return Ok(()); }
                }
            }
            copy(r, size, raw, data)?;
            let crlf = read_line(r)?;
            if crlf != b"\r\n" { return Err(HttpError::Reject(400, "Bad Request")); }
            raw(&crlf)?;
        },
    }
}

fn read_line<R: BufRead>(r: &mut R) -> Result<Vec<u8>, HttpError> {
    let mut line = Vec::new();
    r.by_ref().take(MAX_CHUNK_LINE as u64).read_until(b'\n', &mut line)?;
    if !line.ends_with(b"\n") {
        return Err(if line.len() >= MAX_CHUNK_LINE { HttpError::Reject(400, "Bad Request") } else { HttpError::Io(io::ErrorKind::UnexpectedEof.into()) });
    }
    Ok(line)
}

/// A response Termic writes itself.
pub(crate) fn respond(w: &mut dyn Write, code: u16, reason: &str, headers: &[(&str, &str)], body: &str) -> io::Result<()> {
    let mut s = format!("HTTP/1.1 {code} {reason}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n", body.len());
    for (k, v) in headers { s.push_str(&format!("{k}: {v}\r\n")); }
    s.push_str("\r\n");
    s.push_str(body);
    w.write_all(s.as_bytes())?;
    w.flush()
}

/// Stream the upstream response back untouched until it closes. Returns the
/// status code when the first line parsed. Never follows a redirect: a 3xx
/// goes back to the client like anything else.
pub(crate) fn relay_response(up: &mut dyn Read, client: &mut dyn Write) -> Option<u16> {
    let mut buf = [0u8; 16 * 1024];
    let mut status = None;
    let mut first: Vec<u8> = Vec::new();
    loop {
        let n = match up.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => n,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            // a peer that skips TLS close_notify ends the stream the same way.
            Err(_) => break,
        };
        if status.is_none() && first.len() < 64 {
            first.extend_from_slice(&buf[..n.min(64)]);
            status = std::str::from_utf8(&first).ok()
                .and_then(|s| s.split(' ').nth(1))
                .and_then(|c| c.get(..3)?.parse().ok());
        }
        if client.write_all(&buf[..n]).is_err() { break; }
    }
    let _ = client.flush();
    status
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::BufReader;

    fn parse(s: &str) -> Result<Head, HttpError> {
        read_head(&mut BufReader::new(s.as_bytes()))
    }

    fn rejected(s: &str) -> u16 {
        match parse(s) {
            Err(HttpError::Reject(c, _)) => c,
            other => panic!("expected reject, got {other:?}"),
        }
    }

    #[test]
    fn parses_a_plain_request() {
        let h = parse("GET /user?x=1 HTTP/1.1\r\nHost: api.github.com\r\nAuthorization: token abc\r\n\r\n").unwrap();
        assert_eq!((h.method.as_str(), h.path(), h.query()), ("GET", "/user", "x=1"));
        assert_eq!(h.one("host"), Some("api.github.com"));
        assert_eq!(h.body, Body::None);
    }

    #[test]
    fn reject_paths() {
        // CL and TE together: the smuggling shape.
        assert_eq!(rejected("POST / HTTP/1.1\r\nHost: a\r\nContent-Length: 3\r\nTransfer-Encoding: chunked\r\n\r\n"), 400);
        // any TE but exactly chunked
        assert_eq!(rejected("POST / HTTP/1.1\r\nHost: a\r\nTransfer-Encoding: gzip, chunked\r\n\r\n"), 501);
        assert_eq!(rejected("POST / HTTP/1.1\r\nHost: a\r\nTransfer-Encoding: chunked\r\nTransfer-Encoding: chunked\r\n\r\n"), 400);
        // duplicate / malformed lengths
        assert_eq!(rejected("POST / HTTP/1.1\r\nHost: a\r\nContent-Length: 3\r\nContent-Length: 3\r\n\r\n"), 400);
        assert_eq!(rejected("POST / HTTP/1.1\r\nHost: a\r\nContent-Length: +3\r\n\r\n"), 400);
        // host missing or doubled, two Authorization headers
        assert_eq!(rejected("GET / HTTP/1.1\r\n\r\n"), 400);
        assert_eq!(rejected("GET / HTTP/1.1\r\nHost: a\r\nHost: b\r\n\r\n"), 400);
        assert_eq!(rejected("GET / HTTP/1.1\r\nHost: a\r\nAuthorization: x\r\nAuthorization: y\r\n\r\n"), 400);
        // absolute form, old versions, folded headers
        assert_eq!(rejected("GET https://evil.example/ HTTP/1.1\r\nHost: a\r\n\r\n"), 400);
        assert_eq!(rejected("GET / HTTP/1.0\r\nHost: a\r\n\r\n"), 505);
        assert_eq!(rejected("GET / HTTP/1.1\r\nHost: a\r\nX: y\r\n z\r\n\r\n"), 400);
        // oversized head
        let big = format!("GET / HTTP/1.1\r\nHost: a\r\nX: {}\r\n\r\n", "a".repeat(MAX_HEADER_BYTES));
        assert_eq!(rejected(&big), 431);
    }

    #[test]
    fn paths_the_upstream_could_read_differently_are_refused() {
        for p in [
            "/repos/acme%2Fwidget/pulls", "/repos/acme%2fwidget", "/repos/acme%5Cwidget", "/repos/a%5cb",
            "/repos/a\\b", "/repos/./acme", "/repos/../acme", "/repos/acme/..", "/repos/%2E%2E/acme",
            "/repos/%2e/acme", "/repos/.%2e/x", "/repos//acme", "//repos", "/repos/*/widget",
        ] {
            assert_eq!(rejected(&format!("GET {p} HTTP/1.1\r\nHost: a\r\n\r\n")), 400, "{p}");
        }
        // non-origin forms
        assert_eq!(rejected("GET * HTTP/1.1\r\nHost: a\r\n\r\n"), 400);
        assert_eq!(rejected("CONNECT a:443 HTTP/1.1\r\nHost: a\r\n\r\n"), 400);
        // only the path is checked: a query may carry anything
        let h = parse("GET /search?q=a//b*%2F.. HTTP/1.1\r\nHost: a\r\n\r\n").unwrap();
        assert_eq!(h.path(), "/search");
        // dots inside a segment are fine
        assert!(parse("GET /acme/widget.git/info/refs HTTP/1.1\r\nHost: a\r\n\r\n").is_ok());
        assert!(path_is_canonical("/repos/a/b...c") && path_is_canonical("/"));
        // a fragment or matrix parameter could cut the path upstream
        assert!(!path_is_canonical("/repos/a/b/pulls/1/merge#x"));
        assert!(!path_is_canonical("/repos/a/b/pulls/1/merge;x=1"));
    }

    #[test]
    fn unreserved_escapes_are_decoded_before_rules_see_the_path() {
        // `%6D` is `m`: the rules and upstream both see `merge`.
        let h = parse("PUT /repos/acme/prod/pulls/1/%6Derge HTTP/1.1\r\nHost: a\r\n\r\n").unwrap();
        assert_eq!(h.target, "/repos/acme/prod/pulls/1/merge");
        assert_eq!(parse("GET /%41cme/%7e-%5F.x?q=%6D HTTP/1.1\r\nHost: a\r\n\r\n").unwrap().target, "/Acme/~-_.x?q=%6D");
        // reserved and non-ASCII escapes stay as sent
        assert_eq!(parse("GET /a%20b/%40c/%C3%A9 HTTP/1.1\r\nHost: a\r\n\r\n").unwrap().target, "/a%20b/%40c/%C3%A9");
        // a malformed or truncated escape is left alone
        assert_eq!(decode_unreserved("/a%6/b%zz/%"), "/a%6/b%zz/%");
        // decoding that builds a fresh escape is refused, not passed on
        for p in ["/pulls/1/%%36Derge", "/repos/%%32e%%32e/x", "/a/%%32%45"] {
            assert_eq!(rejected(&format!("PUT {p} HTTP/1.1\r\nHost: a\r\n\r\n")), 400, "{p}");
        }
    }

    #[test]
    fn serialize_forces_close_and_swaps_only_authorization() {
        let h = parse("GET /x HTTP/1.1\r\nHost: a\r\nConnection: keep-alive\r\nProxy-Authorization: Basic zz\r\nAuthorization: token ph\r\nX-Other: ph\r\n\r\n").unwrap();
        let out = String::from_utf8(serialize(&h, Some(("authorization", "token real")))).unwrap();
        assert_eq!(out, "GET /x HTTP/1.1\r\nHost: a\r\nAuthorization: token real\r\nX-Other: ph\r\nConnection: close\r\n\r\n");
    }

    fn walk(body: &Body, input: &[u8]) -> (Result<(), HttpError>, Vec<u8>, Vec<u8>, Vec<u8>) {
        let mut r = BufReader::new(input);
        let (mut raw, mut data) = (Vec::new(), Vec::new());
        let res = walk_body(&mut r, body, &mut |b| { raw.extend_from_slice(b); Ok(()) }, &mut |b| { data.extend_from_slice(b); Ok(()) });
        let mut rest = Vec::new();
        r.read_to_end(&mut rest).unwrap();
        (res, raw, data, rest)
    }

    #[test]
    fn chunked_passes_through_untouched_and_stops_at_the_end() {
        let wire = b"4;ext=1\r\nWiki\r\n5\r\npedia\r\n0\r\nX-Trailer: 1\r\n\r\n";
        let mut input = wire.to_vec();
        input.extend_from_slice(b"GET /smuggled HTTP/1.1\r\n\r\n");
        let (res, raw, data, rest) = walk(&Body::Chunked, &input);
        assert!(res.is_ok());
        assert_eq!(raw, wire);
        assert_eq!(data, b"Wikipedia");
        assert_eq!(rest, b"GET /smuggled HTTP/1.1\r\n\r\n", "nothing past the body is consumed");
    }

    #[test]
    fn content_length_stops_at_the_end() {
        let (res, raw, data, rest) = walk(&Body::Length(3), b"abcdef");
        assert!(res.is_ok());
        assert_eq!((raw.as_slice(), data.as_slice(), rest.as_slice()), (&b"abc"[..], &b"abc"[..], &b"def"[..]));
        let (res, ..) = walk(&Body::Length(10), b"abc");
        assert!(matches!(res, Err(HttpError::Io(_))));
    }

    #[test]
    fn bad_chunk_framing_is_rejected() {
        assert!(matches!(walk(&Body::Chunked, b"zz\r\nab\r\n0\r\n\r\n").0, Err(HttpError::Reject(400, _))));
        assert!(matches!(walk(&Body::Chunked, b"2\r\nabXX0\r\n\r\n").0, Err(HttpError::Reject(400, _))));
        assert!(matches!(walk(&Body::Chunked, b"2\nab\r\n0\r\n\r\n").0, Err(HttpError::Reject(400, _))));
    }

    #[test]
    fn relay_reports_status_and_never_follows() {
        let resp = b"HTTP/1.1 302 Found\r\nLocation: https://evil.example/\r\nContent-Length: 0\r\n\r\n";
        let mut out = Vec::new();
        assert_eq!(relay_response(&mut &resp[..], &mut out), Some(302));
        assert_eq!(out, resp);
    }
}
