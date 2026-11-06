//! The only code in this crate that touches the network.

use std::io::Read;

use crate::BODY_MAX;
use crate::http::{
    HttpRequest, HttpResponse, HttpSend, Method, Offline, agent_config, auth_header, retry_after,
};

/// At most `cap` bytes; the rest of the stream is left unread.
pub fn read_capped(reader: impl Read, cap: usize) -> std::io::Result<Vec<u8>> {
    let mut body = Vec::new();
    reader.take(cap as u64).read_to_end(&mut body)?;
    Ok(body)
}

pub struct UreqHttp;

impl HttpSend for UreqHttp {
    fn send(&self, req: &HttpRequest) -> Result<HttpResponse, Offline> {
        let cfg = agent_config();
        let agent: ureq::Agent = ureq::Agent::config_builder()
            .timeout_global(Some(cfg.timeout))
            .max_redirects(cfg.max_redirects)
            .http_status_as_error(false)
            .user_agent(format!("xDev/{}", env!("CARGO_PKG_VERSION")))
            .build()
            .into();
        let header = auth_header(&req.auth);
        // Errors are dropped, never formatted: their text may carry the URL.
        let result = match req.method {
            Method::Get => {
                let mut call = agent.get(&req.url).header("Accept", "application/json");
                if let Some(h) = &header {
                    call = call.header("Authorization", h);
                }
                call.call()
            }
            Method::Post => {
                let mut call = agent
                    .post(&req.url)
                    .header("Accept", "application/json")
                    .header("Content-Type", "application/json");
                if let Some(h) = &header {
                    call = call.header("Authorization", h);
                }
                match &req.json {
                    Some(body) => call.send(body),
                    None => call.send_empty(),
                }
            }
        };
        let mut response = result.map_err(|_| Offline)?;
        let status = response.status().as_u16();
        let retry = response
            .headers()
            .get("retry-after")
            .and_then(|v| v.to_str().ok())
            .and_then(retry_after);
        let body =
            read_capped(response.body_mut().as_reader(), BODY_MAX + 1).map_err(|_| Offline)?;
        Ok(HttpResponse {
            status,
            retry_after: retry,
            body,
        })
    }
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;

    use super::*;

    #[test]
    fn read_capped_over_the_cap_returns_one_extra_byte() {
        let data = vec![7u8; BODY_MAX + 10];
        assert_eq!(
            read_capped(Cursor::new(&data), BODY_MAX + 1).unwrap().len(),
            BODY_MAX + 1
        );
        assert_eq!(read_capped(Cursor::new(&data[..5]), 10).unwrap().len(), 5);
    }
}
