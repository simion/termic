//! TLS for the broker: the per-spawn CA git trusts for the bound hosts, its
//! leaves, and the verified upstream connection.

use anyhow::{anyhow, Result};
use rustls::pki_types::{PrivateKeyDer, ServerName};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(8);
/// Idle limits on the upstream connection, so a stalling host cannot pin a
/// broker thread forever. Per read / write, not per request: a long clone
/// that keeps moving is fine.
const UPSTREAM_READ_TIMEOUT: Duration = Duration::from_secs(120);
const UPSTREAM_WRITE_TIMEOUT: Duration = Duration::from_secs(60);
const DAY: Duration = Duration::from_secs(86_400);

/// Validity for the CA and its leaves: from a day ago (clock skew) to 90
/// days out, instead of rcgen's 1975 to 4096. The key is memory-only and dies
/// with the spawn, so this only bounds a pem trusted somewhere it should not be.
fn validity(p: &mut rcgen::CertificateParams) {
    let days = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() / 86_400).unwrap_or(0) as i64;
    let (y, m, d) = civil_from_days(days);
    let today = rcgen::date_time_ymd(y, m, d);
    p.not_before = today - DAY;
    p.not_after = today + 90 * DAY;
}

/// Days since 1970-01-01 to (year, month, day), proleptic Gregorian
/// (Howard Hinnant's `civil_from_days`).
fn civil_from_days(z: i64) -> (i32, u8, u8) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u8;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u8;
    ((yoe + era * 400 + i64::from(m <= 2)) as i32, m, d)
}

/// aws-lc-rs, explicitly: the tree compiles rustls with both providers, so
/// the process default is ambiguous and `builder()` would refuse.
pub(crate) fn provider() -> Arc<rustls::crypto::CryptoProvider> {
    static P: OnceLock<Arc<rustls::crypto::CryptoProvider>> = OnceLock::new();
    P.get_or_init(|| Arc::new(rustls::crypto::aws_lc_rs::default_provider())).clone()
}

/// A per-spawn CA, name-constrained to the bound hosts so a leaked pem is
/// worthless for anything else. The key never leaves memory.
pub(crate) struct Ca {
    issuer: rcgen::Issuer<'static, rcgen::KeyPair>,
    pub(crate) pem: String,
    /// The CA cert, for tests that trust it directly.
    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) der: rustls::pki_types::CertificateDer<'static>,
    leaves: Mutex<HashMap<String, Arc<rustls::ServerConfig>>>,
}

impl Ca {
    pub(crate) fn mint(hosts: &[String]) -> Result<Ca> {
        let key = rcgen::KeyPair::generate()?;
        let mut p = rcgen::CertificateParams::new(Vec::<String>::new())?;
        p.is_ca = rcgen::IsCa::Ca(rcgen::BasicConstraints::Constrained(0));
        p.distinguished_name.push(rcgen::DnType::CommonName, "Termic credential broker (per agent session)");
        validity(&mut p);
        p.key_usages = vec![rcgen::KeyUsagePurpose::KeyCertSign, rcgen::KeyUsagePurpose::CrlSign];
        p.name_constraints = Some(rcgen::NameConstraints {
            permitted_subtrees: hosts.iter().map(|h| rcgen::GeneralSubtree::DnsName(h.clone())).collect(),
            excluded_subtrees: vec![],
        });
        let cert = p.self_signed(&key)?;
        Ok(Ca { pem: cert.pem(), der: cert.der().clone(), issuer: rcgen::Issuer::new(p, key), leaves: Mutex::default() })
    }

    /// Server config for `host`, minted once per host. ALPN is http/1.1
    /// only, so the broker never has to speak h2.
    pub(crate) fn leaf(&self, host: &str) -> Result<Arc<rustls::ServerConfig>> {
        if let Some(c) = self.leaves.lock().unwrap_or_else(|e| e.into_inner()).get(host) {
            return Ok(c.clone());
        }
        let key = rcgen::KeyPair::generate()?;
        let mut p = rcgen::CertificateParams::new(vec![host.to_string()])?;
        p.extended_key_usages = vec![rcgen::ExtendedKeyUsagePurpose::ServerAuth];
        validity(&mut p);
        let cert = p.signed_by(&key, &self.issuer)?;
        let mut cfg = rustls::ServerConfig::builder_with_provider(provider())
            .with_safe_default_protocol_versions()?
            .with_no_client_auth()
            .with_single_cert(vec![cert.der().clone()], PrivateKeyDer::Pkcs8(key.serialize_der().into()))?;
        cfg.alpn_protocols = vec![b"http/1.1".to_vec()];
        let cfg = Arc::new(cfg);
        self.leaves.lock().unwrap_or_else(|e| e.into_inner()).insert(host.to_string(), cfg.clone());
        Ok(cfg)
    }
}

pub(crate) trait Duplex: Read + Write + Send {}
impl<T: Read + Write + Send> Duplex for T {}

/// Dials a host the broker forwards to. Injectable so tests can stand up a
/// local TLS server instead of touching the network.
pub(crate) type Connector = Arc<dyn Fn(&str, u16) -> std::io::Result<Box<dyn Duplex>> + Send + Sync>;

/// Verified TLS to the real host, with the OS trust store.
pub(crate) fn system_connector() -> Connector {
    Arc::new(|host, port| {
        static CFG: OnceLock<Result<Arc<rustls::ClientConfig>, String>> = OnceLock::new();
        let cfg = CFG.get_or_init(|| {
            use rustls_platform_verifier::BuilderVerifierExt;
            let mut c = rustls::ClientConfig::builder_with_provider(provider())
                .with_safe_default_protocol_versions()
                .and_then(|b| b.with_platform_verifier())
                .map_err(|e| e.to_string())?
                .with_no_client_auth();
            c.alpn_protocols = vec![b"http/1.1".to_vec()];
            Ok(Arc::new(c))
        }).clone().map_err(std::io::Error::other)?;
        tls_connect(cfg, host, port)
    })
}

pub(crate) fn tls_connect(cfg: Arc<rustls::ClientConfig>, host: &str, port: u16) -> std::io::Result<Box<dyn Duplex>> {
    let addr = (host, port).to_socket_addrs()?.next()
        .ok_or_else(|| std::io::Error::other(format!("no addresses for {host}")))?;
    let tcp = TcpStream::connect_timeout(&addr, CONNECT_TIMEOUT)?;
    tcp.set_read_timeout(Some(UPSTREAM_READ_TIMEOUT))?;
    tcp.set_write_timeout(Some(UPSTREAM_WRITE_TIMEOUT))?;
    let name = ServerName::try_from(host.to_string()).map_err(|e| std::io::Error::other(e.to_string()))?;
    let conn = rustls::ClientConnection::new(cfg, name).map_err(std::io::Error::other)?;
    Ok(Box::new(rustls::StreamOwned::new(conn, tcp)))
}

/// Server side of a CONNECT tunnel for a bound host.
pub(crate) fn accept(ca: &Ca, host: &str, tcp: TcpStream) -> Result<rustls::StreamOwned<rustls::ServerConnection, TcpStream>> {
    let conn = rustls::ServerConnection::new(ca.leaf(host)?).map_err(|e| anyhow!("tls: {e}"))?;
    Ok(rustls::StreamOwned::new(conn, tcp))
}

#[cfg(test)]
mod tests {
    #[test]
    fn civil_dates() {
        assert_eq!(super::civil_from_days(0), (1970, 1, 1));
        assert_eq!(super::civil_from_days(20_749), (2026, 10, 23));
        assert_eq!(super::civil_from_days(11_016), (2000, 2, 29));
    }
}
