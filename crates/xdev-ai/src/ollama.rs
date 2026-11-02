use std::time::Duration;

use serde::Deserialize;

use crate::AiError;

pub struct Ollama {
    pub base: String,
}

impl Default for Ollama {
    fn default() -> Self {
        Self {
            base: std::env::var("XDEV_OLLAMA_URL")
                .unwrap_or_else(|_| "http://127.0.0.1:11434".to_owned()),
        }
    }
}

impl Ollama {
    fn agent(&self) -> ureq::Agent {
        ureq::Agent::config_builder()
            .timeout_connect(Some(Duration::from_secs(2)))
            .timeout_global(Some(Duration::from_secs(30)))
            .max_redirects(0)
            .proxy(None)
            .build()
            .into()
    }

    pub fn models(&self) -> Result<Vec<String>, AiError> {
        #[derive(Deserialize)]
        struct Model {
            name: String,
        }
        #[derive(Deserialize)]
        struct Tags {
            models: Vec<Model>,
        }
        let response = self
            .agent()
            .get(self.url("tags"))
            .call()
            .map_err(http_error)?;
        let tags: Tags = decode(response)?;
        Ok(tags.models.into_iter().map(|model| model.name).collect())
    }

    pub fn embed(&self, model: &str, input: &[&str]) -> Result<Vec<Vec<f32>>, AiError> {
        #[derive(Deserialize)]
        struct Embeddings {
            embeddings: Vec<Vec<f32>>,
        }
        let body = serde_json::to_string(&serde_json::json!({"model": model, "input": input}))
            .map_err(|_| AiError::BadOllamaResponse)?;
        let response = self
            .agent()
            .post(self.url("embed"))
            .header("Content-Type", "application/json")
            .send(body.as_bytes())
            .map_err(http_error)?;
        let embeddings: Embeddings = decode(response)?;
        if embeddings.embeddings.len() != input.len() {
            return Err(AiError::BadOllamaResponse);
        }
        Ok(embeddings.embeddings)
    }

    fn url(&self, endpoint: &str) -> String {
        format!("{}/api/{endpoint}", self.base.trim_end_matches('/'))
    }
}

fn http_error(error: ureq::Error) -> AiError {
    match error {
        ureq::Error::StatusCode(status) => AiError::OllamaError(status),
        _ => AiError::OllamaUnreachable,
    }
}

fn decode<T: serde::de::DeserializeOwned>(
    mut response: ureq::http::Response<ureq::Body>,
) -> Result<T, AiError> {
    let text = response
        .body_mut()
        .with_config()
        .limit(16 << 20)
        .read_to_string()
        .map_err(|_| AiError::BadOllamaResponse)?;
    serde_json::from_str(&text).map_err(|_| AiError::BadOllamaResponse)
}
