//! Just enough protobuf to read fields out of a message with no schema:
//! Antigravity keeps its conversations as protobuf blobs and publishes no
//! `.proto`. Only length-delimited fields are returned; anything that does
//! not parse as a message yields nothing rather than a guess.

/// The length-delimited fields numbered `field` directly inside `msg`.
fn fields(msg: &[u8], field: u64) -> Option<Vec<&[u8]>> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < msg.len() {
        let (key, n) = varint(&msg[i..])?;
        i += n;
        match key & 7 {
            0 => i += varint(&msg[i..])?.1,
            1 => i += 8,
            5 => i += 4,
            2 => {
                let (len, n) = varint(&msg[i..])?;
                i += n;
                let end = i.checked_add(usize::try_from(len).ok()?)?;
                let v = msg.get(i..end)?;
                if key >> 3 == field {
                    out.push(v);
                }
                i = end;
            }
            _ => return None,
        }
        if i > msg.len() {
            return None;
        }
    }
    Some(out)
}

fn varint(b: &[u8]) -> Option<(u64, usize)> {
    let mut v = 0u64;
    for (k, byte) in b.iter().enumerate().take(10) {
        v |= u64::from(byte & 0x7f) << (7 * k);
        if byte & 0x80 == 0 {
            return Some((v, k + 1));
        }
    }
    None
}

/// Every value at `path` (field numbers, outermost first).
pub(crate) fn get<'a>(msg: &'a [u8], path: &[u64]) -> Vec<&'a [u8]> {
    let mut cur = vec![msg];
    for &f in path {
        cur = cur.into_iter().flat_map(|m| fields(m, f).unwrap_or_default()).collect();
    }
    cur
}

/// The first value at `path` as text.
pub(crate) fn text(msg: &[u8], path: &[u64]) -> Option<String> {
    get(msg, path).into_iter().find_map(|b| std::str::from_utf8(b).ok()).map(str::to_string)
}

#[cfg(test)]
pub(crate) mod enc {
    //! A writer for tests: build the shapes the reader is pinned against.
    pub fn ld(field: u64, bytes: &[u8]) -> Vec<u8> {
        let mut out = varint(field << 3 | 2);
        out.extend(varint(bytes.len() as u64));
        out.extend_from_slice(bytes);
        out
    }
    pub fn int(field: u64, v: u64) -> Vec<u8> {
        let mut out = varint(field << 3);
        out.extend(varint(v));
        out
    }
    fn varint(mut v: u64) -> Vec<u8> {
        let mut out = Vec::new();
        loop {
            let b = (v & 0x7f) as u8;
            v >>= 7;
            if v == 0 {
                out.push(b);
                return out;
            }
            out.push(b | 0x80);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::enc::*;
    use super::*;

    #[test]
    fn nested_fields_are_found_and_other_wire_types_skipped() {
        let inner = [int(1, 300), ld(2, b"hello"), ld(2, b"again")].concat();
        let msg = [int(1, 15), ld(20, &inner), ld(9, b"x")].concat();
        assert_eq!(get(&msg, &[20, 2]), vec![&b"hello"[..], &b"again"[..]]);
        assert_eq!(text(&msg, &[20, 2]).as_deref(), Some("hello"));
        assert!(get(&msg, &[21]).is_empty());
    }

    #[test]
    fn garbage_yields_nothing() {
        assert!(get(&[0x0a, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01], &[1]).is_empty());
        assert!(get(&[0x0a, 0x05, b'a'], &[1]).is_empty(), "a length past the end");
        assert!(get(&[0x0f], &[1]).is_empty(), "wire type 7 does not exist");
    }
}
