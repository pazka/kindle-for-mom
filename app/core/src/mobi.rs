//! Title and author of MOBI / AZW / PRC files, so books with Amazon-style
//! names ("B00ABC_EBOK.azw") show a readable title. Reads only the first
//! record; never fails loudly (returns None on anything unexpected).

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct MobiMeta {
    pub title: Option<String>,
    pub author: Option<String>,
    /// Copy-protected (Amazon / Mobipocket DRM): readable only on the
    /// Kindle it was bought for.
    pub drm: bool,
}

fn be32(b: &[u8], at: usize) -> Option<u32> {
    b.get(at..at + 4)
        .map(|s| u32::from_be_bytes([s[0], s[1], s[2], s[3]]))
}

fn decode(bytes: &[u8], encoding: u32) -> String {
    let s = if encoding == 1252 {
        // Windows-1252: good enough as Latin-1 for titles
        bytes.iter().map(|&c| c as char).collect()
    } else {
        String::from_utf8_lossy(bytes).into_owned()
    };
    s.trim_matches(|c: char| c == '\0' || c.is_whitespace())
        .to_string()
}

/// Parse the PalmDB header + record 0 (MOBI header, EXTH).
pub fn parse(file: &[u8], record0: &[u8]) -> Option<MobiMeta> {
    let kind = file.get(60..68)?;
    if kind != b"BOOKMOBI" && kind != b"TEXtREAd" {
        return None;
    }
    let mut meta = MobiMeta {
        // record 0, offset 12: encryption type (0 = none, 1 = old Mobipocket, 2 = Mobipocket/Amazon)
        drm: record0
            .get(12..14)
            .is_some_and(|b| u16::from_be_bytes([b[0], b[1]]) != 0),
        ..MobiMeta::default()
    };
    // PalmDB name (31 chars max, often truncated with underscores)
    let pdb_name = decode(file.get(0..32)?.split(|&c| c == 0).next()?, 1252);
    if record0.get(16..20) != Some(b"MOBI") {
        if !pdb_name.is_empty() {
            meta.title = Some(pdb_name);
        }
        return Some(meta);
    }
    let header_len = be32(record0, 20)? as usize;
    let encoding = be32(record0, 28).unwrap_or(65001);
    let name_off = be32(record0, 16 + 0x44)? as usize;
    let name_len = be32(record0, 16 + 0x48)? as usize;
    if let Some(n) = record0.get(name_off..name_off.saturating_add(name_len)) {
        let t = decode(n, encoding);
        if !t.is_empty() {
            meta.title = Some(t);
        }
    }
    let exth_flags = be32(record0, 16 + 0x70).unwrap_or(0);
    if exth_flags & 0x40 != 0 {
        let e = 16 + header_len;
        if record0.get(e..e + 4) == Some(b"EXTH") {
            let count = be32(record0, e + 8)?;
            let mut p = e + 12;
            for _ in 0..count.min(1000) {
                let t = be32(record0, p)?;
                let l = be32(record0, p + 4)? as usize;
                if l < 8 {
                    break;
                }
                let data = record0.get(p + 8..p + l)?;
                match t {
                    100 if meta.author.is_none() => meta.author = Some(decode(data, encoding)),
                    503 => meta.title = Some(decode(data, encoding)),
                    _ => {}
                }
                p += l;
            }
        }
    }
    if meta.title.is_none() && !pdb_name.is_empty() {
        meta.title = Some(pdb_name);
    }
    meta.author = meta.author.filter(|a| !a.is_empty());
    Some(meta)
}

/// Read the metadata of a file on disk (reads at most a few hundred KB).
pub fn read_meta(path: &Path) -> Option<MobiMeta> {
    let mut f = File::open(path).ok()?;
    let mut head = vec![0u8; 78 + 16];
    f.read_exact(&mut head).ok()?;
    let r0 = be32(&head, 78)? as u64;
    let r1 = be32(&head, 86).map(|v| v as u64);
    let len = f.metadata().ok()?.len();
    let end = r1
        .filter(|&e| e > r0)
        .unwrap_or(len)
        .min(r0 + 256 * 1024)
        .min(len);
    if r0 >= end {
        return None;
    }
    let mut rec0 = vec![0u8; (end - r0) as usize];
    f.seek(SeekFrom::Start(r0)).ok()?;
    f.read_exact(&mut rec0).ok()?;
    parse(&head, &rec0)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// Minimal MOBI with a full name and an EXTH author/title.
    pub fn sample_mobi(title: &str, author: &str) -> Vec<u8> {
        sample_mobi_drm(title, author, false)
    }

    pub fn sample_mobi_drm(title: &str, author: &str, drm: bool) -> Vec<u8> {
        let mut rec0 = vec![0u8; 16];
        if drm {
            rec0[12..14].copy_from_slice(&2u16.to_be_bytes());
        }
        let mut mobi = vec![0u8; 0xe8];
        mobi[0..4].copy_from_slice(b"MOBI");
        mobi[4..8].copy_from_slice(&(0xe8u32).to_be_bytes());
        mobi[12..16].copy_from_slice(&65001u32.to_be_bytes());
        mobi[0x70..0x74].copy_from_slice(&0x40u32.to_be_bytes());
        let mut exth = b"EXTH".to_vec();
        let recs = [(100u32, author.as_bytes()), (503u32, title.as_bytes())];
        let body: Vec<u8> = recs
            .iter()
            .flat_map(|(t, d)| {
                let mut v = t.to_be_bytes().to_vec();
                v.extend(((d.len() + 8) as u32).to_be_bytes());
                v.extend(*d);
                v
            })
            .collect();
        exth.extend(((12 + body.len()) as u32).to_be_bytes());
        exth.extend((recs.len() as u32).to_be_bytes());
        exth.extend(body);
        rec0.extend(&mobi);
        rec0.extend(&exth);
        let name_off = rec0.len() as u32;
        rec0.extend(b"Short name");
        rec0[16 + 0x44..16 + 0x48].copy_from_slice(&name_off.to_be_bytes());
        rec0[16 + 0x48..16 + 0x4c].copy_from_slice(&10u32.to_be_bytes());
        let mut file = vec![0u8; 78 + 8 + 2];
        file[0..10].copy_from_slice(b"Short_name");
        file[60..68].copy_from_slice(b"BOOKMOBI");
        file[76..78].copy_from_slice(&1u16.to_be_bytes());
        let off = file.len() as u32;
        file[78..82].copy_from_slice(&off.to_be_bytes());
        file.extend(rec0);
        file
    }

    #[test]
    fn reads_exth_title_and_author() {
        let f = sample_mobi("Le Comte de Monte-Cristo", "Alexandre Dumas");
        let dir = std::env::temp_dir().join(format!("mobi-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("B00X_EBOK.azw");
        std::fs::write(&p, &f).unwrap();
        let m = read_meta(&p).unwrap();
        assert_eq!(m.title.as_deref(), Some("Le Comte de Monte-Cristo"));
        assert_eq!(m.author.as_deref(), Some("Alexandre Dumas"));
        assert!(!m.drm);
        std::fs::write(&p, sample_mobi_drm("Acheté", "Amazon", true)).unwrap();
        assert!(read_meta(&p).unwrap().drm, "Amazon DRM detected");
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn garbage_is_none() {
        assert!(parse(&[0u8; 100], &[0u8; 10]).is_none());
    }
}
