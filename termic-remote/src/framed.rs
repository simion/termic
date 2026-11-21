//! Length-prefixed frames over a byte pipe: `ssh host termic-server bridge`
//! and the bridge's unix socket to the daemon. A u32 big-endian length,
//! then that many bytes. SSH is the secure channel there, so frames are
//! plain JSON (not sealed again).

use std::io::{self, Read, Write};

use crate::{FrameRead, FrameWrite, MAX_FRAME};

pub struct FramedReader<R: Read + Send>(pub R);
pub struct FramedWriter<W: Write + Send>(pub W);

impl<R: Read + Send> FrameRead for FramedReader<R> {
    fn recv(&mut self) -> io::Result<Option<Vec<u8>>> {
        let mut len = [0u8; 4];
        match self.0.read_exact(&mut len) {
            Ok(()) => {}
            Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
            Err(e) => return Err(e),
        }
        let n = u32::from_be_bytes(len) as usize;
        if n > MAX_FRAME {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "frame too large"));
        }
        let mut buf = vec![0u8; n];
        self.0.read_exact(&mut buf)?;
        Ok(Some(buf))
    }
}

impl<W: Write + Send> FrameWrite for FramedWriter<W> {
    fn send(&mut self, frame: &[u8]) -> io::Result<()> {
        if frame.len() > MAX_FRAME {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "frame too large"));
        }
        self.0.write_all(&(frame.len() as u32).to_be_bytes())?;
        self.0.write_all(frame)?;
        self.0.flush()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frames_round_trip_and_end_cleanly() {
        let mut buf = Vec::new();
        {
            let mut w = FramedWriter(&mut buf);
            w.send(b"one").unwrap();
            w.send(b"").unwrap();
            w.send(&vec![7u8; 100_000]).unwrap();
        }
        let mut r = FramedReader(std::io::Cursor::new(buf));
        assert_eq!(r.recv().unwrap().unwrap(), b"one");
        assert_eq!(r.recv().unwrap().unwrap(), b"");
        assert_eq!(r.recv().unwrap().unwrap().len(), 100_000);
        assert_eq!(r.recv().unwrap(), None);
    }

    #[test]
    fn an_oversized_length_is_refused_before_allocating() {
        let mut r = FramedReader(std::io::Cursor::new(u32::MAX.to_be_bytes().to_vec()));
        assert!(r.recv().is_err());
    }

    #[test]
    fn a_truncated_frame_is_an_error_not_an_end() {
        let mut bytes = 10u32.to_be_bytes().to_vec();
        bytes.extend_from_slice(b"abc");
        let mut r = FramedReader(std::io::Cursor::new(bytes));
        assert!(r.recv().is_err());
    }
}
